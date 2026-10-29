const BAR_WIDTH = 16
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Clamps a percentage to 0..100; anything non-finite becomes 0. */
export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function quotaBar(usedPct: number, width = BAR_WIDTH): string {
  const cells = Math.max(0, Math.round(width))
  const filled = Math.round((clampPct(usedPct) / 100) * cells)
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`
}

export function quotaColor(usedPct: number): string {
  if (!Number.isFinite(usedPct)) return "#8b949e"
  if (usedPct > 90) return "#ef4444"
  if (usedPct > 50) return "#eab308"
  return "#22c55e"
}

export function formatReset(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return ""
  const left = at - now
  if (left <= 0) return "now"
  if (left < 24 * 3_600_000) {
    const totalMinutes = Math.round(left / 60_000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`
  }
  const date = new Date(at)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

export function windowLabel(usedPct: number): string {
  return `${clampPct(usedPct).toFixed(1)}%`
}