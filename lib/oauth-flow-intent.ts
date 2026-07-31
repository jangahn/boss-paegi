import {
  isOAuthFlowId,
} from "./oauth-flow-lease.ts";
import type {
  OAuthFlowProof,
  OAuthFlowProvider,
} from "./oauth-flow-proof.ts";

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

export function parseOAuthFlowBeginAck(
  value: unknown,
  flowId: string,
): { flowId: string; expiresAt: string } | null {
  if (
    !exactRecord(value, ["ok", "flowId", "expiresAt"]) ||
    value.ok !== true ||
    value.flowId !== flowId ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  return { flowId, expiresAt: value.expiresAt };
}

export function parseOAuthFlowClaimAck(
  value: unknown,
  expected: OAuthFlowProof,
): OAuthFlowProof | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "sourceUserId",
      "sourceSessionId",
      "sourceIsAnonymous",
      "provider",
    ]) ||
    value.ok !== true ||
    value.flowId !== expected.flowId ||
    value.sourceUserId !== expected.sourceUserId ||
    value.sourceSessionId !== expected.sourceSessionId ||
    value.sourceIsAnonymous !== expected.sourceIsAnonymous ||
    value.provider !== expected.provider
  ) {
    return null;
  }
  return expected;
}

export function parseOAuthFlowCancelAck(
  value: unknown,
  flowId: string,
): boolean {
  return (
    isOAuthFlowId(flowId) &&
    exactRecord(value, ["ok", "flowId", "outcome"]) &&
    value.ok === true &&
    value.flowId === flowId &&
    (value.outcome === "cancelled" || value.outcome === "absent")
  );
}

export function isOAuthFlowProvider(
  value: unknown,
): value is OAuthFlowProvider {
  return value === "kakao" || value === "google";
}
