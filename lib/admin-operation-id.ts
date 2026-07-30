import { createHash } from "node:crypto";

/**
 * Validate a DB timestamp without reserializing it through JavaScript's
 * millisecond-only Date representation. PostgreSQL lifecycle fences can carry
 * six fractional digits and must reach the exact timestamptz comparison.
 */
export function parseExactTimestampFence(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = value.trim();
  if (
    timestamp.length === 0 ||
    timestamp.length > 64 ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    return null;
  }
  return timestamp;
}

/**
 * JSON-compatible values are serialized with recursively sorted object keys.
 * The resulting UUID is only a routing key: the database also stores and
 * compares the complete jsonb payload, so even a digest collision fails closed
 * as idempotency_conflict instead of replaying another mutation.
 */
function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_operation_input");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("circular_operation_input");
    ancestors.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error("sparse_operation_input");
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("non_plain_operation_input");
    }
    if (ancestors.has(value)) throw new Error("circular_operation_input");
    ancestors.add(value);
    const row = value as Record<string, unknown>;
    try {
      const pairs = Object.keys(row)
        .filter((key) => row[key] !== undefined)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalJson(row[key], ancestors)}`,
        );
      return `{${pairs.join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error("non_json_operation_input");
}

export function deterministicAdminRequestId(
  operation: string,
  adminId: string,
  targetKey: string,
  payload: unknown,
): string {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        adminId,
        operation,
        payload,
        targetKey,
      }),
      "utf8",
    )
    .digest("hex");
  const chars = digest.slice(0, 32).split("");
  // RFC 9562 variant with a locally deterministic version-8 UUID.
  chars[12] = "8";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
