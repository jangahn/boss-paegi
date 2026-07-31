import "server-only";

import type { NextResponse } from "next/server";
import {
  OAUTH_FLOW_COOKIE_PREFIX,
  OAUTH_FLOW_PROOF_COOKIE_PREFIX,
} from "./cookies.ts";
import {
  oauthFlowProofCookieName,
  OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS,
  verifyOAuthFlowProof,
  verifyOAuthFlowProofForRecovery,
  type OAuthFlowProof,
  type OAuthFlowProvider,
} from "./oauth-flow-proof.ts";
import {
  isOAuthFlowId,
  oauthFlowCookieName,
} from "./oauth-flow-lease.ts";
import {
  parseRawCookieHeaderForPrefixes,
} from "./http/raw-cookie-header.ts";

export type OAuthFlowRouteAuthority = {
  markerPresent: boolean;
  proof: OAuthFlowProof;
  proofValue: string;
};

const OAUTH_FLOW_COOKIE_PREFIXES = [
  OAUTH_FLOW_COOKIE_PREFIX,
  OAUTH_FLOW_PROOF_COOKIE_PREFIX,
] as const;

/**
 * Discovers one proof-bound flow when the browser can no longer supply the
 * flow ID from its visible marker, URL, or durable barrier. Cookie names are
 * only routing hints: the returned authority exists only after the HttpOnly
 * value's HMAC, age, provider, and embedded flow ID all verify.
 */
export function discoverOAuthFlowRouteAuthority(options: {
  cookieHeader: string | null;
  recovery: boolean;
  secret: string;
}): OAuthFlowRouteAuthority | null {
  const parsed = parseRawCookieHeaderForPrefixes(
    options.cookieHeader,
    OAUTH_FLOW_COOKIE_PREFIXES,
  );
  if (parsed.kind !== "ok") return null;
  const markers = parsed.cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_COOKIE_PREFIX),
  );
  const proofs = parsed.cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_PROOF_COOKIE_PREFIX),
  );
  if (markers.length > 1 || proofs.length !== 1) return null;
  const flowId = proofs[0].name.slice(
    OAUTH_FLOW_PROOF_COOKIE_PREFIX.length,
  );
  if (!isOAuthFlowId(flowId)) return null;
  return readOAuthFlowRouteAuthority({
    cookieHeader: options.cookieHeader,
    flowId,
    recovery: options.recovery,
    secret: options.secret,
  });
}

export function readOAuthFlowRouteAuthority(options: {
  cookieHeader: string | null;
  flowId: string;
  provider?: OAuthFlowProvider;
  recovery: boolean;
  secret: string;
}): OAuthFlowRouteAuthority | null {
  if (!isOAuthFlowId(options.flowId)) return null;
  const parsed = parseRawCookieHeaderForPrefixes(
    options.cookieHeader,
    OAUTH_FLOW_COOKIE_PREFIXES,
  );
  if (parsed.kind !== "ok") return null;
  const markers = parsed.cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_COOKIE_PREFIX),
  );
  const proofs = parsed.cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_PROOF_COOKIE_PREFIX),
  );
  const expectedMarker = oauthFlowCookieName(options.flowId);
  const expectedProof = oauthFlowProofCookieName(options.flowId);
  if (
    markers.length > 1 ||
    proofs.length !== 1 ||
    markers.some(
      ({ name, value }) =>
        name !== expectedMarker || value !== options.flowId,
    ) ||
    proofs[0].name !== expectedProof
  ) {
    return null;
  }
  const verify = (
    provider: OAuthFlowProvider,
  ): OAuthFlowProof | null =>
    options.recovery
      ? verifyOAuthFlowProofForRecovery(
          proofs[0].value,
          { flowId: options.flowId, provider },
          options.secret,
        )
      : verifyOAuthFlowProof(
          proofs[0].value,
          { flowId: options.flowId, provider },
          options.secret,
        );
  const proof = options.provider
    ? verify(options.provider)
    : verify("kakao") ?? verify("google");
  return proof
    ? {
        markerPresent: markers.length === 1,
        proof,
        proofValue: proofs[0].value,
      }
    : null;
}

export function setOAuthFlowRecoveryCookies(
  response: NextResponse,
  authority: OAuthFlowRouteAuthority,
): void {
  const remainingSeconds = Math.max(
    0,
    Math.floor(
      (
        authority.proof.expiresAt +
          OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS * 1_000 -
        Date.now()
      ) / 1_000,
    ),
  );
  const options = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: remainingSeconds,
  };
  response.cookies.set(
    oauthFlowCookieName(authority.proof.flowId),
    authority.proof.flowId,
    { ...options, httpOnly: false },
  );
  response.cookies.set(
    oauthFlowProofCookieName(authority.proof.flowId),
    authority.proofValue,
    { ...options, httpOnly: true },
  );
}

export function clearOAuthFlowCookies(
  response: NextResponse,
  flowId: string,
): void {
  const options = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
  response.cookies.set(oauthFlowCookieName(flowId), "", {
    ...options,
    httpOnly: false,
  });
  response.cookies.set(oauthFlowProofCookieName(flowId), "", {
    ...options,
    httpOnly: true,
  });
}
