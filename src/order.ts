export type ProviderBlock = "kimi" | "alibaba" | "openai" | "zai"

export type SortableProvider = {
  id: ProviderBlock
  title: string
}

// OpenCode provider IDs (auth.json entries / models.dev IDs) that belong to
// each usage block. Used to attribute a session's model to a sidebar block.
const BLOCK_BY_PROVIDER_ID: Record<string, ProviderBlock> = {
  "kimi-code-plan-global": "kimi",
  "kimi-for-coding": "kimi",
  kimi: "kimi",
  "alibaba-token-plan": "alibaba",
  "alibaba-token-plan-cn": "alibaba",
  "alibaba-coding-plan": "alibaba",
  "alibaba-coding-plan-cn": "alibaba",
  "openai-codex": "openai",
  codex: "openai",
  openai: "openai",
  "zai-coding-plan": "zai",
  "zhipuai-coding-plan": "zai",
  zai: "zai",
  zhipuai: "zai",
}

export function blockOfProviderID(providerID: string | undefined): ProviderBlock | undefined {
  return providerID === undefined ? undefined : BLOCK_BY_PROVIDER_ID[providerID]
}

/**
 * Recently used providers first, most recent on top; the rest keep their
 * place below, sorted by title. `lastUsed` maps a block id to a timestamp.
 */
export function sortProviders<T extends SortableProvider>(
  items: T[],
  lastUsed: Record<string, number>,
): T[] {
  const used = (item: T): number => {
    const at = lastUsed[item.id]
    return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : 0
  }
  return [...items].sort((a, b) => {
    const aUsed = used(a)
    const bUsed = used(b)
    if (aUsed !== bUsed) return bUsed - aUsed
    if (aUsed > 0) return bUsed - aUsed
    return a.title.localeCompare(b.title)
  })
}
