export const GENERATION_PROVIDER_ACCEPTANCE_BUNDLE =
  "fal-tos-2026-03-03-aup-captured-2026-07-30-v1" as const;
export const FAL_TERMS_URL =
  "https://fal.ai/legal/terms-of-service" as const;
export const FAL_AUP_URL =
  "https://fal.ai/legal/acceptable-use-policy" as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export type GenerationProviderAcceptanceStatus = Readonly<{
  eligible: boolean;
  bundleVersion: typeof GENERATION_PROVIDER_ACCEPTANCE_BUNDLE;
  acceptedAt: string | null;
}>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= days[month - 1]!;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    validCalendarDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseGenerationProviderAcceptanceStatus(
  value: unknown,
): GenerationProviderAcceptanceStatus {
  const row = object(value);
  if (
    !row ||
    !(
      hasExactKeys(row, [
        "ok",
        "eligible",
        "bundle_version",
        "accepted_at",
      ]) ||
      (row.eligible === false &&
        hasExactKeys(row, ["ok", "eligible", "bundle_version"]))
    ) ||
    row.ok !== true ||
    typeof row.eligible !== "boolean" ||
    row.bundle_version !== GENERATION_PROVIDER_ACCEPTANCE_BUNDLE
  ) {
    throw new Error("generation_provider_acceptance_response_invalid");
  }
  if (row.eligible) {
    if (!validTimestamp(row.accepted_at)) {
      throw new Error("generation_provider_acceptance_response_invalid");
    }
  } else if (row.accepted_at !== undefined && row.accepted_at !== null) {
    throw new Error("generation_provider_acceptance_response_invalid");
  }
  return {
    eligible: row.eligible,
    bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
    acceptedAt: row.eligible ? row.accepted_at as string : null,
  };
}

export type GenerationProviderAcceptanceAck = Readonly<{
  evidenceId: string;
  bundleVersion: typeof GENERATION_PROVIDER_ACCEPTANCE_BUNDLE;
  acceptedAt: string;
  idempotent: boolean;
}>;

export function parseGenerationProviderAcceptanceAck(
  value: unknown,
): GenerationProviderAcceptanceAck {
  const row = object(value);
  if (
    !row ||
    !hasExactKeys(row, [
      "ok",
      "eligible",
      "evidence_id",
      "bundle_version",
      "accepted_at",
      "idempotent",
    ]) ||
    row.ok !== true ||
    row.eligible !== true ||
    row.bundle_version !== GENERATION_PROVIDER_ACCEPTANCE_BUNDLE ||
    typeof row.evidence_id !== "string" ||
    !UUID_RE.test(row.evidence_id) ||
    !validTimestamp(row.accepted_at) ||
    typeof row.idempotent !== "boolean"
  ) {
    throw new Error("generation_provider_acceptance_response_invalid");
  }
  return {
    evidenceId: row.evidence_id,
    bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
    acceptedAt: row.accepted_at,
    idempotent: row.idempotent,
  };
}

export type GenerationProviderAcceptanceHttpAck = Readonly<{
  requestId: string;
  bundleVersion: typeof GENERATION_PROVIDER_ACCEPTANCE_BUNDLE;
  acceptedAt: string;
}>;

export function parseGenerationProviderAcceptanceHttpAck(
  value: unknown,
  expectedRequestId: string,
): GenerationProviderAcceptanceHttpAck {
  const row = object(value);
  if (
    !UUID_RE.test(expectedRequestId) ||
    !row ||
    !hasExactKeys(row, [
      "ok",
      "eligible",
      "requestId",
      "bundleVersion",
      "acceptedAt",
    ]) ||
    row.ok !== true ||
    row.eligible !== true ||
    row.requestId !== expectedRequestId ||
    row.bundleVersion !== GENERATION_PROVIDER_ACCEPTANCE_BUNDLE ||
    !validTimestamp(row.acceptedAt)
  ) {
    throw new Error("generation_provider_acceptance_response_invalid");
  }
  return {
    requestId: expectedRequestId,
    bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
    acceptedAt: row.acceptedAt,
  };
}

export function isGenerationProviderAcceptanceRequest(value: unknown): value is {
  requestId: string;
  adultSelfAttested: true;
  falTermsAccepted: true;
  falAupAccepted: true;
} {
  const row = object(value);
  return Boolean(
    row &&
      Object.keys(row).sort().join(",") ===
        "adultSelfAttested,falAupAccepted,falTermsAccepted,requestId" &&
      typeof row.requestId === "string" &&
      UUID_RE.test(row.requestId) &&
      row.adultSelfAttested === true &&
      row.falTermsAccepted === true &&
      row.falAupAccepted === true,
  );
}

type AcceptanceRpcClient = {
  rpc(
    name: "generation_provider_acceptance_status",
    args: { p_user_id: string },
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

export async function readGenerationProviderAcceptance(
  client: AcceptanceRpcClient,
  userId: string,
): Promise<GenerationProviderAcceptanceStatus> {
  if (!UUID_RE.test(userId)) {
    throw new Error("generation_provider_user_invalid");
  }
  const { data, error } = await client.rpc(
    "generation_provider_acceptance_status",
    { p_user_id: userId },
  );
  if (error) throw error;
  return parseGenerationProviderAcceptanceStatus(data);
}
