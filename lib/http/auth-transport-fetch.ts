import { readBoundedResponseBytes } from "./bounded-response.ts";
import {
  isDefinitiveHttpRejectionStatus,
} from "./definitive-http-rejection.ts";
import { OAUTH_FLOW_COOKIE_PREFIX } from "../cookies.ts";
import {
  isOAuthFlowId,
} from "../oauth-flow-lease.ts";
import {
  browserHasOAuthFlowDurableBarrier,
  readOAuthFlowBrowserBarrier,
} from "../oauth-flow-browser-barrier.ts";
import {
  readSupabaseAccessTokenIdentity,
} from "../supabase/session-cookie.ts";

export const AUTH_TRANSPORT_TIMEOUT_MS = 12_000;
export const AUTH_TRANSPORT_MAX_RESPONSE_BYTES = 1024 * 1024;
const OAUTH_CALLBACK_SCOPE_KEY = Symbol.for(
  "boss-paegi.oauth-callback-auth-transport.v2",
);
const OAUTH_CALLBACK_PKCE_BINDER_KEY = Symbol.for(
  "boss-paegi.oauth-callback-pkce-binder.v1",
);
const ACCESS_TOKEN_MAX_CHARS = 64 * 1024;

type OAuthCallbackTransportPhase =
  | "preflight"
  | "armed"
  | "pkce_validating"
  | "pkce_inflight"
  | "pkce_rejected"
  | "pkce_ok"
  | "refresh_armed"
  | "refresh_validating"
  | "refresh_inflight"
  | "refresh_rejected"
  | "refresh_ok"
  | "user_armed"
  | "user_inflight"
  | "consumed"
  | "poisoned_before_request"
  | "poisoned";

type OAuthCallbackTransportState = {
  version: 1;
  capabilityId: string;
  flowId: string;
  phase: OAuthCallbackTransportPhase;
  bearerDigest: string | null;
  authCodeDigest: string | null;
  codeVerifierDigest: string | null;
  refreshTokenDigest: string | null;
};

export type OAuthCallbackTransportCapability = Readonly<{
  capabilityId: string;
  flowId: string;
}>;

export type OAuthCallbackTargetEvidence = {
  userId: string;
  sessionId: string;
  accessTokenDigest: string;
  refreshTokenDigest: string;
};

export type OAuthCallbackTargetBinding =
  OAuthCallbackTargetEvidence & {
    accessToken: string;
    refreshToken: string;
  };

type OAuthCallbackPkceBinder = {
  capabilityId: string;
  bind: (
    binding: OAuthCallbackTargetBinding,
  ) => Promise<void>;
};

type OAuthCallbackPermittedRequest = {
  capabilityId: string;
  kind: "pkce" | "refresh" | "user";
};

const oauthCallbackGlobals =
  globalThis as unknown as Record<symbol, unknown>;
const OAUTH_CALLBACK_PHASES =
  new Set<OAuthCallbackTransportPhase>([
    "preflight",
    "armed",
    "pkce_validating",
    "pkce_inflight",
    "pkce_rejected",
    "pkce_ok",
    "refresh_armed",
    "refresh_validating",
    "refresh_inflight",
    "refresh_rejected",
    "refresh_ok",
    "user_armed",
    "user_inflight",
    "consumed",
    "poisoned_before_request",
    "poisoned",
  ]);

function validDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value)
  );
}

function currentPkceBinder(
  capabilityId: string,
): OAuthCallbackPkceBinder {
  const candidate = oauthCallbackGlobals[
    OAUTH_CALLBACK_PKCE_BINDER_KEY
  ] as Partial<OAuthCallbackPkceBinder> | undefined;
  if (
    !candidate ||
    candidate.capabilityId !== capabilityId ||
    typeof candidate.bind !== "function"
  ) {
    throw new Error("oauth_callback_target_binder_lost");
  }
  return candidate as OAuthCallbackPkceBinder;
}

function clearPkceBinder(capabilityId: string): void {
  const candidate = oauthCallbackGlobals[
    OAUTH_CALLBACK_PKCE_BINDER_KEY
  ] as Partial<OAuthCallbackPkceBinder> | undefined;
  if (
    candidate !== undefined &&
    candidate.capabilityId !== capabilityId
  ) {
    throw new Error("oauth_callback_target_binder_changed");
  }
  delete oauthCallbackGlobals[OAUTH_CALLBACK_PKCE_BINDER_KEY];
}

function rawNameCouldBeReservedOAuthMarker(
  rawName: string,
): boolean {
  let decodedPrefix = "";
  for (
    let index = 0;
    index < rawName.length &&
    decodedPrefix.length < OAUTH_FLOW_COOKIE_PREFIX.length;
    index += 1
  ) {
    if (rawName[index] !== "%") {
      decodedPrefix += rawName[index];
      continue;
    }
    const hex = rawName.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/iu.test(hex)) {
      // An invalid escape cannot complete a still-partial reserved prefix.
      // Fail closed only when the valid bytes before it already established
      // that this is a reserved marker name.
      return decodedPrefix.startsWith(
        OAUTH_FLOW_COOKIE_PREFIX,
      );
    }
    decodedPrefix += String.fromCharCode(
      Number.parseInt(hex, 16),
    );
    index += 2;
  }
  return (
    decodedPrefix.startsWith(OAUTH_FLOW_COOKIE_PREFIX) ||
    OAUTH_FLOW_COOKIE_PREFIX.startsWith(decodedPrefix)
  );
}

