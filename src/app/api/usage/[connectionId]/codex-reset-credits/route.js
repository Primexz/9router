// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getCodexRateLimitResetCredits } from "open-sse/services/usage.js";
import { refreshAndUpdateCredentials } from "../route.js";

import { getCodexConnection, refreshCodexConnection, consumeWithRefresh, withCodexResetLock, isAuthExpiredError, notifyCodexResetApplied } from "@/shared/services/codexResetCredits";

function getResponseForConsumeResult(result, redeemRequestId) {
  if (result.ok) {
    return Response.json({
      code: result.code,
      reset: true,
      windows_reset: result.windowsReset,
      redeemRequestId,
      credit: result.raw?.credit || null,
    });
  }

  if (result.noCredit) {
    return Response.json({
      code: "no_credit",
      reset: false,
      windows_reset: result.windowsReset,
      message: "No Codex reset credits available.",
    }, { status: 409 });
  }

  return Response.json({
    code: result.code || "unknown_response",
    reset: false,
    windows_reset: result.windowsReset,
    message: result.message || "Codex reset credit consume returned an unexpected response.",
  }, { status: result.status >= 400 && result.status < 500 ? result.status : 502 });
}

export async function GET(_request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const resolved = await getCodexConnection(connectionId);
    if (resolved.response) return resolved.response;
    ({ connection } = resolved);
    const { isOAuth, proxyOptions } = resolved;

    if (isOAuth) {
      const refreshed = await refreshCodexConnection(connection, proxyOptions);
      if (refreshed.response) return refreshed.response;
      connection = refreshed.connection;
    }

    let result;
    try {
      result = await getCodexRateLimitResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    } catch (fetchError) {
      if (!isOAuth || !connection.refreshToken || !isAuthExpiredError(fetchError)) throw fetchError;
      const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
      connection = retryResult.connection;
      result = await getCodexRateLimitResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    }

    return Response.json(result);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Codex Reset Credits] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function applyManualReset(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const resolved = await getCodexConnection(connectionId);
    if (resolved.response) return resolved.response;
    ({ connection } = resolved);
    const { isOAuth, proxyOptions } = resolved;

    if (isOAuth) {
      const refreshed = await refreshCodexConnection(connection, proxyOptions);
      if (refreshed.response) return refreshed.response;
      connection = refreshed.connection;
    }

    // Server-generated redeem id prevents client-controlled replay
    const redeemRequestId = crypto.randomUUID();
    const consumeResult = await consumeWithRefresh(connection, redeemRequestId, proxyOptions);

    if (consumeResult.ok) notifyCodexResetApplied(connectionId);
    return getResponseForConsumeResult(consumeResult, redeemRequestId);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Codex Reset Credits] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, context) {
  const { connectionId } = await context.params;
  return withCodexResetLock(connectionId, () => applyManualReset(request, context));
}
