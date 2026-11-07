import { getSettings, getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getCodexRateLimitResetCredits } from "open-sse/services/usage.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { getCodexConnection, refreshCodexConnection, consumeWithRefresh, withCodexResetLock, isAuthExpiredError } from "./codexResetCredits";
import { CODEX_AUTO_RESET_CONFIG as C } from "@/shared/constants/config";

const g = (global.__codexAutoReset ??= { timer: null, running: false });
// Upgrade an existing scheduler during Next hot reload.
if (g.interval) { clearInterval(g.interval); g.interval = null; }
const defaultDeps = {
  getSettings, getProviderConnections, getProviderConnectionById, updateProviderConnection,
  getCodexUsage, getCodexRateLimitResetCredits, getCodexConnection,
  refreshCodexConnection, consumeWithRefresh, withCodexResetLock,
};

export function hasExpiringCredit(details, now = Date.now()) {
  return details?.availableCount > 0 && details.credits?.some((credit) => {
    const expiry = Date.parse(credit.expiresAt);
    return credit.status === "available" && expiry > now && expiry <= now + C.expiryLeadMs;
  });
}

// Refresh daily to discover new credits, or sooner for a known expiry.
export function getNextCreditCheck(details, now = Date.now()) {
  const expiries = details?.availableCount > 0
    ? (details.credits || [])
      .filter((credit) => credit.status === "available")
      .map((credit) => Date.parse(credit.expiresAt))
      .filter((expiry) => Number.isFinite(expiry) && expiry > now)
    : [];
  if (!expiries.length) return now + C.discoveryIntervalMs;
  const due = Math.min(...expiries) - C.expiryLeadMs;
  return due <= now
    ? Math.min(now + C.retryIntervalMs, Math.min(...expiries))
    : Math.min(due, now + C.discoveryIntervalMs);
}

export function hasUsedQuota(usage) {
  return Object.values(usage?.quotas || {}).some((quota) =>
    quota?.unlimited !== true && typeof quota?.used === "number"
    && Number.isFinite(quota.used) && quota.used > 0
  );
}

async function applyIfDue(id, deps) {
  // Recheck after acquiring the same lock as manual apply.
  const settings = await deps.getSettings();
  if (settings?.codexAutoReset?.connections?.[id] !== true) return;
  const current = await deps.getProviderConnectionById(id);
  if (!current?.isActive || current.provider !== "codex"
    || !["oauth", "access_token"].includes(current.authType)) return;
  const resolved = await deps.getCodexConnection(id);
  if (resolved.response) throw new Error("Could not resolve Codex reset connection");
  let { connection, proxyOptions } = resolved;
  if (connection.authType === "oauth") {
    const refreshed = await deps.refreshCodexConnection(connection, proxyOptions);
    if (refreshed.response) throw new Error("Codex credential refresh failed");
    connection = refreshed.connection;
  }

  async function readCredits() {
    try {
      return await deps.getCodexRateLimitResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    } catch (error) {
      if (connection.authType !== "oauth" || !connection.refreshToken || !isAuthExpiredError(error)) throw error;
      const refreshed = await deps.refreshCodexConnection(connection, proxyOptions, true);
      if (refreshed.response) throw new Error("Codex credential refresh failed");
      connection = refreshed.connection;
      return deps.getCodexRateLimitResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    }
  }

  let pending = current.codexAutoResetPending;
  if (!pending) {
    const credits = await readCredits();
    if (!hasExpiringCredit(credits)) return getNextCreditCheck(credits);
    const usage = await deps.getCodexUsage(connection.accessToken, proxyOptions);
    if (!hasUsedQuota(usage) || !hasExpiringCredit(credits)) return getNextCreditCheck(credits);
    // Persist the ID so uncertain attempts can reuse it within the credit expiry.
    const expiresAt = credits.credits
      .filter((credit) => credit.status === "available" && Date.parse(credit.expiresAt) > Date.now())
      .map((credit) => credit.expiresAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    pending = { redeemRequestId: crypto.randomUUID(), createdAt: new Date().toISOString(), expiresAt };
    const saved = await deps.updateProviderConnection(id, { codexAutoResetPending: pending });
    if (!saved) throw new Error("Could not persist Codex redemption request");
  }

  // An unsent or uncertain attempt must never spend a different credit after expiry.
  if (!pending.applied && Date.parse(pending.expiresAt) <= Date.now()) {
    await deps.updateProviderConnection(id, { codexAutoResetPending: null });
    return getNextCreditCheck(await readCredits());
  }

  if (!pending.applied) {
    // Settings or activation may have changed while the upstream reads were in flight.
    const latestSettings = await deps.getSettings();
    const latestConnection = await deps.getProviderConnectionById(id);
    if (latestSettings?.codexAutoReset?.connections?.[id] !== true || !latestConnection?.isActive) return;
    const result = await deps.consumeWithRefresh(connection, pending.redeemRequestId, proxyOptions);
    if (!result.ok && !result.noCredit) throw new Error(result.message || `Reset failed (${result.code || result.status})`);
    if (result.noCredit) {
      await deps.updateProviderConnection(id, { codexAutoResetPending: null });
      return getNextCreditCheck(await readCredits());
    }
    pending = { ...pending, applied: true };
    await deps.updateProviderConnection(id, {
      codexAutoResetPending: pending,
      lastAutoResetAt: new Date().toISOString(),
    });
    console.log(`[CodexAutoReset] ${id}: reset applied`);
  }
  // Keep the completed request until both reads succeed, including across restarts.
  const credits = await readCredits();
  const usage = await deps.getCodexUsage(connection.accessToken, proxyOptions);
  if (!usage?.quotas) throw new Error("Could not refresh quota after reset");
  await deps.updateProviderConnection(id, { codexAutoResetPending: null });
  return getNextCreditCheck(credits);
}

function armNextCheck(deps, state) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!state.enabled) return;
  const now = Date.now();
  const next = state.refreshRequested ? now : (state.retryAt ?? Math.min(now + C.discoveryIntervalMs, ...state.nextChecks.values()));
  state.refreshRequested = false;
  if (!Number.isFinite(next)) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    // Long-lived credits can exceed Node's maximum timer delay. Chain timers
    // without fetching upstream until the actual deadline has arrived.
    if (Date.now() < next) armNextCheck(deps, state);
    else void runCodexAutoResetTick(deps, state);
  }, Math.min(C.maxTimeoutMs, Math.max(0, next - now)));
  state.timer.unref?.();
}