function currentOAuthCallbackState():
  OAuthCallbackTransportState | null {
  const state = oauthCallbackGlobals[
    OAUTH_CALLBACK_SCOPE_KEY
  ];
  if (state === undefined || state === null) return null;
  const candidate = state as Record<string, unknown>;
  if (
    typeof state !== "object" ||
    Array.isArray(state) ||
    candidate.version !== 1 ||
    typeof candidate.capabilityId !== "string" ||
    !isOAuthFlowId(
      candidate.capabilityId,
    ) ||
    !isOAuthFlowId(
      candidate.flowId,
    ) ||
    typeof candidate.phase !== "string" ||
    !OAUTH_CALLBACK_PHASES.has(
      candidate.phase as OAuthCallbackTransportPhase,
    ) ||
    !(
      candidate.bearerDigest === null ||
      validDigest(candidate.bearerDigest)
    ) ||
    !(
      candidate.authCodeDigest === null ||
      validDigest(candidate.authCodeDigest)
    ) ||
    !(
      candidate.codeVerifierDigest === null ||
      validDigest(candidate.codeVerifierDigest)
    ) ||
    !(
      candidate.refreshTokenDigest === null ||
      validDigest(candidate.refreshTokenDigest)
    )
  ) {
    throw new Error("oauth_callback_transport_state_invalid");
  }
  const phase =
    candidate.phase as OAuthCallbackTransportPhase;
  const hasPkceDigests =
    validDigest(candidate.authCodeDigest) &&
    validDigest(candidate.codeVerifierDigest) &&
    candidate.bearerDigest === null &&
    candidate.refreshTokenDigest === null;
  const hasRefreshDigest =
    validDigest(candidate.refreshTokenDigest) &&
    candidate.bearerDigest === null &&
    candidate.authCodeDigest === null &&
    candidate.codeVerifierDigest === null;
  const hasBearerDigest =
    validDigest(candidate.bearerDigest) &&
    candidate.authCodeDigest === null &&
    candidate.codeVerifierDigest === null &&
    candidate.refreshTokenDigest === null;
  const hasNoDigests =
    candidate.bearerDigest === null &&
    candidate.authCodeDigest === null &&
    candidate.codeVerifierDigest === null &&
    candidate.refreshTokenDigest === null;
  if (
    ((phase === "armed" ||
      phase === "pkce_validating" ||
      phase === "pkce_inflight") &&
      !hasPkceDigests) ||
    ((phase === "refresh_armed" ||
      phase === "refresh_validating" ||
      phase === "refresh_inflight") &&
      !hasRefreshDigest) ||
    ((phase === "user_armed" ||
      phase === "user_inflight") &&
      !hasBearerDigest) ||
    ((phase === "preflight" ||
      phase === "pkce_rejected" ||
      phase === "pkce_ok" ||
      phase === "refresh_rejected" ||
      phase === "refresh_ok" ||
      phase === "consumed" ||
      phase === "poisoned_before_request" ||
      phase === "poisoned") &&
      !hasNoDigests)
  ) {
    throw new Error("oauth_callback_transport_state_invalid");
  }
  return candidate as OAuthCallbackTransportState;
}

function setOAuthCallbackState(
  state: OAuthCallbackTransportState | null,
): void {
  oauthCallbackGlobals[OAUTH_CALLBACK_SCOPE_KEY] = state;
}

function exactCapabilityState(
  capability: OAuthCallbackTransportCapability,
): OAuthCallbackTransportState {
  const state = currentOAuthCallbackState();
  if (
    !state ||
    state.capabilityId !== capability.capabilityId ||
    state.flowId !== capability.flowId
  ) {
    throw new Error("oauth_callback_transport_capability_lost");
  }
  return state;
}

function visibleOAuthFlowCookies(): {
  name: string;
  value: string;
}[] {
  if (
    typeof document === "undefined" ||
    typeof document.cookie !== "string"
  ) {
    return [];
  }
  const markers: { name: string; value: string }[] = [];
  for (const entry of document.cookie.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const rawName =
      equals < 0 ? trimmed : trimmed.slice(0, equals);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // An unrelated malformed cookie is not an OAuth barrier. A malformed
      // reserved name is fail-closed.
      if (rawNameCouldBeReservedOAuthMarker(rawName)) {
        throw new Error("oauth_flow_marker_invalid");
      }
      continue;
    }
    if (!name.startsWith(OAUTH_FLOW_COOKIE_PREFIX)) continue;
    let value: string;
    try {
      value = decodeURIComponent(
        equals < 0 ? "" : trimmed.slice(equals + 1),
      );
    } catch {
      throw new Error("oauth_flow_marker_invalid");
    }
    markers.push({ name, value });
  }
  return markers;
}

