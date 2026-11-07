import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(), getProviderConnections: vi.fn(), getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn(),
}));
vi.mock("open-sse/services/usage/codex.js", () => ({ getCodexUsage: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({
  getCodexUsage: vi.fn(), getCodexRateLimitResetCredits: vi.fn(), consumeCodexRateLimitResetCredit: vi.fn(),
}));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));

import { hasExpiringCredit, hasUsedQuota, getNextCreditCheck, runCodexAutoResetTick, configureCodexAutoReset } from "../../src/shared/services/codexAutoReset.js";
import { withCodexResetLock, consumeWithRefresh } from "../../src/shared/services/codexResetCredits.js";
import { consumeCodexRateLimitResetCredit } from "open-sse/services/usage.js";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";

const now = Date.parse("2026-11-07T12:00:00Z");
function credits(minutes = 10, status = "available") {
  return { availableCount: 1, credits: [{ status, expiresAt: new Date(now + minutes * 60000).toISOString() }] };
}
let connection, deps;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks();
  connection = { id: "c1", provider: "codex", isActive: true, authType: "oauth", accessToken: "token" };
  deps = {
    getSettings: vi.fn().mockResolvedValue({ codexAutoReset: { connections: { c1: true } } }),
    getProviderConnections: vi.fn().mockResolvedValue([connection]),
    getProviderConnectionById: vi.fn(async () => connection),
    getCodexConnection: vi.fn(async () => ({ connection, proxyOptions: { strictProxy: false } })),
    refreshCodexConnection: vi.fn(async () => ({ connection })),
    getCodexRateLimitResetCredits: vi.fn(async () => credits()),
    getCodexUsage: vi.fn().mockResolvedValue({ quotas: { session: { used: 20 } } }),
    updateProviderConnection: vi.fn(async (_id, patch) => Object.assign(connection, patch)),
    consumeWithRefresh: vi.fn().mockResolvedValue({ ok: true }),
    withCodexResetLock,
  };
});
afterEach(() => { configureCodexAutoReset({}); vi.useRealTimers(); });
const tick = () => runCodexAutoResetTick(deps, { running: false });