export async function runCodexAutoResetTick(deps = defaultDeps, state = g) {
  state.nextChecks ??= new Map();
  if (state.running) {
    state.refreshRequested = true;
    return;
  }
  state.running = true;
  try {
    const settings = await deps.getSettings();
    state.retryAt = null;
    const enabled = settings?.codexAutoReset?.connections || {};
    if (!Object.values(enabled).some((value) => value === true)) {
      state.nextChecks.clear();
      return;
    }
    const connections = await deps.getProviderConnections({ provider: "codex", isActive: true });
    const targets = connections.filter((connection) => enabled[connection.id] === true);
    const targetIds = new Set(targets.map((connection) => connection.id));
    for (const id of state.nextChecks.keys()) {
      if (!targetIds.has(id)) state.nextChecks.delete(id);
    }
    for (const connection of targets) {
      if (state.nextChecks.get(connection.id) > Date.now()) continue;
      try {
        const next = await deps.withCodexResetLock(connection.id, () => applyIfDue(connection.id, deps));
        state.nextChecks.set(connection.id, next ?? Date.now() + C.discoveryIntervalMs);
      } catch (error) {
        state.nextChecks.set(connection.id, Date.now() + C.retryIntervalMs);
        console.warn(`[CodexAutoReset] ${connection.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[CodexAutoReset] tick failed: ${error.message}`);
    // Retry failed reads or executions sooner than the daily refresh.
    state.retryAt = Date.now() + C.retryIntervalMs;
  } finally {
    state.running = false;
    if (state.refreshRequested) state.nextChecks.clear();
    armNextCheck(deps, state);
  }
}

export function configureCodexAutoReset(settings, deps = defaultDeps, state = g) {
  state.enabled = Object.values(settings?.codexAutoReset?.connections || {}).some((value) => value === true);
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.nextChecks ??= new Map();
  state.nextChecks.clear();
  state.retryAt = null;
  // Called by successful manual apply without importing the scheduler's provider graph.
  state.invalidate = state.enabled ? (id) => {
    state.nextChecks.delete(id);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    void runCodexAutoResetTick(deps, state);
  } : null;
  if (state.enabled) return runCodexAutoResetTick(deps, state);
}
