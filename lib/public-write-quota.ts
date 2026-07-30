import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { SERVER_ENV } from "@/lib/env.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HeaderReader = Pick<Headers, "get">;

/**
 * Vercel overwrites x-forwarded-for at its public edge. Prefer its explicit
 * alias, then the standard aliases for local/preview runtimes. The address is
 * used only as an in-memory HMAC input and is never returned, logged, or
 * persisted.
 */
function networkActor(headers: HeaderReader): string | null {
  for (const name of [
    "x-vercel-forwarded-for",
    "x-forwarded-for",
    "x-real-ip",
  ]) {
    const first = headers.get(name)?.split(",", 1)[0]?.trim() ?? "";
    if (first && isIP(first) !== 0) return first.toLowerCase();
  }
  return null;
}

/**
 * Stable, opaque quota actor key.
 *
 * A caller may opt into an Auth subject only after the server has proved a
 * durable member row. Anonymous Auth UUIDs and pre-consent identities are
 * intentionally ignored because they are cheap to rotate; those callers use
 * the trusted edge address. A missing address shares one fail-safe bucket
 * instead of becoming unlimited.
 */
export function publicWriteActorKey(
  headers: HeaderReader,
  authSubjectId: string | null | undefined,
  trustAuthSubject: boolean,
  secret: string = SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
): string | null {
  if (!secret) return null;
  const subject =
    trustAuthSubject &&
    typeof authSubjectId === "string" &&
    UUID_RE.test(authSubjectId)
      ? `auth:${authSubjectId.toLowerCase()}`
      : `network:${networkActor(headers) ?? "unknown"}`;
  return createHmac("sha256", secret).update(subject, "utf8").digest("hex");
}

export function publicWriteNetworkActorKey(
  headers: HeaderReader,
  secret: string = SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
): string | null {
  return publicWriteActorKey(headers, null, false, secret);
}
