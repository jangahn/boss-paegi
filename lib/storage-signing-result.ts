export class StorageSigningError extends Error {
  readonly operation: string;
  readonly causeValue: unknown;

  constructor(operation: string, causeValue: unknown) {
    super(`${operation} failed`);
    this.name = "StorageSigningError";
    this.operation = operation;
    this.causeValue = causeValue;
  }
}

function validSignedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Only an absent source object may resolve to null. A present object whose
 * signing call fails or acknowledges malformed data is an unavailable
 * dependency, never permission to render a different/default asset.
 */
export function resolveStorageSigningResult(
  operation: string,
  source: string | null | undefined,
  result:
    | {
        data?: { signedUrl?: unknown } | null;
        error?: unknown;
      }
    | undefined,
): string | null {
  if (source === null || source === undefined) return null;
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source !== source.trim()
  ) {
    throw new StorageSigningError(operation, new Error("invalid_source_path"));
  }
  if (
    !result ||
    (result.error !== null && result.error !== undefined) ||
    !validSignedUrl(result.data?.signedUrl)
  ) {
    throw new StorageSigningError(
      operation,
      result?.error ?? new Error("invalid_signed_url_response"),
    );
  }
  return result.data.signedUrl;
}
