import { describe, expect, it } from "vitest"
import { blockOfProviderID, sortProviders } from "./order"

const items = [
  { id: "kimi" as const, title: "Kimi Code (kimi.ai)" },
  { id: "alibaba" as const, title: "Alibaba Token Plan" },
  { id: "openai" as const, title: "OpenAI Codex" },
  { id: "zai" as const, title: "Z.AI Coding Plan" },
]

const titles = (list: { title: string }[]) => list.map((item) => item.title)

describe("blockOfProviderID", () => {
  it("maps known provider ids to blocks", () => {
    expect(blockOfProviderID("kimi-code-plan-global")).toBe("kimi")
    expect(blockOfProviderID("kimi-for-coding")).toBe("kimi")
    expect(blockOfProviderID("alibaba-token-plan")).toBe("alibaba")
    expect(blockOfProviderID("alibaba-token-plan-cn")).toBe("alibaba")
    expect(blockOfProviderID("openai-codex")).toBe("openai")
    expect(blockOfProviderID("zai-coding-plan")).toBe("zai")
    expect(blockOfProviderID("zhipuai-coding-plan")).toBe("zai")
  })

  it("returns undefined for unknown or missing ids", () => {
    expect(blockOfProviderID("anthropic")).toBeUndefined()
    expect(blockOfProviderID("strata")).toBeUndefined()
    expect(blockOfProviderID(undefined)).toBeUndefined()
  })
})

describe("sortProviders", () => {
  it("keeps alphabetical order when nothing was used", () => {
    expect(titles(sortProviders(items, {}))).toEqual([
      "Alibaba Token Plan",
      "Kimi Code (kimi.ai)",
      "OpenAI Codex",
      "Z.AI Coding Plan",
    ])
  })

  it("lifts a single used provider to the top", () => {
    const sorted = sortProviders(items, { zai: 100 })
    expect(sorted[0]?.id).toBe("zai")
    expect(titles(sorted.slice(1))).toEqual([
      "Alibaba Token Plan",
      "Kimi Code (kimi.ai)",
      "OpenAI Codex",
    ])
  })

  it("orders used providers by most recent first and the rest by title", () => {
    // Used B, then A, then B again: B is more recent than A.
    const sorted = sortProviders(items, { kimi: 1_000, openai: 2_000 })
    expect(titles(sorted)).toEqual([
      "OpenAI Codex",
      "Kimi Code (kimi.ai)",
      "Alibaba Token Plan",
      "Z.AI Coding Plan",
    ])
  })

  it("ignores non-finite or non-positive timestamps", () => {
    const sorted = sortProviders(items, { zai: Number.NaN, kimi: 0, openai: -5 })
    expect(titles(sorted)).toEqual([
      "Alibaba Token Plan",
      "Kimi Code (kimi.ai)",
      "OpenAI Codex",
      "Z.AI Coding Plan",
    ])
  })

  it("does not mutate the input array", () => {
    const source = [...items]
    sortProviders(source, { zai: 1 })
    expect(source).toEqual(items)
  })
})