export function visibleOAuthCallbackFlowMatches(
  flowId: string,
): boolean {
  if (!isOAuthFlowId(flowId)) return false;
  return readExactVisibleOAuthCallbackFlow() === flowId;
}

export function readExactVisibleOAuthCallbackFlow():
string | null {
  const markers = visibleOAuthFlowCookies();
  if (markers.length === 0) return null;
  if (
    markers.length !== 1 ||
    !isOAuthFlowId(markers[0].value) ||
    markers[0].name !==
      `${OAUTH_FLOW_COOKIE_PREFIX}${markers[0].value}`
  ) {
    throw new Error("oauth_flow_marker_invalid");
  }
  return markers[0].value;
}

export function browserHasVisibleOAuthFlowMarker(): boolean {
  return visibleOAuthFlowCookies().length > 0;
}

export function browserHasOAuthFlowMarker(): boolean {
  return (
    browserHasVisibleOAuthFlowMarker() ||
    browserHasOAuthFlowDurableBarrier()
  );
}

function exactVisibleOAuthFlow(flowId: string): boolean {
  if (!visibleOAuthCallbackFlowMatches(flowId)) return false;
  try {
    const durable = readOAuthFlowBrowserBarrier();
    return durable === null || durable === flowId;
  } catch {
    return false;
  }
}

export function oauthCallbackFlowBarrierMatches(
  flowId: string,
): boolean {
  return exactVisibleOAuthFlow(flowId);
}

/**
 * Creates one H-locked callback capability. Merely creating the scope never
 * permits Auth network: a successful server preflight must explicitly arm
 * the single PKCE request.
 */
export function beginOAuthCallbackTransportScope(
  flowId: string,
): OAuthCallbackTransportCapability {
  if (
    !isOAuthFlowId(flowId) ||
    !exactVisibleOAuthFlow(flowId)
  ) {
    throw new Error("oauth_callback_transport_marker_mismatch");
  }
  if (currentOAuthCallbackState() !== null) {
    throw new Error("oauth_callback_transport_scope_busy");
  }
  if (
    oauthCallbackGlobals[
      OAUTH_CALLBACK_PKCE_BINDER_KEY
    ] !== undefined
  ) {
    throw new Error("oauth_callback_target_binder_busy");
  }
  const capabilityId = crypto.randomUUID();
  if (!isOAuthFlowId(capabilityId)) {
    throw new Error("oauth_callback_transport_capability_invalid");
  }
  const capability = { capabilityId, flowId } as const;
  setOAuthCallbackState({
    version: 1,
    ...capability,
    phase: "preflight",
    bearerDigest: null,
    authCodeDigest: null,
    codeVerifierDigest: null,
    refreshTokenDigest: null,
  });
  return capability;
}

export async function armOAuthCallbackPkceTransport(
  capability: OAuthCallbackTransportCapability,
  authCode: string,
  codeVerifier: string,
  bindTarget: (
    binding: OAuthCallbackTargetBinding,
  ) => Promise<void>,
): Promise<void> {
  if (
    !/^[A-Za-z0-9._~-]{1,2048}$/u.test(authCode) ||
    !/^[A-Za-z0-9._~-]{32,512}$/u.test(codeVerifier) ||
    typeof bindTarget !== "function"
  ) {
    throw new Error("oauth_callback_transport_pkce_invalid");
  }
  const before = exactCapabilityState(capability);
  if (
    before.phase !== "preflight" ||
    !exactVisibleOAuthFlow(before.flowId)
  ) {
    throw new Error("oauth_callback_transport_not_armable");
  }
  const [authCodeDigest, codeVerifierDigest] =
    await Promise.all([
      sha256Base64Url(authCode),
      sha256Base64Url(codeVerifier),
    ]);
  const state = exactCapabilityState(capability);
  if (
    state.phase !== "preflight" ||
    !exactVisibleOAuthFlow(state.flowId)
  ) {
    throw new Error("oauth_callback_transport_state_changed");
  }
  setOAuthCallbackState({
    ...state,
    phase: "armed",
    authCodeDigest,
    codeVerifierDigest,
    refreshTokenDigest: null,
  });
  oauthCallbackGlobals[OAUTH_CALLBACK_PKCE_BINDER_KEY] = {
    capabilityId: capability.capabilityId,
    bind: bindTarget,
  } satisfies OAuthCallbackPkceBinder;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function targetEvidenceFromPkceResponse(
  response: Response,
  bytes: Uint8Array,
): Promise<OAuthCallbackTargetBinding> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    response.status !== 200 ||
    contentType !== "application/json"
  ) {
    throw new Error("oauth_callback_target_response_invalid");
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("oauth_callback_target_response_invalid");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("oauth_callback_target_response_invalid");
  }
  const record = value as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  const user = record.user;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    refreshToken.length > ACCESS_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(refreshToken) ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 31_536_000 ||
    record.token_type !== "bearer" ||
    user === null ||
    typeof user !== "object" ||
    Array.isArray(user)
  ) {
    throw new Error("oauth_callback_target_response_invalid");
  }
  const identity =
    readSupabaseAccessTokenIdentity(accessToken);
  const userRecord = user as Record<string, unknown>;
  if (
    !identity ||
    userRecord.id !== identity.userId ||
    userRecord.is_anonymous === true
  ) {
    throw new Error("oauth_callback_target_response_invalid");
  }
  const [accessTokenDigest, refreshTokenDigest] =
    await Promise.all([
      sha256Hex(accessToken),
      sha256Hex(refreshToken),
    ]);
  return {
    ...identity,
    accessToken,
    refreshToken,
    accessTokenDigest,
    refreshTokenDigest,
  };
}

