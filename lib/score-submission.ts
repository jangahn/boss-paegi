import { createHash } from "node:crypto";

export type TelemetryOwnershipRow = {
  owner_id: string | null;
  is_anon: boolean;
  submitter_binding: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const REVIEW_STATUSES = new Set([
  "registered",
  "pending",
  "cleared",
  "voided",
]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type ScoreSubmissionRpcResult = {
  scoreId: string;
  reviewStatus: "registered" | "pending" | "cleared" | "voided";
  duplicate: boolean;
};

export function parseScoreSubmissionRpcResult(
  value: unknown,
): ScoreSubmissionRpcResult | null {
  if (!isJsonObject(value)) return null;
  if (
    typeof value.scoreId !== "string" ||
    !UUID_RE.test(value.scoreId) ||
    typeof value.reviewStatus !== "string" ||
    !REVIEW_STATUSES.has(value.reviewStatus) ||
    typeof value.duplicate !== "boolean"
  ) {
    return null;
  }
  return value as ScoreSubmissionRpcResult;
}

export type ScoreReportRpcResult = {
  personaId: string;
  percentile: number | null;
  newBadges: string[];
  collectedCount: number;
};

export function parseScoreReportRpcResult(
  value: unknown,
): ScoreReportRpcResult | null {
  if (!isJsonObject(value)) return null;
  const percentile = value.percentile;
  const newBadges = value.newBadges;
  if (
    typeof value.personaId !== "string" ||
    value.personaId.length < 1 ||
    value.personaId.length > 100 ||
    !(
      percentile === null ||
      (typeof percentile === "number" &&
        Number.isSafeInteger(percentile) &&
        percentile >= 1 &&
        percentile <= 100)
    ) ||
    !Array.isArray(newBadges) ||
    newBadges.length > 120 ||
    newBadges.some(
      (badge) =>
        typeof badge !== "string" ||
        badge.length < 1 ||
        badge.length > 40,
    ) ||
    new Set(newBadges).size !== newBadges.length ||
    !Number.isSafeInteger(value.collectedCount) ||
    (value.collectedCount as number) < 0 ||
    (value.collectedCount as number) > 120
  ) {
    return null;
  }
  return value as ScoreReportRpcResult;
}

export type ScoreSubmissionFingerprintInput = {
  dollId: string | null;
  score: number;
  weapon: string;
  durationMs: number;
  maxCombo: number;
  endReason: string;
  telemetrySessionId: string | null;
  gameplayStats: unknown;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non_finite_fingerprint_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported_fingerprint_value");
}

/**
 * Immutable normalized-request digest for one submission key. Doll/telemetry
 * IDs are the requested IDs, not the DB-dependent accepted links, so a row
 * becoming visible between response-loss retries cannot create self-conflict.
 * Dynamic percentile and live badge configuration are deliberately excluded:
 * the first successful report commit snapshots those values.
 */
export function scoreSubmissionFingerprint(
  input: ScoreSubmissionFingerprintInput,
): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

/**
 * Percentile is a dynamic, optional presentation snapshot. A dependency error
 * must not roll back an otherwise complete score report; it intentionally
 * commits `null`, unlike the badge catalog that defines durable grants.
 */
export async function readOptionalScorePercentile(
  read: () => PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<{ value: number | null; error: unknown | null }> {
  try {
    const result = await read();
    if (result.error) return { value: null, error: result.error };
    return {
      value:
        typeof result.data === "number" &&
        Number.isFinite(result.data) &&
        Number.isSafeInteger(result.data) &&
        result.data >= 1 &&
        result.data <= 100
          ? result.data
          : null,
      error: null,
    };
  } catch (error) {
    return { value: null, error };
  }
}

/**
 * Must remain byte-identical to `bp_telemetry_submitter_binding` in migration
 * 0074. UUID text is canonicalized because PostgreSQL `uuid::text` is lower
 * case even if an HTTP client submits upper-case hexadecimal.
 */
export function telemetrySubmitterBinding(
  sessionId: string,
  submitterId: string,
): string | null {
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(submitterId)) return null;
  return createHash("sha256")
    .update(`${sessionId.toLowerCase()}:${submitterId.toLowerCase()}`, "utf8")
    .digest("hex");
}

/**
 * Bounded rolling-deploy bridge for a cached pre-0074 browser.
 *
 * An old client has no per-game `submissionId`, but its telemetry UUID is
 * minted once per game and reused on HTTP retry. Deriving an RFC 4122-shaped
 * UUID from the exact Auth subject + requested telemetry UUID therefore gives
 * that request an exact-once key without allowing two users to collide.
 *
 * Returning null when either UUID is absent is deliberate: without a stable
 * client nonce, a response-loss retry and a second mathematically identical
 * game are observationally indistinguishable, so server-side random minting
 * cannot provide exact-once semantics.
 */
export function legacyTelemetryScoreSubmissionId(
  ownerId: string,
  telemetrySessionId: string | null,
): string | null {
  if (
    !UUID_RE.test(ownerId) ||
    !telemetrySessionId ||
    !UUID_RE.test(telemetrySessionId)
  ) {
    return null;
  }
  const bytes = createHash("sha256")
    .update(
      `legacy-score:${ownerId.toLowerCase()}:${telemetrySessionId.toLowerCase()}`,
      "utf8",
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Score↔telemetry ownership contract.
 *
 * - members: analytics owner is the exact Auth user and the row is non-anon;
 * - anonymous/pre-consent: analytics owner remains null, while a session-local
 *   digest proves possession by the exact Auth subject;
 * - every path requires the digest, so historical unbound rows safely degrade
 *   to "no telemetry" instead of becoming a cross-user capability.
 */
export function ownsTelemetrySession(
  row: TelemetryOwnershipRow,
  userId: string,
  isMember: boolean,
  sessionId: string,
): boolean {
  const expected = telemetrySubmitterBinding(sessionId, userId);
  if (
    expected === null ||
    !SHA256_HEX_RE.test(row.submitter_binding ?? "") ||
    row.submitter_binding !== expected
  ) {
    return false;
  }
  if (isMember) {
    return row.is_anon === false && row.owner_id === userId.toLowerCase();
  }
  return row.is_anon === true && row.owner_id === null;
}

/** PostgREST/SQL variants seen while additive column 0074 is rolling out. */
export function isMissingSubmitterBindingSchemaError(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  const code = error.code ?? "";
  const message = error.message ?? "";
  return (
    code === "42703" ||
    code === "PGRST204" ||
    (message.includes("submitter_binding") &&
      /column|schema cache|does not exist/i.test(message))
  );
}

/**
 * Additive app-first rollout only: PostgREST reports a not-yet-created RPC as
 * PGRST202 (schema cache) or Postgres 42883. No other database/permission error
 * may activate the legacy direct-write compatibility path.
 */
export function isMissingCommitScoreReportRpcError(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (!message.includes("commit_score_report")) return false;
  return (
    code === "PGRST202" ||
    code === "42883" ||
    /schema cache|does not exist|could not find the function/i.test(message)
  );
}
