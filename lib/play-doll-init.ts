import {
  InvalidDollSignedUrlResponseError,
  parseDollSignedUrlResponse,
} from "./doll-signed-url-response.ts";
import type { RoleId } from "./roles/index.ts";

const PLAY_ROLE_IDS: ReadonlySet<unknown> = new Set([
  "boss",
  "exec",
  "teamlead",
  "client",
  "coworker",
]);

export class PlayDollInitError extends Error {
  readonly causeValue: unknown;

  constructor(reason: string, causeValue?: unknown) {
    super(reason);
    this.name = "PlayDollInitError";
    this.causeValue = causeValue;
  }
}

export type PlayDollRow = {
  image_url: string;
  role: RoleId;
};

/** Client Supabase maybeSingle 결과: 진짜 no-row와 resolved 장애를 구분한다. */
export function parsePlayDollLookup(
  data: unknown,
  error: unknown,
): PlayDollRow {
  if (error !== null && error !== undefined) {
    throw new PlayDollInitError("doll_lookup_failed", error);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new PlayDollInitError("doll_unavailable");
  }
  const row = data as Record<string, unknown>;
  if (
    typeof row.image_url !== "string" ||
    row.image_url.length === 0 ||
    row.image_url.trim() !== row.image_url ||
    !PLAY_ROLE_IDS.has(row.role)
  ) {
    throw new PlayDollInitError("invalid_doll_response");
  }
  return { image_url: row.image_url, role: row.role as RoleId };
}

/** Signed URL endpoint의 정확한 1-id acknowledgement를 플레이용 단일 URL로 축소. */
export function parsePlayDollSignedUrl(
  dollId: string,
  value: unknown,
): string {
  try {
    const parsed = parseDollSignedUrlResponse([dollId], value);
    const url = parsed.urls.get(dollId);
    if (!url || parsed.missingIds.has(dollId)) {
      throw new PlayDollInitError("doll_unavailable");
    }
    return url;
  } catch (error) {
    if (error instanceof PlayDollInitError) throw error;
    if (error instanceof InvalidDollSignedUrlResponseError) {
      throw new PlayDollInitError("invalid_signed_url_response", error);
    }
    throw error;
  }
}
