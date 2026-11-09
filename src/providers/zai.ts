import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clampPct, formatReset } from "../format"
import type { QuotaWindow } from "./types"

export type ZaiCredentials = { key: string }

export type ZaiOptions = {
  enabled?: boolean
  baseUrl?: string
}

// Usage API, not the model endpoint (/api/coding/paas/v4).
// China accounts use https://open.bigmodel.cn instead of https://api.z.ai.
export const ZAI_BASE_URL = "https://api.z.ai"

const LIMIT_PATH = "/api/monitor/usage/quota/limit"

// unit 3 = rolling 5-hour token quota, 6 = weekly token quota,
// 5 = MCP/tools time quota.
const UNIT_LABELS: Record<number, string> = { 3: "5h", 6: "Weekly", 5: "MCP" }

const AUTH_ENTRIES = ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The endpoint may send numeric fields as strings. A null or empty value means
// "absent", not zero.
const numeric = (value: unknown): number =>
  value === null || value === undefined || value === "" ? Number.NaN : Number(value)

export function parseZai(payload: unknown, now = Date.now()): QuotaWindow[] {
  if (!isObject(payload)) return []
  if (payload.code !== undefined && numeric(payload.code) !== 200) return []
  const data = isObject(payload.data) ? payload.data : undefined
  const limits = Array.isArray(data?.limits) ? data.limits : []

  const windows: QuotaWindow[] = []
  for (const item of limits) {
    if (!isObject(item)) continue
    const usedPct = numeric(item.percentage)
    const reset = numeric(item.nextResetTime)
    if (!Number.isFinite(usedPct) || !Number.isFinite(reset)) continue
    const unit = numeric(item.unit)
    const label = (Number.isFinite(unit) ? UNIT_LABELS[unit] : undefined) ?? "Window"
    const used = clampPct(usedPct)
    windows.push({
      label,
      usedPct: used,
      remainingPct: clampPct(100 - used),
      resetLabel: formatReset(reset, now),
    })
  }
  return windows
}

export function detectZai(
  env: NodeJS.ProcessEnv = process.env,
  dataHome = env.XDG_DATA_HOME || undefined,
  home = env.HOME || homedir(),
): Promise<ZaiCredentials | undefined> {
  const envKey = env.ZAI_API_KEY
  if (typeof envKey === "string" && envKey.trim() !== "")
    return Promise.resolve({ key: envKey })

  const paths = [
    dataHome ? join(dataHome, "opencode", "auth.json") : undefined,
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".config", "opencode", "auth.json"),
  ].filter((path): path is string => Boolean(path))

  for (const path of paths) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (!isObject(parsed)) continue
      for (const entryId of AUTH_ENTRIES) {
        const entry = parsed[entryId]
        if (!isObject(entry)) continue
        const key = entry.key
        if (typeof key === "string" && key.trim() !== "") return Promise.resolve({ key })
      }
    } catch {
      // Missing or unreadable file: try the next location.
    }
  }
  return Promise.resolve(undefined)
}

export async function fetchZai(
  credentials: ZaiCredentials,
  signal: AbortSignal,
  baseUrl = ZAI_BASE_URL,
  now = Date.now(),
): Promise<QuotaWindow[] | { error: string }> {
  const timeout = AbortSignal.timeout(10_000)
  const combined =
    typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}${LIMIT_PATH}`, {
      headers: { Authorization: `Bearer ${credentials.key}` },
      signal: combined,
    })
    if (response.status === 401 || response.status === 403) {
      return { error: "Z.AI key rejected — check ZAI_API_KEY" }
    }
    if (!response.ok) return { error: "Z.AI usage unavailable" }
    const windows = parseZai(await response.json(), now)
    return windows.length > 0 ? windows : { error: "Z.AI usage unavailable" }
  } catch {
    return { error: "Z.AI usage unavailable" }
  }
}
