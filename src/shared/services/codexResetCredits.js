// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { consumeCodexRateLimitResetCredit } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];

function isAuthExpiredResult(result) {
  const values = [result?.message, result?.code, result?.raw?.detail, result?.raw?.error]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return values.some((value) => AUTH_EXPIRED_PATTERNS.some((pattern) => value.includes(pattern)));
}

export function isAuthExpiredError(error) {
  return isAuthExpiredResult({ message: error?.message });
}

export async function getCodexConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    return { response: Response.json({ error: "Connection not found" }, { status: 404 }) };
  }

  if (connection.provider !== "codex") {
    return { response: Response.json({ error: "Codex reset credits are only available for Codex connections." }, { status: 400 }) };
  }

  const isOAuth = connection.authType === "oauth";
  const isAccessToken = connection.authType === "access_token";
  if (!isOAuth && !isAccessToken) {
    return { response: Response.json({ error: "Codex reset credits require an OAuth or access-token connection." }, { status: 400 }) };
  }

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  return { connection, isOAuth, proxyOptions };
}

export async function refreshCodexConnection(connection, proxyOptions, force = false) {
  try {
    const result = await refreshAndUpdateCredentials(connection, force, proxyOptions);
    return { connection: result.connection };
  } catch (refreshError) {
    console.error("[Codex Reset Credits API] Credential refresh failed:", refreshError);
    return { response: Response.json({ error: `Credential refresh failed: ${refreshError.message}` }, { status: 401 }) };
  }
}

export async function consumeWithRefresh(connection, redeemRequestId, proxyOptions) {
  let result = await consumeCodexRateLimitResetCredit(connection.accessToken, redeemRequestId, proxyOptions);
  if (connection.authType === "oauth" && connection.refreshToken && isAuthExpiredResult(result)) {
    try {
      const refreshed = await refreshAndUpdateCredentials(connection, true, proxyOptions);
      result = await consumeCodexRateLimitResetCredit(refreshed.connection.accessToken, redeemRequestId, proxyOptions);
    } catch (error) {
      console.warn(`[Codex Reset Credits] force refresh failed: ${error.message}`);
    }
  }
  return result;
}

// Shared by manual apply and the scheduler, including across Next hot reloads.
const locks = (global.__codexResetLocks ??= new Map());
export async function withCodexResetLock(id, action) {
  const previous = locks.get(id) || Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  locks.set(id, pending);
  try { return await pending; }
  finally { if (locks.get(id) === pending) locks.delete(id); }
}

export function notifyCodexResetApplied(connectionId) {
  global.__codexAutoReset?.invalidate?.(connectionId);
}