export async function armOAuthRecoveryRefreshTransport(
  capability: OAuthCallbackTransportCapability,
  refreshToken: string,
): Promise<void> {
  if (
    refreshToken.length === 0 ||
    refreshToken.length > ACCESS_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(refreshToken)
  ) {
    throw new Error("oauth_recovery_refresh_token_invalid");
  }
  const before = exactCapabilityState(capability);
  if (
    before.phase !== "preflight" ||
    !exactVisibleOAuthFlow(before.flowId)
  ) {
    throw new Error("oauth_recovery_refresh_not_armable");
  }
  const refreshTokenDigest =
    await sha256Base64Url(refreshToken);
  const after = exactCapabilityState(capability);
  if (
    after.phase !== "preflight" ||
    !exactVisibleOAuthFlow(after.flowId)
  ) {
    throw new Error("oauth_callback_transport_state_changed");
  }
  setOAuthCallbackState({
    ...after,
    phase: "refresh_armed",
    bearerDigest: null,
    authCodeDigest: null,
    codeVerifierDigest: null,
    refreshTokenDigest,
  });
}

export async function armOAuthCallbackUserTransport(
  capability: OAuthCallbackTransportCapability,
  accessToken: string,
): Promise<void> {
  if (
    accessToken.length === 0 ||
    accessToken.length > ACCESS_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(accessToken)
  ) {
    throw new Error("oauth_callback_transport_token_invalid");
  }
  const before = exactCapabilityState(capability);
  if (
    (before.phase !== "pkce_ok" &&
      before.phase !== "refresh_ok") ||
    !exactVisibleOAuthFlow(before.flowId)
  ) {
    throw new Error("oauth_callback_transport_user_not_armable");
  }
  const bearerDigest = await sha256Base64Url(accessToken);
  const after = exactCapabilityState(capability);
  if (
    (after.phase !== "pkce_ok" &&
      after.phase !== "refresh_ok") ||
    !exactVisibleOAuthFlow(after.flowId)
  ) {
    throw new Error("oauth_callback_transport_state_changed");
  }
  setOAuthCallbackState({
    ...after,
    phase: "user_armed",
    bearerDigest,
    refreshTokenDigest: null,
  });
}

export function assertOAuthCallbackTransportConsumed(
  capability: OAuthCallbackTransportCapability,
): void {
  const state = exactCapabilityState(capability);
  if (
    state.phase !== "consumed" ||
    !exactVisibleOAuthFlow(state.flowId)
  ) {
    throw new Error("oauth_callback_transport_not_consumed");
  }
}

export function poisonOAuthCallbackTransportScope(
  capability: OAuthCallbackTransportCapability,
): void {
  const state = exactCapabilityState(capability);
  setOAuthCallbackState({
    ...state,
    phase: "poisoned",
    bearerDigest: null,
    authCodeDigest: null,
    codeVerifierDigest: null,
    refreshTokenDigest: null,
  });
}

export function oauthCallbackExchangeSafety(
  capability: OAuthCallbackTransportCapability,
):
  | "not_attempted"
  | "definitively_rejected"
  | "ambiguous_or_committed" {
  const state = exactCapabilityState(capability);
  if (
    state.phase === "preflight" ||
    state.phase === "armed" ||
    state.phase === "pkce_validating" ||
    state.phase === "refresh_armed" ||
    state.phase === "refresh_validating" ||
    state.phase === "poisoned_before_request"
  ) {
    return "not_attempted";
  }
  if (
    state.phase === "pkce_rejected" ||
    state.phase === "refresh_rejected"
  ) {
    return "definitively_rejected";
  }
  return "ambiguous_or_committed";
}

export function endOAuthCallbackTransportScope(
  capability: OAuthCallbackTransportCapability,
): void {
  exactCapabilityState(capability);
  clearPkceBinder(capability.capabilityId);
  setOAuthCallbackState(null);
}

/**
 * Callback Auth calls use the same exact SDK S lock, but cannot wait forever
 * while holding the origin-wide H lock. Ordinary app operations retain their
 * existing no-timeout policy.
 */
