import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clampPct, formatReset } from "../format"
import type { QuotaWindow } from "./types"

export type KimiCredentials = { key: string }

const USAGES_URL = "https://api.kimi.ai/coding/v1/usages"

type Detail = {
  limit?: string | number
  remaining?: string | number
  used?: string | number
  resetTime?: string
}

type Payload = {
  limits?: Array<{ window?: { duration?: number }; detail?: Detail }>
  usages?: {
    limit_5h?: { used_ratio?: number | null; reset_time?: string }
    limit_month_total?: { used_ratio?: number | null; reset_time?: string }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const resetAt = (iso: unknown): number =>
  typeof iso === "string" ? new Date(iso).getTime() : Number.NaN

const window = (
  label: string,
  usedPct: number,
  reset: number,
  now: number,
): QuotaWindow | undefined => {
  if (!Number.isFinite(reset)) return undefined
  const used = clampPct(usedPct)
  return {
    label,
    usedPct: used,
    remainingPct: clampPct(100 - used),
    resetLabel: formatReset(reset, now),
  }
}

// The endpoint sends numeric fields as strings. A null or empty value means
// "absent", not zero, so it must fall through to the next source.
const numeric = (value: unknown): number =>
  value === null || value === undefined || value === "" ? Number.NaN : Number(value)

const derivedPct = (detail?: Detail): number => {
  const limit = numeric(detail?.limit)
  if (!Number.isFinite(limit) || limit <= 0) return 0
  const used = numeric(detail?.used)
  if (Number.isFinite(used)) return (used / limit) * 100
  const remaining = numeric(detail?.remaining)
  if (Number.isFinite(remaining)) return ((limit - remaining) / limit) * 100
  return 0
}

export function parseKimi(payload: unknown, now = Date.now()): QuotaWindow[] {
  if (!isObject(payload)) return []
  const data = payload as Payload
  const usages = isObject(data.usages) ? data.usages : undefined
  const fiveDetail = data.limits?.find((item) => item?.window?.duration === 300)?.detail

  const windows: QuotaWindow[] = []

  const fiveRatio = usages?.limit_5h?.used_ratio
  const fiveReset = fiveDetail?.resetTime ?? usages?.limit_5h?.reset_time
  const five = window(
    "5h",
    finite(fiveRatio) ? fiveRatio * 100 : derivedPct(fiveDetail),
    resetAt(fiveReset),
    now,
  )
  if (five) windows.push(five)

  const monthRatio = usages?.limit_month_total?.used_ratio
  const monthReset = usages?.limit_month_total?.reset_time
  if (finite(monthRatio)) {
    const month = window("Monthly", monthRatio * 100, resetAt(monthReset), now)
    if (month) windows.push(month)
  }

  return windows
}

export function detectKimi(
  dataHome = process.env.XDG_DATA_HOME || undefined,
  home = process.env.HOME || homedir(),
): Promise<KimiCredentials | undefined> {
  const paths = [
    dataHome ? join(dataHome, "opencode", "auth.json") : undefined,
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".config", "opencode", "auth.json"),
  ].filter((path): path is string => Boolean(path))

  for (const path of paths) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (!isObject(parsed)) continue
      const entry = parsed["kimi-code-plan-global"]
      if (!isObject(entry)) continue
      const key = entry.key
      if (typeof key === "string" && key.trim() !== "") return Promise.resolve({ key })
    } catch {
      // Missing or unreadable file: try the next location.
    }
  }
  return Promise.resolve(undefined)
}

export async function fetchKimi(
  credentials: KimiCredentials,
  signal: AbortSignal,
  now = Date.now(),
): Promise<QuotaWindow[] | { error: string }> {
  const timeout = AbortSignal.timeout(10_000)
  const combined =
    typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetch(USAGES_URL, {
      headers: { Authorization: `Bearer ${credentials.key}` },
      signal: combined,
    })
    if (response.status === 401 || response.status === 403) {
      return { error: "Kimi key rejected — sign in again" }
    }
    if (!response.ok) return { error: "Kimi usage unavailable" }
    const windows = parseKimi(await response.json(), now)
    return windows.length > 0 ? windows : { error: "Kimi usage unavailable" }
  } catch {
    return { error: "Kimi usage unavailable" }
  }
}