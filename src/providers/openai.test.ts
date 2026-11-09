import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { detectOpenai, fetchOpenai, parseOpenai, type OpenaiCredentials } from "./openai"

const NOW = new Date(2026, 9, 29, 12, 0, 0, 0).getTime()
const FIVE_HOUR_SECONDS = 18000
const WEEK_SECONDS = 604800

const unix = (date: Date): number => Math.floor(date.getTime() / 1000)

const fiveHourResetAt = unix(new Date(NOW + 90 * 60_000))
const weeklyResetAt = unix(new Date(2026, 10, 5, 12, 0, 0, 0))

const realPayload = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 2,
      limit_window_seconds: FIVE_HOUR_SECONDS,
      reset_after_seconds: 12345,
      reset_at: fiveHourResetAt,
    },
    secondary_window: {
      used_percent: 0,
      limit_window_seconds: WEEK_SECONDS,
      reset_after_seconds: 600000,
      reset_at: weeklyResetAt,
    },
  },
  credits: { has_credits: false, unlimited: false },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("parseOpenai", () => {
  test("parses both rate-limit windows from the real payload shape", () => {
    const windows = parseOpenai(realPayload, NOW)
    expect(windows).toHaveLength(2)
    expect(windows[0]).toEqual({
      label: "5h",
      usedPct: 2,
      remainingPct: 98,
      resetLabel: "in 1h 30m",
    })
    expect(windows[1]).toEqual({
      label: "Weekly",
      usedPct: 0,
      remainingPct: 100,
      resetLabel: "5 Nov",
    })
  })

  test("computes the reset label from unix seconds", () => {
    const windows = parseOpenai(
      {
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: FIVE_HOUR_SECONDS,
            reset_at: unix(new Date(NOW + 10 * 60_000)),
          },
        },
      },
      NOW,
    )
    expect(windows[0].resetLabel).toBe("in 10m")
  })

  test("shows a past reset as now", () => {
    const windows = parseOpenai(
      {
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: FIVE_HOUR_SECONDS,
            reset_at: unix(new Date(NOW - 60_000)),
          },
        },
      },
      NOW,
    )
    expect(windows[0].resetLabel).toBe("now")
  })

  test("clamps out-of-range usage", () => {
    const high = parseOpenai(
      {
        rate_limit: {
          primary_window: {
            used_percent: 150,
            limit_window_seconds: FIVE_HOUR_SECONDS,
            reset_at: fiveHourResetAt,
          },
        },
      },
      NOW,
    )
    expect(high[0]).toMatchObject({ usedPct: 100, remainingPct: 0 })

    const low = parseOpenai(
      {
        rate_limit: {
          primary_window: {
            used_percent: -20,
            limit_window_seconds: FIVE_HOUR_SECONDS,
            reset_at: fiveHourResetAt,
          },
        },
      },
      NOW,
    )
    expect(low[0]).toMatchObject({ usedPct: 0, remainingPct: 100 })
  })

  test("accepts numeric strings", () => {
    const windows = parseOpenai(
      {
        rate_limit: {
          primary_window: {
            used_percent: "42",
            limit_window_seconds: 86400,
            reset_at: String(fiveHourResetAt),
          },
        },
      },
      NOW,
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ label: "Daily", usedPct: 42, remainingPct: 58 })
  })

  test("skips windows with unusable usage values", () => {
    const window = (used_percent: unknown) => ({
      rate_limit: {
        primary_window: {
          used_percent,
          limit_window_seconds: FIVE_HOUR_SECONDS,
          reset_at: fiveHourResetAt,
        },
      },
    })
    expect(parseOpenai(window(null), NOW)).toEqual([])
    expect(parseOpenai(window(Number.NaN), NOW)).toEqual([])
    expect(parseOpenai(window("garbage"), NOW)).toEqual([])
    expect(parseOpenai(window(undefined), NOW)).toEqual([])
  })

  test("skips windows without a usable reset_at", () => {
    const reset = (reset_at: unknown) => ({
      rate_limit: {
        primary_window: {
          used_percent: 5,
          limit_window_seconds: FIVE_HOUR_SECONDS,
          reset_at,
        },
      },
    })
    expect(parseOpenai(reset(undefined), NOW)).toEqual([])
    expect(parseOpenai(reset(null), NOW)).toEqual([])
    expect(parseOpenai(reset("garbage"), NOW)).toEqual([])
  })

  test("returns no windows for malformed payloads", () => {
    expect(parseOpenai(null, NOW)).toEqual([])
    expect(parseOpenai(undefined, NOW)).toEqual([])
    expect(parseOpenai("nope", NOW)).toEqual([])
    expect(parseOpenai([], NOW)).toEqual([])
    expect(parseOpenai({}, NOW)).toEqual([])
    expect(parseOpenai({ rate_limit: null }, NOW)).toEqual([])
    expect(parseOpenai({ rate_limit: {} }, NOW)).toEqual([])
    expect(parseOpenai({ rate_limit: { primary_window: null, secondary_window: null } }, NOW)).toEqual(
      [],
    )
  })

  test("derives fallback labels from the window length", () => {
    const label = (limit_window_seconds: unknown) =>
      parseOpenai(
        {
          rate_limit: {
            primary_window: { used_percent: 1, limit_window_seconds, reset_at: fiveHourResetAt },
          },
        },
        NOW,
      )[0]?.label

    expect(label(86400)).toBe("Daily")
    expect(label(14400)).toBe("4h")
    expect(label(undefined)).toBe("Window")
  })
})

