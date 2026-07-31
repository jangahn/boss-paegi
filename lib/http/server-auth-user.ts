import { readBoundedResponseBytes } from "./bounded-response.ts";

const USER_RESPONSE_MAX_BYTES = 512 * 1024;
const ACCESS_TOKEN_MAX_CHARS = 64 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ServerAuthUserResult =
  | {
      kind: "valid";
      user: Record<string, unknown> & {
        id: string;
        is_anonymous: boolean;
      };
    }
  | { kind: "invalid" }
  | { kind: "unavailable" };

/**
 * Validates a structurally read access token without creating an Auth client
 * or touching browser cookies. Both success and failure bodies are bounded;
 * transport failures/5xx remain retryable, while an authoritative 4xx is an
 * invalid credential.
 */
export async function readServerAuthUser(options: {
  accessToken: string;
  anonKey: string;
  signal: AbortSignal;
  supabaseUrl: string;
  fetcher?: typeof fetch;
}): Promise<ServerAuthUserResult> {
  if (
    options.accessToken.length === 0 ||
    options.accessToken.length > ACCESS_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(options.accessToken)
  ) {
    return { kind: "invalid" };
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      new URL("/auth/v1/user", options.supabaseUrl),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          apikey: options.anonKey,
          authorization: `Bearer ${options.accessToken}`,
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: options.signal,
      },
    );
  } catch {
    return { kind: "unavailable" };
  }
  let body;
  try {
    body = await readBoundedResponseBytes(
      response,
      USER_RESPONSE_MAX_BYTES,
      options.signal,
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (!body.ok) return { kind: "unavailable" };
  if (!response.ok) {
    return response.status === 401 || response.status === 403
      ? { kind: "invalid" }
      : { kind: "unavailable" };
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { kind: "unavailable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body.bytes),
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return { kind: "unavailable" };
  }
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    !UUID_RE.test(user.id) ||
    typeof user.is_anonymous !== "boolean"
  ) {
    return { kind: "unavailable" };
  }
  return {
    kind: "valid",
    user: user as Record<string, unknown> & {
      id: string;
      is_anonymous: boolean;
    },
  };
}