export function oauthCallbackLockAcquireTimeout(
  requestedTimeout: number,
): number {
  return currentOAuthCallbackState() !== null &&
    requestedTimeout < 0
    ? AUTH_TRANSPORT_TIMEOUT_MS
    : requestedTimeout;
}

type DeadlineSchedule = (
  callback: () => void,
  delayMs: number,
) => () => void;

const defaultSchedule: DeadlineSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

function requestUrl(
  input: RequestInfo | URL,
  fallbackBase: URL,
): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(
      String(input),
      typeof window !== "undefined" &&
        typeof window.location?.href === "string"
        ? window.location.href
        : fallbackBase,
    );
  } catch {
    return null;
  }
}

function authCookieSnapshot(storageKey: string): string | null {
  if (
    typeof document === "undefined" ||
    typeof document.cookie !== "string"
  ) {
    return null;
  }
  const entries = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => {
      const equals = entry.indexOf("=");
      const name = equals < 0 ? entry : entry.slice(0, equals);
      return name === storageKey || name.startsWith(`${storageKey}.`);
    })
    .sort();
  return entries.join(";");
}

function oauthFlowMarkerPresent(): boolean {
  return browserHasOAuthFlowMarker();
}

function requestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  return (
    init?.method ??
    (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function requestAuthorization(
  input: RequestInfo | URL,
  init?: RequestInit,
): string | null {
  const headers = new Headers(
    init?.headers ??
      (input instanceof Request ? input.headers : undefined),
  );
  return headers.get("authorization");
}

function requestContentType(
  input: RequestInfo | URL,
  init?: RequestInit,
): string | null {
  const headers = new Headers(
    init?.headers ??
      (input instanceof Request ? input.headers : undefined),
  );
  return headers.get("content-type");
}

function requestHasBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  return (
    (init?.body !== undefined && init.body !== null) ||
    (input instanceof Request && input.body !== null)
  );
}

function exactQuery(
  url: URL,
  expected: readonly [string, string][],
): boolean {
  const entries = [...url.searchParams.entries()];
  return (
    url.hash === "" &&
    entries.length === expected.length &&
    entries.every(
      ([key, value], index) =>
        key === expected[index][0] &&
        value === expected[index][1],
    )
  );
}

function exactPkceBody(
  init?: RequestInit,
): { authCode: string; codeVerifier: string } | null {
  if (
    typeof init?.body !== "string" ||
    init.body.length === 0 ||
    init.body.length > 4_096
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(init.body);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return null;
    }
    const body = value as Record<string, unknown>;
    const keys = Object.keys(body);
    if (
      keys.length !== 2 ||
      !keys.includes("auth_code") ||
      !keys.includes("code_verifier") ||
      typeof body.auth_code !== "string" ||
      typeof body.code_verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{1,2048}$/u.test(body.auth_code) ||
      !/^[A-Za-z0-9._~-]{32,512}$/u.test(
        body.code_verifier,
      )
    ) {
      return null;
    }
    const exact = {
      authCode: body.auth_code,
      codeVerifier: body.code_verifier,
    };
    return init.body ===
      JSON.stringify({
        auth_code: exact.authCode,
        code_verifier: exact.codeVerifier,
      })
      ? exact
      : null;
  } catch {
    return null;
  }
}

function exactRefreshBody(
  init?: RequestInit,
): string | null {
  if (
    typeof init?.body !== "string" ||
    init.body.length === 0 ||
    init.body.length > ACCESS_TOKEN_MAX_CHARS
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(init.body);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return null;
    }
    const body = value as Record<string, unknown>;
    if (
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, "refresh_token") ||
      typeof body.refresh_token !== "string" ||
      body.refresh_token.length === 0 ||
      body.refresh_token.length > ACCESS_TOKEN_MAX_CHARS ||
      /[\s\u0000-\u001f\u007f]/u.test(body.refresh_token) ||
      init.body !==
        JSON.stringify({
          refresh_token: body.refresh_token,
        })
    ) {
      return null;
    }
    return body.refresh_token;
  } catch {
    return null;
  }
}

function poisonPermittedRequest(
  permitted: OAuthCallbackPermittedRequest,
): void {
  const state = currentOAuthCallbackState();
  if (
    state &&
    state.capabilityId === permitted.capabilityId
  ) {
    const beforeRequest =
      (permitted.kind === "pkce" &&
        state.phase === "pkce_validating") ||
      (permitted.kind === "refresh" &&
        state.phase === "refresh_validating") ||
      state.phase === "poisoned_before_request";
    setOAuthCallbackState({
      ...state,
      phase: beforeRequest
        ? "poisoned_before_request"
        : "poisoned",
      bearerDigest: null,
      authCodeDigest: null,
      codeVerifierDigest: null,
      refreshTokenDigest: null,
    });
  }
}

