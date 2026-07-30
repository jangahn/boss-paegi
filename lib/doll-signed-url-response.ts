export class InvalidDollSignedUrlResponseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidDollSignedUrlResponseError";
  }
}

function validSignedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * The endpoint must explicitly partition every requested id into a signed URL
 * or a row that disappeared during the query/sign race. Partial/malformed
 * acknowledgements are dependency failures, never default-image success.
 */
export function parseDollSignedUrlResponse(
  requestedIds: readonly string[],
  value: unknown,
): { urls: Map<string, string>; missingIds: Set<string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidDollSignedUrlResponseError("invalid_signed_url_response");
  }
  const response = value as Record<string, unknown>;
  if (
    !response.urls ||
    typeof response.urls !== "object" ||
    Array.isArray(response.urls) ||
    !Array.isArray(response.missingIds)
  ) {
    throw new InvalidDollSignedUrlResponseError("invalid_signed_url_response");
  }

  const requested = new Set(requestedIds);
  if (requested.size !== requestedIds.length) {
    throw new InvalidDollSignedUrlResponseError("duplicate_requested_id");
  }
  const urls = new Map<string, string>();
  for (const [id, url] of Object.entries(
    response.urls as Record<string, unknown>,
  )) {
    if (!requested.has(id) || !validSignedUrl(url) || urls.has(id)) {
      throw new InvalidDollSignedUrlResponseError("invalid_signed_url_entry");
    }
    urls.set(id, url);
  }

  const missingIds = new Set<string>();
  for (const id of response.missingIds) {
    if (
      typeof id !== "string" ||
      !requested.has(id) ||
      urls.has(id) ||
      missingIds.has(id)
    ) {
      throw new InvalidDollSignedUrlResponseError("invalid_missing_id");
    }
    missingIds.add(id);
  }
  for (const id of requested) {
    if (!urls.has(id) && !missingIds.has(id)) {
      throw new InvalidDollSignedUrlResponseError(
        "partial_signed_url_response",
      );
    }
  }
  return { urls, missingIds };
}
