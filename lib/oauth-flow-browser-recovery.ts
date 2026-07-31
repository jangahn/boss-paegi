import {
  isOAuthFlowId,
  readOAuthFlowLease,
} from "./oauth-flow-lease.ts";
import {
  readOAuthFlowBrowserBarrier,
} from "./oauth-flow-browser-barrier.ts";

/**
 * Resolves the browser's live OAuth recovery destination without treating
 * either visible cookie state or localStorage as sole authority.
 *
 * Malformed, unavailable, or mutually inconsistent hints route through
 * proof/session discovery with no attacker-controlled flow ID. One exact
 * matching hint may route directly; no hint means ordinary work may continue
 * only after the caller's server discovery fence.
 */
export function resolveOAuthFlowBrowserRecoveryPath(
  cookieHeader: string,
): string | null {
  let visible: string | null;
  let durable: string | null;
  try {
    visible = readOAuthFlowLease(cookieHeader);
    durable = readOAuthFlowBrowserBarrier();
  } catch {
    return "/auth/flow-pending";
  }
  if (
    visible !== null &&
    durable !== null &&
    visible !== durable
  ) {
    return "/auth/flow-pending";
  }
  const flowId = durable ?? visible;
  return isOAuthFlowId(flowId)
    ? `/auth/flow-pending?flow=${encodeURIComponent(flowId)}`
    : null;
}
