import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({ all: () => [] }),
}));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: async () => [{ id: "account-1", name: "Codex account" }],
}));

import { getActiveRequests, trackPendingRequest } from "@/lib/db/repos/usageRepo.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
  global._pendingRequests.byModel = {};
  global._pendingRequests.byAccount = {};
  global._lastErrorProvider.provider = "";
  global._lastErrorProvider.ts = 0;
  global._statsEmitTimers.pending = null;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("usage request activity", () => {
  it("keeps a long stream active until it completes", async () => {
    trackPendingRequest("gpt-5", "codex", "account-1", true);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect((await getActiveRequests()).activeRequests).toEqual([
      { model: "gpt-5", provider: "codex", account: "Codex account", count: 1 },
    ]);

    trackPendingRequest("gpt-5", "codex", "account-1", false);
    expect((await getActiveRequests()).activeRequests).toEqual([]);
    expect(global._pendingRequests.byModel).toEqual({});
  });

  it("keeps overlapping requests active when one finishes", async () => {
    trackPendingRequest("gpt-5", "codex", "account-1", true);
    await vi.advanceTimersByTimeAsync(30_000);
    trackPendingRequest("gpt-5", "codex", "account-1", true);
    await vi.advanceTimersByTimeAsync(90_000);

    expect((await getActiveRequests()).activeRequests[0].count).toBe(2);
    trackPendingRequest("gpt-5", "codex", "account-1", false);
    expect((await getActiveRequests()).activeRequests[0].count).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await getActiveRequests()).activeRequests[0].count).toBe(1);

    trackPendingRequest("gpt-5", "codex", "account-1", false, true);
    expect(await getActiveRequests()).toMatchObject({ activeRequests: [], errorProvider: "codex" });
  });

  it("clears cancelled requests without affecting another account", async () => {
    trackPendingRequest("gpt-5", "codex", "account-1", true);
    trackPendingRequest("gpt-5", "codex", "account-2", true);
    await vi.advanceTimersByTimeAsync(90_000);

    trackPendingRequest("gpt-5", "codex", "account-1", false);
    expect((await getActiveRequests()).activeRequests).toEqual([
      expect.objectContaining({ provider: "codex", count: 1 }),
    ]);
    expect(global._pendingRequests.byModel["gpt-5 (codex)"]).toBe(1);

    trackPendingRequest("gpt-5", "codex", "account-2", false);
    expect((await getActiveRequests()).activeRequests).toEqual([]);
  });
});
