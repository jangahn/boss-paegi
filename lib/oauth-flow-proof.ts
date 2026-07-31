import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  isOAuthFlowId,
  OAUTH_FLOW_MAX_AGE_SECONDS,
} from "./oauth-flow-lease.ts";
import { OAUTH_FLOW_PROOF_COOKIE_PREFIX } from "./cookies.ts";
import { safeNext } from "./oauth-metadata.ts";

export { OAUTH_FLOW_PROOF_COOKIE_PREFIX } from "./cookies.ts";

const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLOCK_SKEW_MS = 5_000;
export const OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS =
  30 * 24 * 60 * 60;

export type OAuthFlowProvider = "kakao" | "google";

export type OAuthFlowProof = {
  flowId: string;
  sourceUserId: string;
  sourceSessionId: string;
  sourceIsAnonymous: boolean;
  provider: OAuthFlowProvider;
  expiresAt: number;
};

export type OAuthFlowPrepareRequest = {
  flowId: string;
  expectedUserId: string;
  expectedAnonymous: boolean;
  provider: OAuthFlowProvider;
  next: string;
};

function isProvider(value: unknown): value is OAuthFlowProvider {
  return value === "kakao" || value === "google";
}

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

export function parseOAuthFlowPrepareRequest(
  value: unknown,
): OAuthFlowPrepareRequest | null {
  if (
    !exactRecord(value, [
      "flowId",
      "expectedUserId",
      "expectedAnonymous",
      "provider",
      "next",
    ]) ||
    !isOAuthFlowId(value.flowId) ||
    typeof value.expectedUserId !== "string" ||
    !USER_ID_RE.test(value.expectedUserId) ||
    typeof value.expectedAnonymous !== "boolean" ||
    !isProvider(value.provider) ||
    typeof value.next !== "string" ||
    value.next.length > 2_048 ||
    safeNext(value.next) !== value.next
  ) {
    return null;
  }
  return {
    flowId: value.flowId,
    expectedUserId: value.expectedUserId,
    expectedAnonymous: value.expectedAnonymous,
    provider: value.provider,
    next: value.next,
  };
}

export function oauthFlowProofCookieName(flowId: string): string {
  if (!isOAuthFlowId(flowId)) {
    throw new Error("invalid_oauth_flow_id");
  }
  return `${OAUTH_FLOW_PROOF_COOKIE_PREFIX}${flowId}`;
}

function payload(proof: OAuthFlowProof): string {
  return [
    proof.flowId,
    proof.sourceUserId,
    proof.sourceSessionId,
    proof.sourceIsAnonymous ? "1" : "0",
    proof.provider,
    String(proof.expiresAt),
  ].join(".");
}

function mac(unsigned: string, secret: string): string {
  if (!secret) throw new Error("oauth_flow_proof_secret_missing");
  return createHmac("sha256", secret)
    .update(unsigned, "utf8")
    .digest("base64url");
}

export function signOAuthFlowProof(
  input: Omit<OAuthFlowProof, "expiresAt">,
  secret: string,
  now = Date.now(),
  expiresAt = now + OAUTH_FLOW_MAX_AGE_SECONDS * 1000,
): { value: string; proof: OAuthFlowProof } {
  if (
    !isOAuthFlowId(input.flowId) ||
    !USER_ID_RE.test(input.sourceUserId) ||
    !USER_ID_RE.test(input.sourceSessionId) ||
    !isProvider(input.provider) ||
    typeof input.sourceIsAnonymous !== "boolean" ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now - MAX_CLOCK_SKEW_MS ||
    expiresAt >
      now +
        OAUTH_FLOW_MAX_AGE_SECONDS * 1000 +
        MAX_CLOCK_SKEW_MS
  ) {
    throw new Error("invalid_oauth_flow_proof_input");
  }
  const proof: OAuthFlowProof = {
    ...input,
    expiresAt,
  };
  const unsigned = payload(proof);
  return {
    proof,
    value: `${unsigned}.${mac(unsigned, secret)}`,
  };
}

/**
 * Reissues signed browser authority after a partial response or long-lived
 * recovery. The caller chooses a bounded proof expiry only after an exact DB
 * row plus the current source/target session (or stored target token digest)
 * has been re-established server-side.
 */
