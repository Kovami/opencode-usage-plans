export type QuotaWindow = {
  label: string
  usedPct: number
  remainingPct: number
  resetLabel: string
}

export type ProviderState =
  | { phase: "hidden" }
  | { phase: "detecting" }
  | { phase: "loading" }
  | { phase: "ok"; windows: QuotaWindow[] }
  | { phase: "error"; message: string }

export type Provider = {
  id: string
  title: string
  detect(): Promise<boolean>
  fetch(signal: AbortSignal): Promise<QuotaWindow[] | { error: string }>
}