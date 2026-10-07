import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { all } = vi.hoisted(() => ({ all: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({ all }),
}));

import { getChartData } from "@/lib/db/repos/usageRepo.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  all.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("usage chart request counts with selected time zones", () => {
  it.each(["today", "24h", "7d", "30d", "60d", "all"])("counts requests in %s buckets", async (period) => {
    all.mockReturnValue([
      { timestamp: "2026-10-07T01:00:00Z", promptTokens: 10, completionTokens: 5, cost: 0.1 },
      { timestamp: "2026-10-07T01:30:00Z", promptTokens: 20, completionTokens: 5, cost: 0.2 },
    ]);

    const buckets = await getChartData(period, "Europe/Berlin");
    expect(buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(2);
    expect(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(40);
    expect(buckets.reduce((sum, bucket) => sum + bucket.cost, 0)).toBeCloseTo(0.3);
    expect(buckets.every(bucket => Number.isFinite(bucket.requests))).toBe(true);
  });

  it("groups requests across UTC midnight into the selected local day", async () => {
    all.mockReturnValue([
      { timestamp: "2026-10-06T21:30:00Z", promptTokens: 10 },
      { timestamp: "2026-10-06T22:30:00Z", promptTokens: 20 },
    ]);

    const buckets = await getChartData("7d", "Europe/Berlin");
    expect(buckets.at(-2)).toMatchObject({ label: "Oct 6", tokens: 10, requests: 1 });
    expect(buckets.at(-1)).toMatchObject({ label: "Oct 7", tokens: 20, requests: 1 });
  });

  it("keeps monthly all-time buckets and fills empty months", async () => {
    all.mockReturnValue([
      { timestamp: "2026-07-31T22:30:00Z", promptTokens: 10 },
      { timestamp: "2026-10-07T01:00:00Z", promptTokens: 20 },
    ]);

    expect(await getChartData("all", "Europe/Berlin")).toEqual([
      { label: "Aug 2026", tokens: 10, cost: 0, requests: 1 },
      { label: "Sep 2026", tokens: 0, cost: 0, requests: 0 },
      { label: "Oct 2026", tokens: 20, cost: 0, requests: 1 },
    ]);
  });
});