export function signOAuthFlowRecoveryProof(
  input: Omit<OAuthFlowProof, "expiresAt">,
  secret: string,
  expiresAt: number,
  now = Date.now(),
): { value: string; proof: OAuthFlowProof } {
  if (
    !isOAuthFlowId(input.flowId) ||
    !USER_ID_RE.test(input.sourceUserId) ||
    !USER_ID_RE.test(input.sourceSessionId) ||
    !isProvider(input.provider) ||
    typeof input.sourceIsAnonymous !== "boolean" ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt >
      now +
        OAUTH_FLOW_MAX_AGE_SECONDS * 1000 +
        MAX_CLOCK_SKEW_MS ||
    now >
      expiresAt +
        OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS * 1000 +
        MAX_CLOCK_SKEW_MS
  ) {
    throw new Error("invalid_oauth_flow_recovery_proof_input");
  }
  const proof: OAuthFlowProof = { ...input, expiresAt };
  const unsigned = payload(proof);
  return {
    proof,
    value: `${unsigned}.${mac(unsigned, secret)}`,
  };
}

export function verifyOAuthFlowProof(
  value: string | null | undefined,
  expected: {
    flowId: string;
    provider: OAuthFlowProvider;
  },
  secret: string,
  now = Date.now(),
  allowExpired = false,
): OAuthFlowProof | null {
  if (
    !value ||
    !isOAuthFlowId(expected.flowId) ||
    !isProvider(expected.provider) ||
    !secret ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    return null;
  }
  const parts = value.split(".");
  if (parts.length !== 7) return null;
  const [
    flowId,
    sourceUserId,
    sourceSessionId,
    anonymousFlag,
    provider,
    rawExpiresAt,
    signature,
  ] = parts;
  const expiresAt = Number(rawExpiresAt);
  if (
    flowId !== expected.flowId ||
    provider !== expected.provider ||
    !isOAuthFlowId(flowId) ||
    !USER_ID_RE.test(sourceUserId) ||
    !USER_ID_RE.test(sourceSessionId) ||
    (anonymousFlag !== "0" && anonymousFlag !== "1") ||
    !isProvider(provider) ||
    !Number.isSafeInteger(expiresAt) ||
    (!allowExpired &&
      expiresAt < now - MAX_CLOCK_SKEW_MS) ||
    (allowExpired &&
      now >
        expiresAt +
          OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS * 1000 +
          MAX_CLOCK_SKEW_MS) ||
    expiresAt >
      now +
        OAUTH_FLOW_MAX_AGE_SECONDS * 1000 +
        MAX_CLOCK_SKEW_MS
  ) {
    return null;
  }
  const unsigned = parts.slice(0, 6).join(".");
  let actual: Buffer;
  let calculated: Buffer;
  try {
    const calculatedSignature = mac(unsigned, secret);
    if (
      signature.length !== calculatedSignature.length ||
      !/^[A-Za-z0-9_-]+$/u.test(signature)
    ) {
      return null;
    }
    actual = Buffer.from(signature, "ascii");
    calculated = Buffer.from(calculatedSignature, "ascii");
  } catch {
    return null;
  }
  if (
    actual.length !== calculated.length ||
    !timingSafeEqual(actual, calculated)
  ) {
    return null;
  }
  return {
    flowId,
    sourceUserId,
    sourceSessionId,
    sourceIsAnonymous: anonymousFlag === "1",
    provider,
    expiresAt,
  };
}

export function verifyOAuthFlowProofForRecovery(
  value: string | null | undefined,
  expected: {
    flowId: string;
    provider: OAuthFlowProvider;
  },
  secret: string,
  now = Date.now(),
): OAuthFlowProof | null {
  return verifyOAuthFlowProof(
    value,
    expected,
    secret,
    now,
    true,
  );
}

export function verifyOAuthFlowProofAnyProvider(
  value: string | null | undefined,
  flowId: string,
  secret: string,
  now = Date.now(),
): OAuthFlowProof | null {
  const kakao = verifyOAuthFlowProof(
    value,
    { flowId, provider: "kakao" },
    secret,
    now,
  );
  if (kakao) return kakao;
  return verifyOAuthFlowProof(
    value,
    { flowId, provider: "google" },
    secret,
    now,
  );
}

export function verifyOAuthFlowRecoveryProofAnyProvider(
  value: string | null | undefined,
  flowId: string,
  secret: string,
  now = Date.now(),
): OAuthFlowProof | null {
  const kakao = verifyOAuthFlowProofForRecovery(
    value,
    { flowId, provider: "kakao" },
    secret,
    now,
  );
  if (kakao) return kakao;
  return verifyOAuthFlowProofForRecovery(
    value,
    { flowId, provider: "google" },
    secret,
    now,
  );
}
