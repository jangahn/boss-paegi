import { readBoundedClientJsonResponse } from "./client-mutation.ts";
import { OAUTH_FLOW_COOKIE_PREFIX } from "./cookies.ts";
import {
  parseRawCookieHeaderForPrefixes,
} from "./http/raw-cookie-header.ts";

export { OAUTH_FLOW_COOKIE_PREFIX } from "./cookies.ts";
export const OAUTH_FLOW_OWNER_KEY =
  "boss-paegi:oauth-flow-owner:v3";
export const OAUTH_FLOW_MAX_AGE_SECONDS = 10 * 60;
export const OAUTH_FLOW_CANCEL_TIMEOUT_MS = 8_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OAuthFlowLeaseError extends Error {
  readonly code:
    | "oauth_flow_already_active"
    | "oauth_flow_cookie_invalid"
    | "oauth_flow_cookie_unavailable"
    | "oauth_flow_owner_unavailable";

  constructor(
    code:
      | "oauth_flow_already_active"
      | "oauth_flow_cookie_invalid"
      | "oauth_flow_cookie_unavailable"
      | "oauth_flow_owner_unavailable",
  ) {
    super(code);
    this.name = "OAuthFlowLeaseError";
    this.code = code;
  }
}

export type OAuthFlowCookie = {
  name: string;
  value: string;
};

export type OAuthFlowLeaseEnvironment = {
  readCookie: () => string;
  readOwner: () => string | null;
  writeOwner: (value: string) => void;
  removeOwner: () => void;
  readDocumentId: () => string;
};

const DOCUMENT_ID_KEY = Symbol.for(
  "boss-paegi.oauth-flow-document-id.v1",
);

function browserDocumentId(): string {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const retained = globals[DOCUMENT_ID_KEY];
  if (typeof retained === "string" && isOAuthFlowId(retained)) {
    return retained;
  }
  const created = crypto.randomUUID();
  if (!isOAuthFlowId(created)) {
    throw new OAuthFlowLeaseError(
      "oauth_flow_owner_unavailable",
    );
  }
  globals[DOCUMENT_ID_KEY] = created;
  return created;
}

export function isOAuthFlowId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function oauthFlowCookieName(flowId: string): string {
  if (!isOAuthFlowId(flowId)) {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_invalid");
  }
  return `${OAUTH_FLOW_COOKIE_PREFIX}${flowId}`;
}

function parseCookieHeader(cookieHeader: string): OAuthFlowCookie[] {
  const parsed = parseRawCookieHeaderForPrefixes(
    cookieHeader,
    [OAUTH_FLOW_COOKIE_PREFIX],
  );
  if (parsed.kind !== "ok") {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_invalid");
  }
  return [...parsed.cookies];
}

/**
 * Reads only the server-issued, browser-visible coordination marker. The
 * callback authority is a separate HttpOnly HMAC proof plus a durable DB
 * claim; this marker contains no token, email, or verifier.
 */
export function readOAuthFlowLease(
  cookieHeader: string,
): string | null {
  const flowCookies = parseCookieHeader(cookieHeader).filter(
    ({ name }) => name.startsWith(OAUTH_FLOW_COOKIE_PREFIX),
  );
  if (flowCookies.length === 0) return null;
  if (flowCookies.length !== 1) {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_invalid");
  }
  const [{ name, value }] = flowCookies;
  const flowId = name.slice(OAUTH_FLOW_COOKIE_PREFIX.length);
  if (!isOAuthFlowId(flowId) || value !== flowId) {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_invalid");
  }
  return flowId;
}

export function browserOAuthFlowLeaseEnvironment():
  OAuthFlowLeaseEnvironment {
  return {
    readCookie: () => document.cookie,
    readOwner: () =>
      window.sessionStorage.getItem(OAUTH_FLOW_OWNER_KEY),
    writeOwner: (value) =>
      window.sessionStorage.setItem(OAUTH_FLOW_OWNER_KEY, value),
    removeOwner: () =>
      window.sessionStorage.removeItem(OAUTH_FLOW_OWNER_KEY),
    readDocumentId: browserDocumentId,
  };
}

function ownerRecord(
  flowId: string,
  documentId: string,
): string {
  return JSON.stringify({ flowId, documentId });
}

function readOwnedFlowId(
  environment: OAuthFlowLeaseEnvironment,
): string | null {
  const raw = environment.readOwner();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  const documentId = environment.readDocumentId();
  return (
    keys.length === 2 &&
    keys.includes("flowId") &&
    keys.includes("documentId") &&
    isOAuthFlowId(value.flowId) &&
    isOAuthFlowId(value.documentId) &&
    value.documentId === documentId
  )
    ? value.flowId
    : null;
}

