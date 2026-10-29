import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clampPct, formatReset } from "../format"
import type { QuotaWindow } from "./types"

export type AlibabaOptions = {
  enabled?: boolean
  blPath?: string
  region?: string
  site?: string
}

const ERROR = "Alibaba usage unavailable — run bl login"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function parseAlibaba(payload: unknown, now = Date.now()): QuotaWindow[] {
  if (!isObject(payload)) return []
  const percentage = payload.per1MonthPercentage
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return []
  const reset = payload.per1MonthResetTime
  if (typeof reset !== "number" || !Number.isFinite(reset)) return []

  const used = clampPct(percentage * 100)
  return [
    {
      label: "Monthly",
      usedPct: used,
      remainingPct: clampPct(100 - used),
      resetLabel: formatReset(reset, now),
    },
  ]
}

const probe = (): Promise<boolean> =>
  new Promise((resolve) => {
    execFile("bl", ["--version"], { timeout: 3_000 }, (error) => resolve(!error))
  })

const SYSTEM_BL_PATHS = ["/opt/homebrew/bin/bl", "/usr/local/bin/bl"]

export async function resolveBl(
  options: AlibabaOptions,
  home = process.env.HOME || homedir(),
  systemPaths = SYSTEM_BL_PATHS,
): Promise<string | undefined> {
  if (options.blPath && existsSync(options.blPath)) return options.blPath
  if (await probe()) return "bl"

  const known = [
    join(home, ".npm-global", "bin", "bl"),
    join(home, ".local", "bin", "bl"),
    ...systemPaths,
  ]
  return known.find((path) => existsSync(path))
}

export async function fetchAlibaba(
  blPath: string,
  options: AlibabaOptions,
  signal: AbortSignal,
  now = Date.now(),
): Promise<QuotaWindow[] | { error: string }> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      blPath,
      [
        "usage",
        "token-plan",
        "--console-region",
        options.region ?? "ap-southeast-1",
        "--console-site",
        options.site ?? "international",
        "--output",
        "json",
      ],
      { timeout: 20_000, maxBuffer: 1_048_576, signal },
      (error, output) => (error ? reject(error) : resolve(output)),
    )
  }).catch(() => "")

  try {
    const windows = parseAlibaba(JSON.parse(stdout), now)
    return windows.length > 0 ? windows : { error: ERROR }
  } catch {
    return { error: ERROR }
  }
}

export { ERROR as ALIBABA_ERROR }