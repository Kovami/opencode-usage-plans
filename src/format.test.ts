import { describe, expect, test } from "vitest"
import { clampPct, formatReset, quotaBar, quotaColor, windowLabel } from "./format"

describe("clampPct", () => {
  test("normalizes invalid and out-of-range values", () => {
    expect(clampPct(Number.NaN)).toBe(0)
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampPct(-5)).toBe(0)
    expect(clampPct(150)).toBe(100)
  })

  test("keeps values inside the range", () => {
    expect(clampPct(0)).toBe(0)
    expect(clampPct(42.5)).toBe(42.5)
    expect(clampPct(100)).toBe(100)
  })
})

describe("quotaBar", () => {
  test("fills half of the default bar at 50 percent", () => {
    expect(quotaBar(50)).toBe(`${"█".repeat(8)}${"░".repeat(8)}`)
  })

  test("renders empty and full bars", () => {
    expect(quotaBar(0)).toBe("░".repeat(16))
    expect(quotaBar(100)).toBe("█".repeat(16))
  })

  test("accepts a custom width", () => {
    expect(quotaBar(50, 4)).toBe("██░░")
  })
})

describe("quotaColor", () => {
  test("maps usage to the traffic-light palette", () => {
    expect(quotaColor(91)).toBe("#ef4444")
    expect(quotaColor(51)).toBe("#eab308")
    expect(quotaColor(50)).toBe("#22c55e")
    expect(quotaColor(undefined as unknown as number)).toBe("#8b949e")
  })
})

describe("formatReset", () => {
  const now = new Date(2026, 9, 29, 12, 0, 0, 0).getTime()

  test("counts down within a day", () => {
    expect(formatReset(now + (3 * 60 + 12) * 60_000, now)).toBe("in 3h 12m")
    expect(formatReset(now + 45 * 60_000, now)).toBe("in 45m")
  })

  test("reports an elapsed reset as now", () => {
    expect(formatReset(now - 1, now)).toBe("now")
  })

  test("uses a date beyond 24 hours", () => {
    expect(formatReset(new Date(2026, 10, 1, 12).getTime(), now)).toBe("1 Nov")
  })
})

describe("windowLabel", () => {
  test("formats one decimal place", () => {
    expect(windowLabel(23.44)).toBe("23.4%")
  })
})