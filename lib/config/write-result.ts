export class InvalidConfigWriteResultError extends Error {
  constructor() {
    super("invalid_config_write_result");
    this.name = "InvalidConfigWriteResultError";
  }
}

/**
 * A successful PostgREST transport response is not enough: cache invalidation
 * may only follow the exact committed-RPC contract.
 */
export function parseConfigWriteResult(
  value: unknown,
  expectedKey: string,
): { version: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigWriteResultError();
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    keys.length !== 3 ||
    !keys.includes("ok") ||
    !keys.includes("key") ||
    !keys.includes("version") ||
    row.ok !== true ||
    row.key !== expectedKey ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 1
  ) {
    throw new InvalidConfigWriteResultError();
  }
  return { version: row.version as number };
}

export type ConfigWriteHttpAck = { ok: true; version: number };

/**
 * Browser acknowledgement for a CAS write. The exact next version binds the
 * response to the submitted snapshot and prevents malformed 2xx responses
 * from being presented as a successful publication.
 */
export function parseConfigWriteHttpAck(
  value: unknown,
  expectedBaseVersion: number,
): ConfigWriteHttpAck | null {
  if (
    !Number.isSafeInteger(expectedBaseVersion) ||
    expectedBaseVersion < 0 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    keys.length !== 2 ||
    !keys.includes("ok") ||
    !keys.includes("version") ||
    row.ok !== true ||
    !Number.isSafeInteger(row.version) ||
    row.version !== expectedBaseVersion + 1
  ) {
    return null;
  }
  return { ok: true, version: row.version as number };
}
