import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { detectKimi, fetchKimi, parseKimi, type KimiCredentials } from "./kimi"

const NOW = new Date(2026, 9, 29, 12, 0, 0, 0).getTime()
const RESET = new Date(NOW + 90 * 60_000).toISOString()
const MONTH_RESET = new Date(2026, 10, 1, 0, 0, 0, 0).toISOString()

const detailOnly = {
  limits: [{ window: { duration: 300 }, detail: { limit: "100", remaining: "70", resetTime: RESET } }],
}

const ratioOnly = {
  usages: { limit_5h: { used_ratio: 0.25, reset_time: RESET } },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("parseKimi", () => {
  test("derives usage from limit and remaining", () => {
    const windows = parseKimi(detailOnly, NOW)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ label: "5h", usedPct: 30, remainingPct: 70 })
  })

  test("prefers the ratio when both shapes are present", () => {
    const windows = parseKimi(
      {
        limits: [{ window: { duration: 300 }, detail: { limit: "100", remaining: "70", resetTime: RESET } }],
        usages: { limit_5h: { used_ratio: 0.25, reset_time: RESET } },
      },
      NOW,
    )
    expect(windows[0].usedPct).toBe(25)
  })

  test("falls back to the detail when the ratio is null", () => {
    const windows = parseKimi(
      {
        limits: [{ window: { duration: 300 }, detail: { limit: "100", remaining: "70", resetTime: RESET } }],
        usages: { limit_5h: { used_ratio: null, reset_time: RESET } },
      },
      NOW,
    )
    expect(windows[0].usedPct).toBe(30)
  })

  test("parses the ratio-only shape", () => {
    const windows = parseKimi(ratioOnly, NOW)
    expect(windows[0]).toMatchObject({ label: "5h", usedPct: 25 })
  })

  test("parses the monthly window and ignores the code bucket", () => {
    const windows = parseKimi(
      {
        usages: {
          limit_month_total: { used_ratio: 0.4, reset_time: MONTH_RESET },
          limit_month_code: { used_ratio: 0.9, reset_time: MONTH_RESET },
        },
      },
      NOW,
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ label: "Monthly", usedPct: 40 })
    expect(windows[0].resetLabel).toBe("1 Nov")
  })

  test("skips a window without a reset", () => {
    expect(parseKimi({ usages: { limit_5h: { used_ratio: 0.25 } } }, NOW)).toEqual([])
  })

  test("clamps out-of-range usage", () => {
    const high = parseKimi(
      { limits: [{ window: { duration: 300 }, detail: { limit: "100", remaining: "-50", resetTime: RESET } }] },
      NOW,
    )
    expect(high[0].usedPct).toBe(100)
    expect(high[0].remainingPct).toBe(0)

    const low = parseKimi(
      { limits: [{ window: { duration: 300 }, detail: { limit: "100", remaining: "150", resetTime: RESET } }] },
      NOW,
    )
    expect(low[0].usedPct).toBe(0)
    expect(low[0].remainingPct).toBe(100)
  })

  test("falls back to remaining when used is null", () => {
    const windows = parseKimi(
      {
        limits: [
          {
            window: { duration: 300 },
            detail: {
              limit: "100",
              used: null as unknown as string,
              remaining: "70",
              resetTime: RESET,
            },
          },
        ],
      },
      NOW,
    )
    expect(windows[0]).toMatchObject({ usedPct: 30 })
  })

  test("returns no windows for empty payloads", () => {
    expect(parseKimi(null, NOW)).toEqual([])
    expect(parseKimi({}, NOW)).toEqual([])
  })
})

describe("detectKimi", () => {
  const makeHome = (content?: string) => {
    const home = mkdtempSync(join(tmpdir(), "usage-kimi-"))
    if (content !== undefined) {
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
      writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), content)
    }
    return home
  }

  test("returns the stored key", async () => {
    const home = makeHome(JSON.stringify({ "kimi-code-plan-global": { key: "secret-key" } }))
    await expect(detectKimi(undefined, home)).resolves.toEqual({ key: "secret-key" })
  })

  test("returns undefined for a missing, invalid, or empty auth file", async () => {
    await expect(detectKimi(undefined, makeHome())).resolves.toBeUndefined()
    await expect(detectKimi(undefined, makeHome("not json"))).resolves.toBeUndefined()
    await expect(detectKimi(undefined, makeHome("[]"))).resolves.toBeUndefined()
    await expect(
      detectKimi(undefined, makeHome(JSON.stringify({ "kimi-code-plan-global": { key: "" } }))),
    ).resolves.toBeUndefined()
  })

  test("prefers the XDG data home", async () => {
    const home = makeHome(JSON.stringify({ "kimi-code-plan-global": { key: "home-key" } }))
    const dataHome = mkdtempSync(join(tmpdir(), "usage-kimi-xdg-"))
    mkdirSync(join(dataHome, "opencode"), { recursive: true })
    writeFileSync(
      join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ "kimi-code-plan-global": { key: "xdg-key" } }),
    )
    await expect(detectKimi(dataHome, home)).resolves.toEqual({ key: "xdg-key" })
  })

  test("reads XDG_DATA_HOME from the environment by default", async () => {
    const home = makeHome(JSON.stringify({ "kimi-code-plan-global": { key: "home-key" } }))
    const dataHome = mkdtempSync(join(tmpdir(), "usage-kimi-env-"))
    mkdirSync(join(dataHome, "opencode"), { recursive: true })
    writeFileSync(
      join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ "kimi-code-plan-global": { key: "env-key" } }),
    )
    vi.stubEnv("XDG_DATA_HOME", dataHome)
    vi.stubEnv("HOME", home)
    await expect(detectKimi()).resolves.toEqual({ key: "env-key" })
  })
})

describe("fetchKimi", () => {
  const credentials: KimiCredentials = { key: "secret-key" }

  test("returns parsed windows on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ratioOnly), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const windows = await fetchKimi(credentials, new AbortController().signal, NOW)
    expect(windows).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.kimi.ai/coding/v1/usages")
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer secret-key" })
  })

  test("maps rejected credentials without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })))
    const result = await fetchKimi(credentials, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "Kimi key rejected — sign in again" })
    expect(JSON.stringify(result)).not.toContain("secret-key")
  })

  test("maps a successful response without usable windows to a generic error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })))
    await expect(fetchKimi(credentials, new AbortController().signal, NOW)).resolves.toEqual({
      error: "Kimi usage unavailable",
    })
  })

  test("maps an aborted request to a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")),
    )
    await expect(fetchKimi(credentials, new AbortController().signal, NOW)).resolves.toEqual({
      error: "Kimi usage unavailable",
    })
  })

  test("maps a non-JSON success body to a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>maintenance</html>", { status: 200 })),
    )
    await expect(fetchKimi(credentials, new AbortController().signal, NOW)).resolves.toEqual({
      error: "Kimi usage unavailable",
    })
  })

  test("maps other failures to a generic error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })))
    await expect(fetchKimi(credentials, new AbortController().signal, NOW)).resolves.toEqual({
      error: "Kimi usage unavailable",
    })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network secret-key")))
    const result = await fetchKimi(credentials, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "Kimi usage unavailable" })
    expect(JSON.stringify(result)).not.toContain("secret-key")
  })
})