async function claimOAuthCallbackRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: URL,
  authPrefix: URL,
): Promise<OAuthCallbackPermittedRequest> {
  const state = currentOAuthCallbackState();
  if (!state) {
    throw new TypeError(
      "auth_transport_blocked_by_oauth_flow",
    );
  }
  if (!exactVisibleOAuthFlow(state.flowId)) {
    setOAuthCallbackState({
      ...state,
      phase:
        state.phase === "preflight" ||
        state.phase === "armed" ||
        state.phase === "pkce_validating" ||
        state.phase === "refresh_armed" ||
        state.phase === "refresh_validating"
          ? "poisoned_before_request"
          : "poisoned",
      bearerDigest: null,
      authCodeDigest: null,
      codeVerifierDigest: null,
      refreshTokenDigest: null,
    });
    throw new TypeError(
      "auth_transport_blocked_by_oauth_flow",
    );
  }
  const tokenUrl = new URL("token", authPrefix);
  const userUrl = new URL("user", authPrefix);
  if (
    state.phase === "armed" &&
    requestMethod(input, init) === "POST" &&
    requestContentType(input, init) ===
      "application/json;charset=UTF-8" &&
    url.origin === tokenUrl.origin &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === tokenUrl.pathname &&
    exactQuery(url, [["grant_type", "pkce"]]) &&
    state.authCodeDigest !== null &&
    state.codeVerifierDigest !== null
  ) {
    const body = exactPkceBody(init);
    setOAuthCallbackState({
      ...state,
      phase: "pkce_validating",
    });
    const permitted = {
      capabilityId: state.capabilityId,
      kind: "pkce" as const,
    };
    if (!body) {
      poisonPermittedRequest(permitted);
      throw new TypeError(
        "oauth_callback_transport_pkce_body_invalid",
      );
    }
    const [authCodeDigest, codeVerifierDigest] =
      await Promise.all([
        sha256Base64Url(body.authCode),
        sha256Base64Url(body.codeVerifier),
      ]);
    const current = currentOAuthCallbackState();
    if (
      !current ||
      current.capabilityId !== state.capabilityId ||
      current.phase !== "pkce_validating" ||
      authCodeDigest !== state.authCodeDigest ||
      codeVerifierDigest !== state.codeVerifierDigest ||
      !exactVisibleOAuthFlow(state.flowId)
    ) {
      poisonPermittedRequest(permitted);
      throw new TypeError(
        "oauth_callback_transport_pkce_body_mismatch",
      );
    }
    setOAuthCallbackState({
      ...current,
      phase: "pkce_inflight",
    });
    return permitted;
  }
  if (
    state.phase === "refresh_armed" &&
    requestMethod(input, init) === "POST" &&
    requestContentType(input, init) ===
      "application/json;charset=UTF-8" &&
    url.origin === tokenUrl.origin &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === tokenUrl.pathname &&
    exactQuery(url, [["grant_type", "refresh_token"]]) &&
    state.refreshTokenDigest !== null
  ) {
    const refreshToken = exactRefreshBody(init);
    setOAuthCallbackState({
      ...state,
      phase: "refresh_validating",
    });
    const permitted = {
      capabilityId: state.capabilityId,
      kind: "refresh" as const,
    };
    if (refreshToken === null) {
      poisonPermittedRequest(permitted);
      throw new TypeError(
        "oauth_recovery_refresh_body_invalid",
      );
    }
    const refreshTokenDigest =
      await sha256Base64Url(refreshToken);
    const current = currentOAuthCallbackState();
    if (
      !current ||
      current.capabilityId !== state.capabilityId ||
      current.phase !== "refresh_validating" ||
      refreshTokenDigest !== state.refreshTokenDigest ||
      !exactVisibleOAuthFlow(state.flowId)
    ) {
      poisonPermittedRequest(permitted);
      throw new TypeError(
        "oauth_recovery_refresh_body_mismatch",
      );
    }
    setOAuthCallbackState({
      ...current,
      phase: "refresh_inflight",
    });
    return permitted;
  }
  if (
    state.phase === "user_armed" &&
    requestMethod(input, init) === "GET" &&
    !requestHasBody(input, init) &&
    url.origin === userUrl.origin &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === userUrl.pathname &&
    exactQuery(url, []) &&
    state.bearerDigest !== null
  ) {
    const authorization = requestAuthorization(input, init);
    setOAuthCallbackState({
      ...state,
      phase: "user_inflight",
    });
    const permitted = {
      capabilityId: state.capabilityId,
      kind: "user" as const,
    };
    if (
      authorization === null ||
      !authorization.startsWith("Bearer ") ||
      authorization.length <= "Bearer ".length
    ) {
      poisonPermittedRequest(permitted);
      throw new TypeError(
        "oauth_callback_transport_bearer_invalid",
      );
    }
    const actualDigest = await sha256Base64Url(
      authorization.slice("Bearer ".length),
    );
    const current = currentOAuthCallbackState();
    if (
      !current ||
      current.capabilityId !== state.capabilityId ||
      current.phase !== "user_inflight" ||
      actualDigest !== state.bearerDigest ||
      !exactVisibleOAuthFlow(state.flowId)
    ) {
      poisonPermittedRequest(permitted);
      throw new TypeError(
        "oauth_callback_transport_bearer_mismatch",
      );
    }
    return permitted;
  }
  setOAuthCallbackState({
    ...state,
    phase:
      state.phase === "preflight" ||
      state.phase === "armed" ||
      state.phase === "pkce_validating" ||
      state.phase === "refresh_armed" ||
      state.phase === "refresh_validating"
        ? "poisoned_before_request"
        : "poisoned",
    bearerDigest: null,
    authCodeDigest: null,
    codeVerifierDigest: null,
    refreshTokenDigest: null,
  });
  throw new TypeError(
    "auth_transport_blocked_by_oauth_flow",
  );
}

