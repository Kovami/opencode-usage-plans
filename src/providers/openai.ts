import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clampPct, formatReset } from "../format"
import type { QuotaWindow } from "./types"

export type OpenaiCredentials = { accessToken: string }

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

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
  const codex = readJson(join(home, ".codex", "auth.json"))
  if (isObject(codex) && isObject(codex.tokens)) {
    const accessToken = token(codex.tokens.access_token)
    if (accessToken) return { accessToken }
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
    if (accessToken) return { accessToken }
  }

  return undefined
}

export async function fetchOpenai(
  credentials: OpenaiCredentials,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<QuotaWindow[] | { error: string }> {
  const timeout = AbortSignal.timeout(10_000)
  const combined =
    signal !== undefined && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : timeout
  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: combined,
    })
    if (response.status === 401 || response.status === 403) {
      return { error: "Codex sign-in expired — run codex login" }
    }
    if (!response.ok) return { error: "OpenAI usage unavailable" }
    return parseOpenai(await response.json(), now)
  } catch {
    return { error: "OpenAI usage unavailable" }
  }
}