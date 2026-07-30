import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_CRON_SECRET_BYTES = 4096;

/**
 * Compare scheduler credentials through fixed-size digests. Header length is
 * attacker-visible, but neither an early string mismatch nor a prefix match
 * can leak the configured secret.
 */
export function cronSecretMatches(
  received: string | null,
  expected: string,
): boolean {
  if (
    received === null ||
    expected.length === 0 ||
    Buffer.byteLength(received, "utf8") > MAX_CRON_SECRET_BYTES ||
    Buffer.byteLength(expected, "utf8") > MAX_CRON_SECRET_BYTES
  ) {
    return false;
  }
  const actualDigest = createHash("sha256")
    .update(received, "utf8")
    .digest();
  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
