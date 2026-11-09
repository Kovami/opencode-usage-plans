import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clampPct, formatReset } from "../format"
import type { QuotaWindow } from "./types"

export type OpenaiCredentialSource =
  | { kind: "codex"; path: string }
  | { kind: "opencode"; path: string }

export type OpenaiCredentials = {
  accessToken: string
  refreshToken?: string
  source?: OpenaiCredentialSource
}

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
// Same public client id the Codex CLI and OpenCode use for the OAuth flow.
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
// Refresh shortly before the access token actually expires.
const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The endpoint sends numeric fields as strings. A null or empty value means
// "absent", not zero, so it must be treated as unusable.
const numeric = (value: unknown): number =>
  value === null || value === undefined || value === "" ? Number.NaN : Number(value)

const windowLabel = (seconds: unknown): string => {
  const value = numeric(seconds)
  if (!Number.isFinite(value)) return "Window"
  if (value === 18000) return "5h"
  if (value === 86400) return "Daily"
  if (value === 604800) return "Weekly"
  return `${Math.round(value / 3600)}h`
}

const window = (value: unknown, now: number): QuotaWindow | undefined => {
  if (!isObject(value)) return undefined
  const used = numeric(value.used_percent)
  const reset = numeric(value.reset_at)
  if (!Number.isFinite(used) || !Number.isFinite(reset)) return undefined
  // reset_at is a unix timestamp in seconds.
  return {
    label: windowLabel(value.limit_window_seconds),
    usedPct: clampPct(used),
    remainingPct: clampPct(100 - used),
    resetLabel: formatReset(reset * 1000, now),
  }
}

export function parseOpenai(payload: unknown, now = Date.now()): QuotaWindow[] {
  if (!isObject(payload)) return []
  const rateLimit = payload.rate_limit
  if (!isObject(rateLimit)) return []

  const windows: QuotaWindow[] = []
  for (const key of ["primary_window", "secondary_window"]) {
    const parsed = window(rateLimit[key], now)
    if (parsed) windows.push(parsed)
  }
  return windows
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // Missing or unreadable file: try the next location.
    return undefined
  }
}

const token = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

export async function detectOpenai(
  home = process.env.HOME || homedir(),
  dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share"),
): Promise<OpenaiCredentials | undefined> {
  const codexPath = join(home, ".codex", "auth.json")
  const codex = readJson(codexPath)
  if (isObject(codex) && isObject(codex.tokens)) {
    const accessToken = token(codex.tokens.access_token)
    if (accessToken) {
      return {
        accessToken,
        refreshToken: token(codex.tokens.refresh_token),
        source: { kind: "codex", path: codexPath },
      }
    }
  }

  const paths = [
    join(dataHome, "opencode", "auth.json"),
    join(home, ".config", "opencode", "auth.json"),
  ]
  for (const path of paths) {
    const parsed = readJson(path)
    if (!isObject(parsed)) continue
    const entry = parsed["openai-codex"]
    if (!isObject(entry)) continue
    const accessToken = token(entry.access) ?? token(entry.key)
    if (accessToken) {
      return {
        accessToken,
        refreshToken: token(entry.refresh),
        source: { kind: "opencode", path },
      }
    }
  }

  return undefined
}

// The access token is a JWT; its exp claim (unix seconds) tells us whether it
// still works. Non-JWT tokens (plain API keys) carry no readable expiry.
const jwtExpiresAt = (accessToken: string): number | undefined => {
  const payload = accessToken.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!isObject(claims)) return undefined
    const exp = numeric(claims.exp)
    if (!Number.isFinite(exp)) return undefined
    return exp * 1000
  } catch {
    return undefined
  }
}

const isExpired = (accessToken: string, now: number): boolean => {
  const expiresAt = jwtExpiresAt(accessToken)
  return expiresAt !== undefined && expiresAt - now <= REFRESH_MARGIN_MS
}

const canRefresh = (credentials: OpenaiCredentials): boolean =>
  credentials.refreshToken !== undefined && credentials.source !== undefined

type RefreshedTokens = {
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  expiresAt?: number
}

