import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { fetchAlibaba, parseAlibaba, resolveBl } from "./alibaba"

const state = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  mode: "fail" as "fail" | "ok" | "version",
  stdout: "",
}))

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout?: string) => void,
  ) => {
    state.calls.push({ file, args, options })
    if (state.mode === "version" && args[0] === "--version") {
      callback(null, "bl 1.0.0")
      return
    }
    if (state.mode === "ok") {
      callback(null, state.stdout)
      return
    }
    callback(new Error("spawn /secret/location/bl ENOENT"))
  },
}))

const NOW = new Date(2026, 9, 29, 12, 0, 0, 0).getTime()
const RESET = new Date(2026, 10, 1, 0, 0, 0, 0).getTime()

beforeEach(() => {
  state.calls = []
  state.mode = "fail"
  state.stdout = ""
})

describe("parseAlibaba", () => {
  test("parses a monthly percentage and reset time", () => {
    const windows = parseAlibaba({ per1MonthPercentage: 0.42, per1MonthResetTime: RESET }, NOW)
    expect(windows).toEqual([
      { label: "Monthly", usedPct: 42, remainingPct: 58, resetLabel: "1 Nov" },
    ])
  })

  test("treats zero usage as valid", () => {
    const windows = parseAlibaba({ per1MonthPercentage: 0, per1MonthResetTime: RESET }, NOW)
    expect(windows[0]).toMatchObject({ usedPct: 0, remainingPct: 100 })
  })

  test("rejects missing or non-numeric percentages", () => {
    expect(parseAlibaba({ per1MonthResetTime: RESET }, NOW)).toEqual([])
    expect(parseAlibaba({ per1MonthPercentage: "0.4", per1MonthResetTime: RESET }, NOW)).toEqual([])
    expect(parseAlibaba({ per1MonthPercentage: null, per1MonthResetTime: RESET }, NOW)).toEqual([])
    expect(parseAlibaba({ per1MonthPercentage: Number.NaN, per1MonthResetTime: RESET }, NOW)).toEqual(
      [],
    )
    expect(parseAlibaba(null, NOW)).toEqual([])
  })

  test("skips a window without a reset", () => {
    expect(parseAlibaba({ per1MonthPercentage: 0.4 }, NOW)).toEqual([])
  })

  test("clamps out-of-range percentages", () => {
    const high = parseAlibaba({ per1MonthPercentage: 1.5, per1MonthResetTime: RESET }, NOW)
    expect(high[0]).toMatchObject({ usedPct: 100, remainingPct: 0 })
    const low = parseAlibaba({ per1MonthPercentage: -0.2, per1MonthResetTime: RESET }, NOW)
    expect(low[0]).toMatchObject({ usedPct: 0, remainingPct: 100 })
  })
})

describe("resolveBl", () => {
  test("returns an explicit path without spawning", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-alibaba-"))
    const blPath = join(home, "custom-bl")
    writeFileSync(blPath, "")
    await expect(resolveBl({ blPath }, home)).resolves.toBe(blPath)
    expect(state.calls).toHaveLength(0)
  })

  test("falls back to a known path when the probe fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-alibaba-"))
    mkdirSync(join(home, ".local", "bin"), { recursive: true })
    const known = join(home, ".local", "bin", "bl")
    writeFileSync(known, "")
    await expect(resolveBl({ blPath: join(home, "missing") }, home)).resolves.toBe(known)
    expect(state.calls.map((call) => call.args)).toEqual([["--version"]])
  })

  test("returns bl when the probe succeeds", async () => {
    state.mode = "version"
    await expect(resolveBl({}, mkdtempSync(join(tmpdir(), "usage-alibaba-")))).resolves.toBe("bl")
  })

  test("returns undefined when nothing is installed", async () => {
    await expect(resolveBl({}, mkdtempSync(join(tmpdir(), "usage-alibaba-")))).resolves.toBeUndefined()
  })
})

describe("fetchAlibaba", () => {
  test("runs the token-plan command and parses its output", async () => {
    state.mode = "ok"
    state.stdout = JSON.stringify({ per1MonthPercentage: 0.42, per1MonthResetTime: RESET })
    const windows = await fetchAlibaba("/bin/bl", {}, new AbortController().signal, NOW)
    expect(windows).toEqual([
      { label: "Monthly", usedPct: 42, remainingPct: 58, resetLabel: "1 Nov" },
    ])
    const [call] = state.calls
    expect(call.file).toBe("/bin/bl")
    expect(call.args).toEqual([
      "usage",
      "token-plan",
      "--console-region",
      "ap-southeast-1",
      "--console-site",
      "international",
      "--output",
      "json",
    ])
    expect(call.options).toMatchObject({ timeout: 20_000, maxBuffer: 1_048_576 })
  })

  test("passes custom region and site", async () => {
    state.mode = "ok"
    state.stdout = JSON.stringify({ per1MonthPercentage: 0.1, per1MonthResetTime: RESET })
    await fetchAlibaba("/bin/bl", { region: "cn-hangzhou", site: "china" }, new AbortController().signal, NOW)
    expect(state.calls[0].args).toContain("cn-hangzhou")
    expect(state.calls[0].args).toContain("china")
  })

  test("maps failures to an actionable error without leaking paths", async () => {
    const result = await fetchAlibaba("/bin/bl", {}, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "Alibaba usage unavailable — run bl login" })
    expect(JSON.stringify(result)).not.toContain("/secret")
  })

  test("maps a successful call without quota fields to the same error", async () => {
    state.mode = "ok"
    state.stdout = JSON.stringify({ code: "not_logged_in" })
    await expect(fetchAlibaba("/bin/bl", {}, new AbortController().signal, NOW)).resolves.toEqual({
      error: "Alibaba usage unavailable — run bl login",
    })
  })

  test("maps invalid JSON to the same error", async () => {
    state.mode = "ok"
    state.stdout = "not json"
    await expect(fetchAlibaba("/bin/bl", {}, new AbortController().signal, NOW)).resolves.toEqual({
      error: "Alibaba usage unavailable — run bl login",
    })
  })
})