describe("detectOpenai", () => {
  const makeHome = (path: string, content: string) => {
    const home = mkdtempSync(join(tmpdir(), "usage-openai-"))
    const file = join(home, path)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, content)
    return home
  }

  const codexAuth = (tokens: unknown) =>
    JSON.stringify({ auth_mode: "chatgpt", tokens })

  test("reads the Codex CLI auth file", async () => {
    const home = makeHome(
      ".codex/auth.json",
      codexAuth({ access_token: "codex-token", account_id: "acct" }),
    )
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "codex-token",
      source: { kind: "codex", path: join(home, ".codex", "auth.json") },
    })
  })

  test("reads the Codex refresh token when present", async () => {
    const home = makeHome(
      ".codex/auth.json",
      codexAuth({ access_token: "codex-token", refresh_token: "codex-refresh" }),
    )
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "codex-token",
      refreshToken: "codex-refresh",
      source: { kind: "codex", path: join(home, ".codex", "auth.json") },
    })
  })

  test("prefers the Codex CLI auth file over the OpenCode auth file", async () => {
    const home = makeHome(".codex/auth.json", codexAuth({ access_token: "codex-token" }))
    const file = join(home, ".config", "opencode", "auth.json")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, JSON.stringify({ "openai-codex": { type: "oauth", access: "oauth-token" } }))
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "codex-token",
      source: { kind: "codex", path: join(home, ".codex", "auth.json") },
    })
  })

  test("falls back to the OpenCode auth file in the data home", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-openai-"))
    const dataHome = mkdtempSync(join(tmpdir(), "usage-openai-xdg-"))
    mkdirSync(join(dataHome, "opencode"), { recursive: true })
    writeFileSync(
      join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "data-token" } }),
    )
    await expect(detectOpenai(home, dataHome)).resolves.toEqual({
      accessToken: "data-token",
      source: { kind: "opencode", path: join(dataHome, "opencode", "auth.json") },
    })
  })

  test("falls back to the OpenCode auth file in the home config", async () => {
    const home = makeHome(
      ".config/opencode/auth.json",
      JSON.stringify({ "openai-codex": { type: "oauth", access: "config-token" } }),
    )
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "config-token",
      source: { kind: "opencode", path: join(home, ".config", "opencode", "auth.json") },
    })
  })

  test("reads the OpenCode refresh token when present", async () => {
    const home = makeHome(
      ".config/opencode/auth.json",
      JSON.stringify({ "openai-codex": { type: "oauth", access: "config-token", refresh: "rt" } }),
    )
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "config-token",
      refreshToken: "rt",
      source: { kind: "opencode", path: join(home, ".config", "opencode", "auth.json") },
    })
  })

  test("accepts the key field of the OpenCode entry", async () => {
    const home = makeHome(
      ".config/opencode/auth.json",
      JSON.stringify({ "openai-codex": { type: "oauth", key: "key-token" } }),
    )
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "key-token",
      source: { kind: "opencode", path: join(home, ".config", "opencode", "auth.json") },
    })
  })

  test("skips unusable Codex auth and falls through", async () => {
    const home = makeHome(".codex/auth.json", codexAuth({ access_token: "" }))
    const file = join(home, ".config", "opencode", "auth.json")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, JSON.stringify({ "openai-codex": { type: "oauth", access: "oauth-token" } }))
    await expect(detectOpenai(home, join(home, "share"))).resolves.toEqual({
      accessToken: "oauth-token",
      source: { kind: "opencode", path: join(home, ".config", "opencode", "auth.json") },
    })
  })

  test("returns undefined for missing, invalid, or empty sources", async () => {
    const empty = mkdtempSync(join(tmpdir(), "usage-openai-"))
    await expect(detectOpenai(empty, join(empty, "share"))).resolves.toBeUndefined()

    for (const content of [
      "not json",
      "[]",
      JSON.stringify({ auth_mode: "chatgpt" }),
      codexAuth({ access_token: 42 }),
      codexAuth({ access_token: "   " }),
    ]) {
      const home = makeHome(".codex/auth.json", content)
      await expect(detectOpenai(home, join(home, "share"))).resolves.toBeUndefined()
    }

    const noEntry = makeHome(".config/opencode/auth.json", JSON.stringify({ other: {} }))
    await expect(detectOpenai(noEntry, join(noEntry, "share"))).resolves.toBeUndefined()

    const emptyEntry = makeHome(
      ".config/opencode/auth.json",
      JSON.stringify({ "openai-codex": { type: "oauth", access: "" } }),
    )
    await expect(detectOpenai(emptyEntry, join(emptyEntry, "share"))).resolves.toBeUndefined()
  })

  test("reads XDG_DATA_HOME and HOME from the environment by default", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "usage-openai-env-"))
    mkdirSync(join(dataHome, "opencode"), { recursive: true })
    writeFileSync(
      join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "env-token" } }),
    )
    vi.stubEnv("XDG_DATA_HOME", dataHome)
    vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "usage-openai-home-")))
    await expect(detectOpenai()).resolves.toEqual({
      accessToken: "env-token",
      source: { kind: "opencode", path: join(dataHome, "opencode", "auth.json") },
    })
  })
})

