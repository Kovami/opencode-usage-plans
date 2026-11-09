import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { detectZai, fetchZai, parseZai } from "./zai"

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
const HOUR = 3_600_000

const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-zai-"))
  return {
    home: dir,
    dataHome: join(dir, "data"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const writeAuth = (path: string, payload: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(payload), "utf8")
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("parseZai", () => {
  const payload = {
    code: 200,
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, percentage: 16, nextResetTime: NOW + 2 * HOUR },
        { type: "TOKENS_LIMIT", unit: 6, percentage: 4, nextResetTime: NOW + 3 * 24 * HOUR },
        { type: "TIME_LIMIT", unit: 5, percentage: 0, nextResetTime: NOW + 30 * 24 * HOUR },
      ],
      level: "lite",
    },
  }

  it("maps units 3/6/5 to 5h/Weekly/MCP windows", () => {
    const windows = parseZai(payload, NOW)
    expect(windows).toHaveLength(3)
    expect(windows[0]).toEqual({
      label: "5h",
      usedPct: 16,
      remainingPct: 84,
      resetLabel: "in 2h 0m",
    })
    expect(windows[1]?.label).toBe("Weekly")
    expect(windows[1]?.remainingPct).toBe(96)
    expect(windows[2]?.label).toBe("MCP")
    expect(windows[2]?.usedPct).toBe(0)
  })

  it("accepts numeric strings and clamps out-of-range percentages", () => {
    const windows = parseZai(
      {
        code: 200,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: "120", nextResetTime: `${NOW + HOUR}` },
            { type: "TOKENS_LIMIT", unit: 6, percentage: "-5", nextResetTime: NOW + HOUR },
          ],
        },
      },
      NOW,
    )
    expect(windows.map((w) => w.usedPct)).toEqual([100, 0])
  })

  it("labels unknown units as Window", () => {
    const windows = parseZai(
      { code: 200, data: { limits: [{ type: "OTHER", unit: 99, percentage: 10, nextResetTime: NOW + HOUR }] } },
      NOW,
    )
    expect(windows[0]?.label).toBe("Window")
  })

  it("skips entries without percentage or nextResetTime", () => {
    const windows = parseZai(
      {
        code: 200,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: null, nextResetTime: NOW + HOUR },
            { type: "TOKENS_LIMIT", unit: 6, percentage: 10, nextResetTime: null },
            { type: "TOKENS_LIMIT", unit: 5, percentage: "", nextResetTime: NOW + HOUR },
            "nope",
            { type: "TOKENS_LIMIT", unit: 3, percentage: 50, nextResetTime: NOW + HOUR },
          ],
        },
      },
      NOW,
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]?.usedPct).toBe(50)
  })

  it("returns nothing for failed codes or malformed payloads", () => {
    expect(parseZai({ code: 429, data: { limits: [] } }, NOW)).toEqual([])
    expect(parseZai({ code: 429, data: { limits: payload.data.limits } }, NOW)).toEqual([])
    expect(parseZai({}, NOW)).toEqual([])
    expect(parseZai(null, NOW)).toEqual([])
    expect(parseZai("str", NOW)).toEqual([])
    expect(parseZai({ code: 200, data: { limits: "x" } }, NOW)).toEqual([])
  })
})

describe("detectZai", () => {
  it("prefers ZAI_API_KEY over auth files", async () => {
    const t = tempHome()
    try {
      vi.stubEnv("ZAI_API_KEY", "env-key")
      writeAuth(join(t.dataHome, "opencode", "auth.json"), { zai: { key: "file-key" } })
      const credentials = await detectZai(process.env, t.dataHome, t.home)
      expect(credentials).toEqual({ key: "env-key" })
    } finally {
      t.cleanup()
    }
  })

  it("reads the key from known auth entries", async () => {
    for (const entryId of ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]) {
      const t = tempHome()
      try {
        writeAuth(join(t.dataHome, "opencode", "auth.json"), { [entryId]: { key: `key-${entryId}` } })
        expect(await detectZai({ ...process.env, ZAI_API_KEY: "" }, t.dataHome, t.home)).toEqual({
          key: `key-${entryId}`,
        })
      } finally {
        t.cleanup()
      }
    }
  })

  it("falls back to HOME-based auth paths", async () => {
    const t = tempHome()
    try {
      writeAuth(join(t.home, ".config", "opencode", "auth.json"), { zai: { key: "config-key" } })
      expect(await detectZai({}, undefined, t.home)).toEqual({ key: "config-key" })
    } finally {
      t.cleanup()
    }
  })

  it("ignores empty keys, unrelated entries and broken files", async () => {
    const t = tempHome()
    try {
      writeAuth(join(t.dataHome, "opencode", "auth.json"), "{ not json")
      writeAuth(join(t.home, ".local", "share", "opencode", "auth.json"), {
        zai: { key: "   " },
        "kimi-code-plan-global": { key: "other" },
      })
      expect(await detectZai({}, t.dataHome, t.home)).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it("returns undefined when nothing is configured", async () => {
    const t = tempHome()
    try {
      expect(await detectZai({}, t.dataHome, t.home)).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })
})

describe("fetchZai", () => {
  const body = JSON.stringify({
    code: 200,
    data: {
      limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 42, nextResetTime: NOW + HOUR }],
    },
  })

  it("requests the limit endpoint with the bearer key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const windows = await fetchZai({ key: "secret-key" }, new AbortController().signal, undefined, NOW)
    expect(windows).toEqual([
      { label: "5h", usedPct: 42, remainingPct: 58, resetLabel: "in 1h 0m" },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key")
  })

  it("supports the China base url", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await fetchZai(
      { key: "k" },
      new AbortController().signal,
      "https://open.bigmodel.cn",
      NOW,
    )
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    )
  })

  it("reports a rejected key without leaking it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })))
    const result = await fetchZai({ key: "secret-key" }, new AbortController().signal, undefined, NOW)
    expect(result).toEqual({ error: "Z.AI key rejected — check ZAI_API_KEY" })
    expect(JSON.stringify(result)).not.toContain("secret-key")
  })

  it("reports generic errors for failures, rejections and empty windows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })))
    expect(
      await fetchZai({ key: "k" }, new AbortController().signal, undefined, NOW),
    ).toEqual({ error: "Z.AI usage unavailable" })

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 429 }), { status: 200 })))
    expect(
      await fetchZai({ key: "k" }, new AbortController().signal, undefined, NOW),
    ).toEqual({ error: "Z.AI usage unavailable" })

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    expect(
      await fetchZai({ key: "k" }, new AbortController().signal, undefined, NOW),
    ).toEqual({ error: "Z.AI usage unavailable" })
  })
})