function settleOAuthCallbackRequest(
  permitted: OAuthCallbackPermittedRequest,
  response: Response,
): void {
  const state = currentOAuthCallbackState();
  const expectedPhase =
    permitted.kind === "pkce"
      ? "pkce_inflight"
      : permitted.kind === "refresh"
        ? "refresh_inflight"
        : "user_inflight";
  if (
    !state ||
    state.capabilityId !== permitted.capabilityId ||
    state.phase !== expectedPhase ||
    !exactVisibleOAuthFlow(state.flowId)
  ) {
    poisonPermittedRequest(permitted);
    throw new Error("oauth_callback_transport_request_lost");
  }
  setOAuthCallbackState({
    ...state,
    phase:
      response.status === 200
        ? permitted.kind === "pkce"
          ? "pkce_ok"
          : permitted.kind === "refresh"
            ? "refresh_ok"
            : "consumed"
        : permitted.kind === "refresh" &&
            isDefinitiveHttpRejectionStatus(response.status)
          ? "refresh_rejected"
        : permitted.kind === "pkce" &&
            isDefinitiveHttpRejectionStatus(response.status)
          ? "pkce_rejected"
        : "poisoned",
    bearerDigest: null,
    authCodeDigest: null,
    codeVerifierDigest: null,
    refreshTokenDigest: null,
  });
}

/**
 * Gives every Supabase Auth transport (including singleton initialization and
 * background refresh) a physical deadline. While an OAuth marker exists,
 * every Supabase-origin transport is blocked; only the callback capability's
 * exact PKCE and token-bound user requests can pass.
 *
 * A non-OK Auth response is also rejected when another tab replaced the auth
 * cookie during the request. auth-js classifies that fetch rejection as
 * retryable, so a stale `/user` or refresh-token failure cannot erase the
 * newer session. Cookie contents stay opaque and are never logged.
 */