describe("fetchOpenai", () => {
  const credentials: OpenaiCredentials = { accessToken: "secret-token" }

  test("returns parsed windows on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(realPayload), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const windows = await fetchOpenai(credentials, new AbortController().signal, NOW)
    expect(windows).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer secret-token" })
    expect((init as RequestInit).method ?? "GET").toBe("GET")
  })

  test("returns an empty list when a successful payload has no windows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })))
    await expect(fetchOpenai(credentials, new AbortController().signal, NOW)).resolves.toEqual([])
  })

  test("maps rejected credentials to a sign-in message without leaking the token", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })))
      const result = await fetchOpenai(credentials, new AbortController().signal, NOW)
      expect(result).toEqual({ error: "Codex sign-in expired — run codex login" })
      expect(JSON.stringify(result)).not.toContain("secret-token")
    }
  })

  test("maps other non-ok responses to a generic error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })))
    await expect(fetchOpenai(credentials, new AbortController().signal, NOW)).resolves.toEqual({
      error: "OpenAI usage unavailable",
    })
  })

  test("maps an unparsable success body to a generic error", async () => {
    for (const body of ["<html>maintenance</html>", ""]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
      await expect(fetchOpenai(credentials, new AbortController().signal, NOW)).resolves.toEqual({
        error: "OpenAI usage unavailable",
      })
    }
  })

  test("maps aborts and network failures to a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")),
    )
    await expect(fetchOpenai(credentials, new AbortController().signal, NOW)).resolves.toEqual({
      error: "OpenAI usage unavailable",
    })

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network secret-token")))
    const result = await fetchOpenai(credentials, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "OpenAI usage unavailable" })
    expect(JSON.stringify(result)).not.toContain("secret-token")
  })

  test("passes an abortable signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(realPayload), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await fetchOpenai(credentials, new AbortController().signal, NOW)
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })
})