const refreshTokens = async (
  refreshToken: string,
  signal: AbortSignal,
  now: number,
): Promise<RefreshedTokens | undefined> => {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email offline_access",
      }),
      signal,
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    if (!isObject(payload)) return undefined
    const accessToken = token(payload.access_token)
    if (!accessToken) return undefined
    const expiresIn = numeric(payload.expires_in)
    return {
      accessToken,
      refreshToken: token(payload.refresh_token),
      idToken: token(payload.id_token),
      accountId: token(payload.account_id),
      expiresAt: Number.isFinite(expiresIn) ? now + expiresIn * 1000 : undefined,
    }
  } catch {
    return undefined
  }
}

// OpenAI rotates the refresh token on every exchange, so the new pair must be
// written back to the file it came from, or the stored one goes stale.
// Write failures are non-fatal: the fresh access token still works now.
const persist = (path: string, mutate: (json: Record<string, unknown>) => boolean): boolean => {
  const parsed = readJson(path)
  if (!isObject(parsed) || !mutate(parsed)) return false
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
    return true
  } catch {
    return false
  }
}

const persistTokens = (source: OpenaiCredentialSource, tokens: RefreshedTokens, now: number): void => {
  persist(source.path, (json) => {
    if (source.kind === "codex") {
      if (!isObject(json.tokens)) return false
      json.tokens.access_token = tokens.accessToken
      if (tokens.refreshToken) json.tokens.refresh_token = tokens.refreshToken
      if (tokens.idToken) json.tokens.id_token = tokens.idToken
      if (tokens.accountId) json.tokens.account_id = tokens.accountId
      json.last_refresh = new Date(now).toISOString()
      return true
    }
    const entry = json["openai-codex"]
    if (!isObject(entry)) return false
    entry.access = tokens.accessToken
    if (tokens.refreshToken) entry.refresh = tokens.refreshToken
    // Keep the expiry format the file already uses: epoch ms or ISO string.
    if (tokens.expiresAt !== undefined) {
      if (typeof entry.expires === "number") entry.expires = tokens.expiresAt
      else if (typeof entry.expires === "string") {
        entry.expires = new Date(tokens.expiresAt).toISOString()
      }
    }
    return true
  })
}

const refreshAndPersist = async (
  credentials: OpenaiCredentials,
  signal: AbortSignal,
  now: number,
): Promise<string | undefined> => {
  if (!canRefresh(credentials)) return undefined
  const refreshed = await refreshTokens(credentials.refreshToken as string, signal, now)
  if (!refreshed) return undefined
  persistTokens(credentials.source as OpenaiCredentialSource, refreshed, now)
  return refreshed.accessToken
}

const withTimeout = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal !== undefined && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout])
    : timeout
}

const requestUsage = (accessToken: string, signal: AbortSignal): Promise<Response> =>
  fetch(USAGE_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal })

export async function fetchOpenai(
  credentials: OpenaiCredentials,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<QuotaWindow[] | { error: string }> {
  try {
    let accessToken = credentials.accessToken
    // The background refresh cycle must not wait for the model to be used:
    // exchange the refresh token ourselves before the access token expires.
    if (canRefresh(credentials) && isExpired(accessToken, now)) {
      const refreshed = await refreshAndPersist(credentials, withTimeout(signal), now)
      if (refreshed) accessToken = refreshed
    }

    let response = await requestUsage(accessToken, withTimeout(signal))
    // The token may have expired or been revoked since we last checked:
    // refresh once and retry before reporting a sign-in error.
    if ((response.status === 401 || response.status === 403) && canRefresh(credentials)) {
      const refreshed = await refreshAndPersist(credentials, withTimeout(signal), now)
      if (refreshed) {
        accessToken = refreshed
        response = await requestUsage(accessToken, withTimeout(signal))
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { error: "Codex sign-in expired — run codex login" }
    }
    if (!response.ok) return { error: "OpenAI usage unavailable" }
    return parseOpenai(await response.json(), now)
  } catch {
    return { error: "OpenAI usage unavailable" }
  }
}