export function createAuthTransportFetch(options: {
  supabaseUrl: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  schedule?: DeadlineSchedule;
}): typeof fetch {
  const baseUrl = new URL(options.supabaseUrl);
  const authPrefix = new URL("/auth/v1/", baseUrl);
  const storageKey = `sb-${baseUrl.hostname.split(".")[0]}-auth-token`;
  const timeoutMs = options.timeoutMs ?? AUTH_TRANSPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid_auth_transport_timeout");
  }
  const fetcher = options.fetcher ?? fetch;
  const schedule = options.schedule ?? defaultSchedule;

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input, baseUrl);
    if (!url || url.origin !== baseUrl.origin) {
      return fetcher(input, init);
    }
    let oauthCallbackRequest:
      | OAuthCallbackPermittedRequest
      | null = null;
    try {
      const callbackState = currentOAuthCallbackState();
      if (callbackState || oauthFlowMarkerPresent()) {
        if (
          url.origin !== authPrefix.origin ||
          !url.pathname.startsWith(authPrefix.pathname)
        ) {
          throw new TypeError(
            "supabase_transport_blocked_by_oauth_flow",
          );
        }
        oauthCallbackRequest =
          await claimOAuthCallbackRequest(
            input,
            init,
            url,
            authPrefix,
          );
      }
    } catch (error) {
      if (
        error instanceof TypeError &&
        (error.message ===
          "auth_transport_blocked_by_oauth_flow" ||
          error.message ===
            "supabase_transport_blocked_by_oauth_flow" ||
          error.message.startsWith(
            "oauth_callback_transport_",
          ) ||
          error.message.startsWith(
            "oauth_recovery_refresh_",
          ))
      ) {
        throw error;
      }
      throw new TypeError(
        "auth_transport_oauth_marker_unavailable",
        { cause: error },
      );
    }
    if (
      url.origin !== authPrefix.origin ||
      !url.pathname.startsWith(authPrefix.pathname)
    ) {
      return fetcher(input, init);
    }
    if (
      oauthCallbackRequest === null &&
      oauthFlowMarkerPresent()
    ) {
      throw new TypeError(
        "auth_transport_blocked_by_oauth_flow",
      );
    }

    const controller = new AbortController();
    const inputSignal =
      init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    let scheduledCancellation: (() => void) | null = null;
    let cancellationRequested = false;
    let cleaned = false;
    let inputListener: (() => void) | null = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (scheduledCancellation) {
        const cancel = scheduledCancellation;
        scheduledCancellation = null;
        cancel();
      } else {
        // A test scheduler is allowed to fire synchronously before returning
        // its cancellation handle. Remember that cleanup and cancel the
        // returned handle as soon as it becomes available.
        cancellationRequested = true;
      }
      if (inputSignal && inputListener) {
        inputSignal.removeEventListener("abort", inputListener);
        inputListener = null;
      }
    };
    const abortFrom = (signal: AbortSignal) => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason);
      }
    };

    // Arm cleanup before either an already-aborted owner or a synchronous
    // deadline scheduler can abort the composed signal.
    controller.signal.addEventListener("abort", cleanup, {
      once: true,
    });
    if (inputSignal) {
      inputListener = () => abortFrom(inputSignal);
      if (inputSignal.aborted) {
        inputListener();
      } else {
        inputSignal.addEventListener("abort", inputListener, {
          once: true,
        });
        if (inputSignal.aborted) inputListener();
      }
    }
    if (!controller.signal.aborted) {
      let scheduled: unknown;
      try {
        scheduled = schedule(() => {
          if (!controller.signal.aborted) {
            controller.abort(new Error("auth_transport_timeout"));
          }
        }, timeoutMs);
      } catch (error) {
        cleanup();
        return Promise.reject(error);
      }
      if (typeof scheduled !== "function") {
        cleanup();
        return Promise.reject(
          new Error("invalid_auth_transport_scheduler"),
        );
      }
      const cancelScheduled = scheduled as () => void;
      if (
        cancellationRequested ||
        cleaned ||
        controller.signal.aborted
      ) {
        try {
          cancelScheduled();
        } catch {
          // The original abort/scheduler failure remains authoritative.
        }
      } else {
        scheduledCancellation = cancelScheduled;
      }
    }
    if (controller.signal.aborted) {
      cleanup();
      return Promise.reject(
        controller.signal.reason ??
          new Error("auth_transport_aborted"),
      );
    }

    let before: string | null;
    try {
      before = authCookieSnapshot(storageKey);
    } catch {
      cleanup();
      return Promise.reject(
        new Error("auth_cookie_snapshot_unavailable"),
      );
    }

    return (async () => {
      try {
        const response = await fetcher(input, {
          ...init,
          ...(oauthCallbackRequest
            ? {
                credentials: "omit" as const,
                redirect: "error" as const,
                referrerPolicy: "no-referrer" as const,
                cache: "no-store" as const,
                mode: "cors" as const,
                keepalive: false,
              }
            : {}),
          signal: controller.signal,
        });
        const buffered = await readBoundedResponseBytes(
          response,
          AUTH_TRANSPORT_MAX_RESPONSE_BYTES,
          controller.signal,
        );
        if (!buffered.ok) {
          throw new Error(
            buffered.error === "too_large"
              ? "auth_response_too_large"
              : "auth_response_read_failed",
          );
        }
        if (!response.ok && before !== null) {
          let after: string | null;
          try {
            after = authCookieSnapshot(storageKey);
          } catch {
            throw new Error("auth_cookie_snapshot_unavailable");
          }
          if (after !== before) {
            throw new Error("auth_session_changed_during_request");
          }
        }
        if (
          oauthCallbackRequest?.kind === "pkce" &&
          response.status === 200
        ) {
          // The Auth response is fully drained and immutable, so its physical
          // network deadline no longer owns this operation. Keep the bytes
          // withheld from auth-js until the ledger durably binds the paired
          // target identity and hex digests; only then may SDK storage run.
          cleanup();
          const evidence =
            await targetEvidenceFromPkceResponse(
              response,
              buffered.bytes,
            );
          await currentPkceBinder(
            oauthCallbackRequest.capabilityId,
          ).bind(evidence);
          let afterBind: string | null;
          try {
            afterBind = authCookieSnapshot(storageKey);
          } catch {
            throw new Error(
              "auth_cookie_snapshot_unavailable",
            );
          }
          if (afterBind !== before) {
            // The target is already durably bound, so fail before auth-js can
            // overwrite a source or unrelated session that changed in flight.
            // Proof-bound recovery will revoke the exact bound target.
            throw new Error(
              "auth_session_changed_during_request",
            );
          }
        }
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        const bodyBytes =
          response.body === null ||
          response.status === 204 ||
          response.status === 205 ||
          response.status === 304
            ? null
            : buffered.bytes;
        let body: ArrayBuffer | null = null;
        if (bodyBytes) {
          const copied = new Uint8Array(bodyBytes.byteLength);
          copied.set(bodyBytes);
          body = copied.buffer;
        }
        if (oauthCallbackRequest) {
          settleOAuthCallbackRequest(
            oauthCallbackRequest,
            response,
          );
        }
        cleanup();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        if (oauthCallbackRequest) {
          poisonPermittedRequest(oauthCallbackRequest);
        }
        cleanup();
        throw error;
      }
    })();
  }) as typeof fetch;
}