describe("fetchOpenai token refresh", () => {
  const TOKEN_URL = "https://auth.openai.com/oauth/token"
  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

  const jwt = (claims: Record<string, unknown>): string => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`
  }

  const expiredToken = jwt({ exp: Math.floor(NOW / 1000) - 3600 })
  const validToken = jwt({ exp: Math.floor(NOW / 1000) + 86400 })

  const makeCodexHome = (tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const home = mkdtempSync(join(tmpdir(), "usage-openai-refresh-"))
    mkdirSync(join(home, ".codex"), { recursive: true })
    const file = join(home, ".codex", "auth.json")
    writeFileSync(file, JSON.stringify({ auth_mode: "chatgpt", last_refresh: "old", ...extra, tokens }))
    return { home, file }
  }

  const makeOpencodeHome = (entry: Record<string, unknown>) => {
    const home = mkdtempSync(join(tmpdir(), "usage-openai-refresh-"))
    const file = join(home, ".config", "opencode", "auth.json")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, JSON.stringify({ "openai-codex": { type: "oauth", ...entry } }))
    return { home, file }
  }

  const refreshResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const okRefresh = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    id_token: "new-id",
    expires_in: 3600,
    account_id: "acct-2",
  }

  const routeFetch = (usageResponder: (init: unknown) => Response) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return refreshResponse(200, okRefresh)
      return usageResponder(init)
    })

  const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8"))

  test("refreshes an expired token proactively and persists the rotated pair", async () => {
    const { home, file } = makeCodexHome(
      { access_token: expiredToken, refresh_token: "old-refresh", account_id: "acct-1" },
      { OPENAI_API_KEY: "keep-me" },
    )
    const creds = await detectOpenai(home, join(home, "share"))
    expect(creds?.refreshToken).toBe("old-refresh")

    const fetchMock = vi.fn(routeFetch(() => new Response(JSON.stringify(realPayload), { status: 200 })))
    vi.stubGlobal("fetch", fetchMock)
    const windows = await fetchOpenai(creds!, new AbortController().signal, NOW)
    expect(windows).toHaveLength(2)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe(TOKEN_URL)
    expect((tokenInit as RequestInit).method).toBe("POST")
    expect(JSON.parse((tokenInit as RequestInit).body as string)).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      scope: "openid profile email offline_access",
    })
    const [usageUrl, usageInit] = fetchMock.mock.calls[1]
    expect(usageUrl).toBe(USAGE_URL)
    expect((usageInit as RequestInit).headers).toEqual({ Authorization: "Bearer new-access" })

    const saved = readJson(file)
    expect(saved.tokens.access_token).toBe("new-access")
    expect(saved.tokens.refresh_token).toBe("new-refresh")
    expect(saved.tokens.id_token).toBe("new-id")
    expect(saved.tokens.account_id).toBe("acct-2")
    expect(saved.last_refresh).not.toBe("old")
    expect(saved.OPENAI_API_KEY).toBe("keep-me")
    expect(saved.auth_mode).toBe("chatgpt")
  })

  test("persists rotated tokens to the OpenCode entry keeping the epoch-ms expiry format", async () => {
    const { home, file } = makeOpencodeHome({
      access: expiredToken,
      refresh: "old-refresh",
      expires: 123,
      type: "oauth",
    })
    const creds = await detectOpenai(home, join(home, "share"))
    const fetchMock = vi.fn(routeFetch(() => new Response(JSON.stringify(realPayload), { status: 200 })))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchOpenai(creds!, new AbortController().signal, NOW)).resolves.toHaveLength(2)

    const entry = readJson(file)["openai-codex"]
    expect(entry.access).toBe("new-access")
    expect(entry.refresh).toBe("new-refresh")
    expect(entry.expires).toBe(NOW + 3600_000)
    expect(entry.type).toBe("oauth")
  })

  test("keeps the ISO string expiry format in the OpenCode entry", async () => {
    const { home, file } = makeOpencodeHome({
      access: expiredToken,
      refresh: "old-refresh",
      expires: "2020-01-01T00:00:00.000Z",
    })
    const creds = await detectOpenai(home, join(home, "share"))
    vi.stubGlobal("fetch", vi.fn(routeFetch(() => new Response(JSON.stringify(realPayload), { status: 200 }))))
    await fetchOpenai(creds!, new AbortController().signal, NOW)

    const entry = readJson(file)["openai-codex"]
    expect(typeof entry.expires).toBe("string")
    expect(new Date(entry.expires).getTime()).toBe(NOW + 3600_000)
  })

  test("refreshes once and retries after a 401", async () => {
    const { home, file } = makeCodexHome({ access_token: validToken, refresh_token: "old-refresh" })
    const creds = await detectOpenai(home, join(home, "share"))
    let usageCalls = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return refreshResponse(200, okRefresh)
      usageCalls += 1
      if (usageCalls === 1) return new Response("", { status: 401 })
      return new Response(JSON.stringify(realPayload), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const windows = await fetchOpenai(creds!, new AbortController().signal, NOW)
    expect(windows).toHaveLength(2)
    expect(usageCalls).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe(TOKEN_URL)
    expect(readJson(file).tokens.access_token).toBe("new-access")
  })

  test("does not refresh while the token is still valid", async () => {
    const { home } = makeCodexHome({ access_token: validToken, refresh_token: "old-refresh" })
    const creds = await detectOpenai(home, join(home, "share"))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(realPayload), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchOpenai(creds!, new AbortController().signal, NOW)).resolves.toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(USAGE_URL)
  })

  test("skips refresh when no refresh token is stored", async () => {
    const { home } = makeCodexHome({ access_token: expiredToken })
    const creds = await detectOpenai(home, join(home, "share"))
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)
    const result = await fetchOpenai(creds!, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "Codex sign-in expired — run codex login" })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(USAGE_URL)
  })

  test("falls back to the stored token when the refresh call fails", async () => {
    const { home } = makeCodexHome({ access_token: expiredToken, refresh_token: "old-refresh" })
    const creds = await detectOpenai(home, join(home, "share"))
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === TOKEN_URL) return refreshResponse(500, { error: "server_error" })
      return new Response(JSON.stringify(realPayload), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const windows = await fetchOpenai(creds!, new AbortController().signal, NOW)
    expect(windows).toHaveLength(2)
    const [, usageInit] = fetchMock.mock.calls[1]
    expect((usageInit as RequestInit).headers).toEqual({
      Authorization: `Bearer ${expiredToken}`,
    })
  })

  test("still reports the sign-in error when refresh and retry both fail", async () => {
    const { home } = makeCodexHome({ access_token: validToken, refresh_token: "old-refresh" })
    const creds = await detectOpenai(home, join(home, "share"))
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return refreshResponse(400, { error: "invalid_grant" })
      return new Response("", { status: 403 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const result = await fetchOpenai(creds!, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "Codex sign-in expired — run codex login" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("never surfaces tokens in errors", async () => {
    const { home } = makeCodexHome({ access_token: expiredToken, refresh_token: "super-secret-refresh" })
    const creds = await detectOpenai(home, join(home, "share"))
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) throw new Error("refresh rejected for super-secret-refresh")
        return new Response("", { status: 401 })
      }),
    )
    const result = await fetchOpenai(creds!, new AbortController().signal, NOW)
    expect(result).toEqual({ error: "Codex sign-in expired — run codex login" })
    expect(JSON.stringify(result)).not.toContain("super-secret-refresh")
    expect(JSON.stringify(result)).not.toContain(expiredToken)
  })

  test("treats non-JWT tokens as never expiring", async () => {
    const { home } = makeOpencodeHome({ access: "plain-api-key", refresh: "rt" })
    const creds = await detectOpenai(home, join(home, "share"))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(realPayload), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchOpenai(creds!, new AbortController().signal, NOW)).resolves.toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(USAGE_URL)
  })
})