/**
 * Records same-tab ownership only after the browser proves it received the
 * server response and its visible marker. It never creates callback
 * authority client-side.
 */
export function rememberOAuthFlowLease(
  flowId: string,
  environment: OAuthFlowLeaseEnvironment =
    browserOAuthFlowLeaseEnvironment(),
): void {
  if (!isOAuthFlowId(flowId)) {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_invalid");
  }
  let current: string | null;
  try {
    current = readOAuthFlowLease(environment.readCookie());
  } catch (error) {
    if (error instanceof OAuthFlowLeaseError) throw error;
    throw new OAuthFlowLeaseError("oauth_flow_cookie_unavailable");
  }
  if (current !== flowId) {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_unavailable");
  }
  try {
    const documentId = environment.readDocumentId();
    const record = ownerRecord(flowId, documentId);
    environment.writeOwner(record);
    if (readOwnedFlowId(environment) !== flowId) {
      throw new OAuthFlowLeaseError(
        "oauth_flow_owner_unavailable",
      );
    }
  } catch (error) {
    if (error instanceof OAuthFlowLeaseError) throw error;
    throw new OAuthFlowLeaseError("oauth_flow_owner_unavailable");
  }
}

export function forgetOAuthFlowLease(
  flowId: string,
  environment: OAuthFlowLeaseEnvironment =
    browserOAuthFlowLeaseEnvironment(),
): void {
  if (!isOAuthFlowId(flowId)) {
    throw new OAuthFlowLeaseError("oauth_flow_cookie_invalid");
  }
  try {
    if (readOwnedFlowId(environment) !== flowId) return;
    environment.removeOwner();
    if (readOwnedFlowId(environment) !== null) {
      throw new OAuthFlowLeaseError(
        "oauth_flow_owner_unavailable",
      );
    }
  } catch (error) {
    if (error instanceof OAuthFlowLeaseError) throw error;
    throw new OAuthFlowLeaseError("oauth_flow_owner_unavailable");
  }
}

function exactCancelAck(
  value: unknown,
  flowId: string,
): "cancelled" | "expired" | "absent" | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const keys = Object.keys(value);
  const ack = value as Record<string, unknown>;
  return (
    keys.length === 3 &&
    keys.includes("ok") &&
    keys.includes("flowId") &&
    keys.includes("outcome") &&
    ack.ok === true &&
    ack.flowId === flowId &&
    (ack.outcome === "cancelled" ||
      ack.outcome === "expired" ||
      ack.outcome === "absent")
  )
    ? ack.outcome
    : null;
}

async function deliverCancelReceipt(
  flowId: string,
  options: {
    environment: OAuthFlowLeaseEnvironment;
    fetcher: typeof fetch;
    provider: "kakao" | "google";
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const hardDeadline = AbortSignal.timeout(
    OAUTH_FLOW_CANCEL_TIMEOUT_MS,
  );
  const timeoutSignal = options.signal
    ? AbortSignal.any([options.signal, hardDeadline])
    : hardDeadline;
  try {
    const response = await options.fetcher(
      "/api/auth/oauth-flow/cancel",
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          flowId,
          provider: options.provider,
        }),
        signal: timeoutSignal,
      },
    );
    const body = await readBoundedClientJsonResponse(
      response,
      timeoutSignal,
    );
    if (
      !response.ok ||
      !body.ok ||
      exactCancelAck(body.value, flowId) === null
    ) {
      return false;
    }
    const current = readOAuthFlowLease(
      options.environment.readCookie(),
    );
    if (current === flowId) return false;
    if (readOwnedFlowId(options.environment) === flowId) {
      options.environment.removeOwner();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Server-first compare-and-cancel. The route atomically cancels only a
 * pending DB intent and expires the exact marker plus HttpOnly proof. Owner
 * storage is removed only after that acknowledgement and cookie delivery.
 */
export async function cancelOAuthFlowLease(
  flowId: string,
  options: {
    provider: "kakao" | "google";
    environment?: OAuthFlowLeaseEnvironment;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  if (!isOAuthFlowId(flowId)) return false;
  const environment =
    options.environment ?? browserOAuthFlowLeaseEnvironment();
  const fetcher = options.fetcher ?? fetch;
  return deliverCancelReceipt(flowId, {
    environment,
    fetcher,
    provider: options.provider,
    signal: options.signal,
  });
}

export function matchesOAuthFlowLease(
  flowId: string | null,
  cookies: readonly OAuthFlowCookie[],
): flowId is string {
  if (!isOAuthFlowId(flowId)) return false;
  const expectedName = oauthFlowCookieName(flowId);
  const flowCookies = cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_COOKIE_PREFIX),
  );
  return (
    flowCookies.length === 1 &&
    flowCookies[0].name === expectedName &&
    flowCookies[0].value === flowId
  );
}