describe("Codex reset auto-apply", () => {
  it.each([[15, true], [15.01, false], [0, false], [-1, false]])("checks expiry boundary %s", (minutes, expected) => {
    expect(hasExpiringCredit(credits(minutes), now)).toBe(expected);
  });
  it("rejects invalid, redeemed and unavailable credits", () => {
    expect(hasExpiringCredit(credits(10, "redeemed"), now)).toBe(false);
    expect(hasExpiringCredit({ ...credits(), availableCount: 0 }, now)).toBe(false);
    expect(hasExpiringCredit({ availableCount: 1, credits: [{ status: "available", expiresAt: "bad" }] }, now)).toBe(false);
  });
  it("requires finite used quota", () => {
    for (const used of [0, undefined, NaN, Infinity]) expect(hasUsedQuota({ quotas: { session: { used } } })).toBe(false);
    expect(hasUsedQuota({ quotas: { session: { used: 10, unlimited: true } } })).toBe(false);
    expect(hasUsedQuota({ message: "unavailable" })).toBe(false);
    expect(hasUsedQuota({ quotas: { weekly: { used: 1 } } })).toBe(true);
  });
  it("is off by default", async () => {
    deps.getSettings.mockResolvedValue({}); await tick();
    expect(deps.getProviderConnections).not.toHaveBeenCalled();
  });
  it("persists before consuming and refreshes after success", async () => {
    await tick();
    const pending = deps.updateProviderConnection.mock.calls[0][1].codexAutoResetPending;
    expect(pending.redeemRequestId).toBeTruthy();
    expect(deps.updateProviderConnection.mock.invocationCallOrder[0]).toBeLessThan(deps.consumeWithRefresh.mock.invocationCallOrder[0]);
    expect(deps.consumeWithRefresh).toHaveBeenCalledWith(expect.anything(), pending.redeemRequestId, { strictProxy: false });
    expect(deps.getCodexUsage).toHaveBeenCalledTimes(2);
    expect(connection.codexAutoResetPending).toBeNull();
  });
  it.each(["access_token", "oauth"])("supports %s credentials", async (authType) => {
    connection.authType = authType; await tick();
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
    expect(deps.refreshCodexConnection).toHaveBeenCalledTimes(authType === "oauth" ? 1 : 0);
  });
  it.each(["inactive", "wrong_provider", "api_key", "disabled", "full", "unavailable", "expired"])("skips %s accounts", async (mode) => {
    if (mode === "inactive") connection.isActive = false;
    if (mode === "wrong_provider") connection.provider = "claude";
    if (mode === "api_key") connection.authType = "apikey";
    if (mode === "disabled") deps.getSettings.mockResolvedValue({ codexAutoReset: { connections: { c1: false } } });
    if (mode === "full") deps.getCodexUsage.mockResolvedValue({ quotas: { session: { used: 0 } } });
    if (mode === "unavailable") deps.getCodexUsage.mockResolvedValue({ message: "unavailable" });
    if (mode === "expired") deps.getCodexRateLimitResetCredits.mockResolvedValue(credits(-1));
    await tick(); expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
  });
  it("reuses the persisted request after an ambiguous failure and restart", async () => {
    deps.consumeWithRefresh.mockRejectedValueOnce(new Error("network failure"));
    await tick(); const id = connection.codexAutoResetPending.redeemRequestId;
    await tick();
    expect(deps.consumeWithRefresh.mock.calls.map((call) => call[1])).toEqual([id, id]);
  });
  it("does not consume again when post-reset refresh fails", async () => {
    deps.getCodexUsage.mockResolvedValueOnce({ quotas: { session: { used: 20 } } }).mockResolvedValueOnce({ message: "unavailable" });
    await tick(); expect(connection.codexAutoResetPending.applied).toBe(true);
    await tick(); expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
    expect(connection.codexAutoResetPending).toBeNull();
  });
  it("does not retry an uncertain request after its credit expires", async () => {
    deps.consumeWithRefresh.mockRejectedValueOnce(new Error("network failure"));
    await tick();
    vi.setSystemTime(now + 11 * 60000);
    await tick();
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
    expect(connection.codexAutoResetPending).toBeNull();
  });
  it("force-refreshes OAuth when credit inspection reports expired auth", async () => {
    connection.refreshToken = "refresh";
    deps.getCodexRateLimitResetCredits.mockRejectedValueOnce(new Error("unauthorized 401"));
    await tick();
    expect(deps.refreshCodexConnection).toHaveBeenCalledWith(expect.anything(), { strictProxy: false }, true);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });
  it("clears a definitive no-credit response", async () => {
    deps.consumeWithRefresh.mockResolvedValue({ noCredit: true });
    await tick();
    expect(connection.codexAutoResetPending).toBeNull();
    expect(connection.lastAutoResetAt).toBeUndefined();
  });
  it("never consumes if persistence fails", async () => {
    deps.updateProviderConnection.mockRejectedValue(new Error("disk failure"));
    await tick(); expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
  });
  it("serializes manual and automatic operations", async () => {
    let release;
    const manual = withCodexResetLock("c1", () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    const automatic = tick(); await Promise.resolve();
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    release(); await manual; await automatic;
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });
  it("starts and stops independently of auto-ping", async () => {
    const state = {};
    await configureCodexAutoReset({}, deps, state);
    expect(vi.getTimerCount()).toBe(0);
    await configureCodexAutoReset({ codexAutoReset: { connections: { c1: true } } }, deps, state);
    expect(vi.getTimerCount()).toBe(1);
    configureCodexAutoReset({}, deps, state);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reuses the redemption ID after OAuth refresh", async () => {
    consumeCodexRateLimitResetCredit.mockResolvedValueOnce({ message: "unauthorized", status: 401 }).mockResolvedValueOnce({ ok: true });
    refreshAndUpdateCredentials.mockResolvedValue({ connection: { accessToken: "fresh" } });
    await consumeWithRefresh({ ...connection, refreshToken: "refresh" }, "same-id", {});
    expect(consumeCodexRateLimitResetCredit.mock.calls.map((call) => call[1])).toEqual(["same-id", "same-id"]);
    expect(consumeCodexRateLimitResetCredit.mock.calls[1][0]).toBe("fresh");
  });
});


describe("expiry timeout scheduling", () => {
  let state;
  const enabled = { codexAutoReset: { connections: { c1: true } } };
  beforeEach(() => { state = {}; });
  afterEach(() => { configureCodexAutoReset({}, deps, state); });

  it("waits until expiry minus 15 minutes without periodic fetches", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValue(credits(61));
    deps.consumeWithRefresh.mockImplementation(async () => {
      deps.getCodexRateLimitResetCredits.mockResolvedValue({ availableCount: 0, credits: [] });
      return { ok: true };
    });
    await configureCodexAutoReset(enabled, deps, state);
    await vi.advanceTimersByTimeAsync(45 * 60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(1);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(Date.now()).toBe(now + 46 * 60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("discovers new credits on the daily refresh and schedules their expiry", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValueOnce({ availableCount: 0, credits: [] }).mockResolvedValue(credits(1500));
    await configureCodexAutoReset(enabled, deps, state);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync((24 * 60 - 1) * 60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45 * 60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes long-lived credits daily and recalculates an earlier expiry", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValueOnce(credits(60 * 24 * 60)).mockResolvedValue(credits(24 * 60 + 20));
    await configureCodexAutoReset(enabled, deps, state);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("continues checking daily when there are no credits", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValue({ availableCount: 0, credits: [] });
    await configureCodexAutoReset(enabled, deps, state);
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(4);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reschedules when the credit's expiry has moved", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValueOnce(credits(16)).mockResolvedValue(credits(40));
    await configureCodexAutoReset(enabled, deps, state);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(23 * 60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("revalidates credits when the expiry timer fires", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValueOnce(credits(16)).mockResolvedValue({ availableCount: 0, credits: [] });
    await configureCodexAutoReset(enabled, deps, state);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
  });

  it("checks full quota every minute near expiry and applies when usage begins", async () => {
    deps.getCodexUsage.mockResolvedValueOnce({ quotas: { session: { used: 0 } } }).mockResolvedValue({ quotas: { session: { used: 5 } } });
    await configureCodexAutoReset(enabled, deps, state);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("retries failures after one minute with the same persisted redemption ID", async () => {
    deps.consumeWithRefresh.mockRejectedValueOnce(new Error("network failure"));
    await configureCodexAutoReset(enabled, deps, state);
    const id = connection.codexAutoResetPending.redeemRequestId;
    await vi.advanceTimersByTimeAsync(59999);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.consumeWithRefresh.mock.calls.map((call) => call[1])).toEqual([id, id]);
  });

  it("retries discovery failures after one minute", async () => {
    deps.getSettings.mockRejectedValueOnce(new Error("database unavailable"));
    await configureCodexAutoReset(enabled, deps, state);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("backs off when settings cannot be read at the scheduled deadline", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValue(credits(16));
    await configureCodexAutoReset(enabled, deps, state);
    deps.getSettings.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    const reads = deps.getSettings.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59999);
    expect(deps.getSettings).toHaveBeenCalledTimes(reads);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("rebuilds timers immediately after settings changes", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValue(credits(60));
    await configureCodexAutoReset(enabled, deps, state);
    deps.getCodexRateLimitResetCredits.mockResolvedValue(credits(16));
    await configureCodexAutoReset(enabled, deps, state);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.consumeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes the affected account immediately after manual apply", async () => {
    deps.getCodexRateLimitResetCredits.mockResolvedValueOnce(credits(16)).mockResolvedValue({ availableCount: 0, credits: [] });
    await configureCodexAutoReset(enabled, deps, state);
    state.invalidate("c1");
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
  });

  it("does not lose an invalidation received while checking", async () => {
    let release;
    deps.getCodexRateLimitResetCredits.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue({ availableCount: 0, credits: [] });
    const startup = configureCodexAutoReset(enabled, deps, state);
    // Wait until the discovery request is in flight, without advancing timers.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    state.invalidate("c1");
    release(credits(60));
    await startup;
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getCodexRateLimitResetCredits).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cancels timers when disabled, even if discovery is in flight", async () => {
    let release;
    deps.getCodexRateLimitResetCredits.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const startup = configureCodexAutoReset(enabled, deps, state);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    configureCodexAutoReset({}, deps, state);
    release(credits(60));
    await startup;
    expect(vi.getTimerCount()).toBe(0);
    expect(state.invalidate).toBeNull();
  });

  it("does not poll other accounts when one account needs frequent checks", async () => {
    const second = { ...connection, id: "c2", accessToken: "second-token" };
    const accounts = { c1: connection, c2: second };
    const bothEnabled = { codexAutoReset: { connections: { c1: true, c2: true } } };
    deps.getSettings.mockResolvedValue(bothEnabled);
    deps.getProviderConnections.mockResolvedValue([connection, second]);
    deps.getProviderConnectionById.mockImplementation(async (id) => accounts[id]);
    deps.getCodexConnection.mockImplementation(async (id) => ({ connection: accounts[id], proxyOptions: {} }));
    deps.refreshCodexConnection.mockImplementation(async (connection) => ({ connection }));
    deps.getCodexRateLimitResetCredits.mockImplementation(async (token) => credits(token === "second-token" ? 60 : 16));
    deps.getCodexUsage.mockResolvedValue({ quotas: { session: { used: 0 } } });
    await configureCodexAutoReset(bothEnabled, deps, state);
    await vi.advanceTimersByTimeAsync(2 * 60000);
    const tokens = deps.getCodexRateLimitResetCredits.mock.calls.map((call) => call[0]);
    expect(tokens.filter((token) => token === "second-token")).toHaveLength(1);
    expect(tokens.filter((token) => token === "token")).toHaveLength(3);
  });

  it("does not spend a credit if disabled while upstream reads are in flight", async () => {
    deps.getCodexUsage.mockImplementationOnce(async () => {
      deps.getSettings.mockResolvedValue({});
      configureCodexAutoReset({}, deps, state);
      return { quotas: { session: { used: 20 } } };
    });
    await configureCodexAutoReset(enabled, deps, state);
    expect(deps.consumeWithRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores invalid and expired dates when choosing the next wake-up", () => {
    expect(getNextCreditCheck({ availableCount: 1, credits: [{ status: "available", expiresAt: "bad" }] }, now)).toBe(now + 24 * 60 * 60000);
    expect(getNextCreditCheck(credits(-1), now)).toBe(now + 24 * 60 * 60000);
    expect(getNextCreditCheck(credits(16), now)).toBe(now + 60000);
    expect(getNextCreditCheck(credits(10), now)).toBe(now + 60000);
  });
});
