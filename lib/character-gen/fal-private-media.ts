import { readBoundedResponseBytes } from "../http/bounded-response.ts";
import {
  fetchMediaBlob,
  type DownloadedMedia,
} from "../media-download.ts";
import { isAllowedFalMediaUrl } from "./birefnet-contract.ts";

export const FAL_CDN_TOKEN_TTL_SECONDS = 5 * 60;
export const FAL_CDN_TOKEN_TIMEOUT_MS = 5_000;
export const FAL_CDN_TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;

const TOKEN_RE = /^[^\u0000-\u001f\u007f]{1,4096}$/;

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function mintFalCdnReadToken(args: {
  credentials: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!args.credentials) {
    throw new Error("fal_cdn_credentials_missing");
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(
    "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Key ${args.credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expiration_seconds: FAL_CDN_TOKEN_TTL_SECONDS,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(FAL_CDN_TOKEN_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`fal_cdn_token_http_${response.status}`);
  }
  const bounded = await readBoundedResponseBytes(
    response,
    FAL_CDN_TOKEN_RESPONSE_MAX_BYTES,
  );
  if (!bounded.ok) {
    throw new Error(`fal_cdn_token_${bounded.error}`);
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = exactObject(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
      ),
    );
  } catch {
    throw new Error("fal_cdn_token_invalid_json");
  }
  if (!payload || typeof payload.token !== "string" || !TOKEN_RE.test(payload.token)) {
    throw new Error("fal_cdn_token_invalid");
  }
  return payload.token;
}

/**
 * Download an output produced with `initial_acl.default=forbid`. The owner
 * credential is minted for five minutes and is never persisted or redirected
 * to another origin.
 */
export async function fetchPrivateFalMediaBlob(args: {
  url: string;
  credentials: string;
  kind: "image";
  maxBytes: number;
  signal?: AbortSignal;
  tokenFetchImpl?: typeof fetch;
  mediaFetchImpl?: typeof fetch;
}): Promise<DownloadedMedia> {
  if (!isAllowedFalMediaUrl(args.url)) {
    throw new Error("fal_private_media_url_invalid");
  }
  const token = await mintFalCdnReadToken({
    credentials: args.credentials,
    fetchImpl: args.tokenFetchImpl,
  });
  const mediaFetchImpl = args.mediaFetchImpl ?? fetch;
  return fetchMediaBlob(
    args.url,
    {
      kind: args.kind,
      maxBytes: args.maxBytes,
      signal: args.signal,
      redirect: "error",
    },
    (async (input, init) => {
      const target = new URL(String(input));
      if (!isAllowedFalMediaUrl(target.toString())) {
        throw new Error("fal_private_media_url_invalid");
      }
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return mediaFetchImpl(target, {
        ...init,
        headers,
        redirect: "error",
      });
    }) as typeof fetch,
  );
}
