export const PRIVACY_RETENTION_LIMIT = 100;
export const PRIVACY_RETENTION_COUNT_CAP = 1000;
export const COMMERCE_DISPLAY_RETENTION_LIMIT = 100;
export const EXTERNAL_COMPLAINT_MANUAL_BOUNDARY =
  "external_consumer_complaint_manual_retention_runbook" as const;

export type PrivacyRetentionResult = {
  ok: boolean;
  processed: number;
  errors: number;
  paymentProcessed: number;
  paymentErrors: number;
  contentReportProcessed: number;
  contentReportErrors: number;
  paymentReady: number;
  paymentReadyCapped: boolean;
  paymentBlocked: number;
  paymentBlockedCapped: boolean;
  paymentFailures: number;
  paymentFailuresCapped: boolean;
  contentReportReady: number;
  contentReportReadyCapped: boolean;
  contentReportBlocked: number;
  contentReportBlockedCapped: boolean;
  contentReportFailures: number;
  contentReportFailuresCapped: boolean;
  contentReportOpen: number;
  contentReportOpenCapped: boolean;
  consumerDisputeSourceMapped: true;
  consumerDisputeBacklog: number;
  consumerDisputeBacklogCapped: boolean;
  legalBlockers: [];
  externalBoundaries: [typeof EXTERNAL_COMPLAINT_MANUAL_BOUNDARY];
};

function count(value: unknown, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}

/** Exact fail-closed shape for the retention SECURITY DEFINER RPC. */
export function parsePrivacyRetentionResult(
  value: unknown,
  limit = PRIVACY_RETENTION_LIMIT,
): PrivacyRetentionResult | null {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PRIVACY_RETENTION_LIMIT ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    "consumer_dispute_backlog",
    "consumer_dispute_backlog_capped",
    "consumer_dispute_source_mapped",
    "content_report_blocked",
    "content_report_blocked_capped",
    "content_report_errors",
    "content_report_failures",
    "content_report_failures_capped",
    "content_report_open",
    "content_report_open_capped",
    "content_report_processed",
    "content_report_ready",
    "content_report_ready_capped",
    "errors",
    "external_boundaries",
    "legal_blockers",
    "ok",
    "payment_blocked",
    "payment_blocked_capped",
    "payment_errors",
    "payment_failures",
    "payment_failures_capped",
    "payment_processed",
    "payment_ready",
    "payment_ready_capped",
    "processed",
  ];
  const keys = Object.keys(row).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof row.ok !== "boolean" ||
    !count(row.processed, limit) ||
    !count(row.errors, limit) ||
    !count(row.payment_processed, limit) ||
    !count(row.payment_errors, limit) ||
    !count(row.content_report_processed, limit) ||
    !count(row.content_report_errors, limit) ||
    (row.processed as number) + (row.errors as number) > limit ||
    row.processed !==
      (row.payment_processed as number) +
        (row.content_report_processed as number) ||
    row.errors !==
      (row.payment_errors as number) + (row.content_report_errors as number) ||
    !count(row.payment_ready, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.payment_ready_capped !== "boolean" ||
    !count(row.payment_blocked, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.payment_blocked_capped !== "boolean" ||
    !count(row.payment_failures, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.payment_failures_capped !== "boolean" ||
    !count(row.content_report_ready, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.content_report_ready_capped !== "boolean" ||
    !count(row.content_report_blocked, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.content_report_blocked_capped !== "boolean" ||
    !count(row.content_report_failures, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.content_report_failures_capped !== "boolean" ||
    !count(row.content_report_open, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.content_report_open_capped !== "boolean" ||
    row.consumer_dispute_source_mapped !== true ||
    !count(row.consumer_dispute_backlog, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.consumer_dispute_backlog_capped !== "boolean" ||
    !Array.isArray(row.legal_blockers) ||
    row.legal_blockers.length !== 0 ||
    !Array.isArray(row.external_boundaries) ||
    row.external_boundaries.length !== 1 ||
    row.external_boundaries[0] !== EXTERNAL_COMPLAINT_MANUAL_BOUNDARY ||
    (row.ok && row.errors !== 0) ||
    (!row.ok && row.errors === 0)
  ) {
    return null;
  }
  return {
    ok: row.ok,
    processed: row.processed,
    errors: row.errors,
    paymentProcessed: row.payment_processed,
    paymentErrors: row.payment_errors,
    contentReportProcessed: row.content_report_processed,
    contentReportErrors: row.content_report_errors,
    paymentReady: row.payment_ready,
    paymentReadyCapped: row.payment_ready_capped,
    paymentBlocked: row.payment_blocked,
    paymentBlockedCapped: row.payment_blocked_capped,
    paymentFailures: row.payment_failures,
    paymentFailuresCapped: row.payment_failures_capped,
    contentReportReady: row.content_report_ready,
    contentReportReadyCapped: row.content_report_ready_capped,
    contentReportBlocked: row.content_report_blocked,
    contentReportBlockedCapped: row.content_report_blocked_capped,
    contentReportFailures: row.content_report_failures,
    contentReportFailuresCapped: row.content_report_failures_capped,
    contentReportOpen: row.content_report_open,
    contentReportOpenCapped: row.content_report_open_capped,
    consumerDisputeSourceMapped: true,
    consumerDisputeBacklog: row.consumer_dispute_backlog,
    consumerDisputeBacklogCapped: row.consumer_dispute_backlog_capped,
    legalBlockers: [],
    externalBoundaries: [EXTERNAL_COMPLAINT_MANUAL_BOUNDARY],
  };
}

export function privacyRetentionNeedsRetry(
  result: PrivacyRetentionResult,
  limit = PRIVACY_RETENTION_LIMIT,
): boolean {
  return (
    result.processed + result.errors >= limit ||
    result.paymentReady > 0 ||
    result.paymentReadyCapped ||
    result.paymentBlocked > 0 ||
    result.paymentBlockedCapped ||
    result.paymentFailures > 0 ||
    result.paymentFailuresCapped ||
    result.contentReportReady > 0 ||
    result.contentReportReadyCapped ||
    result.contentReportBlocked > 0 ||
    result.contentReportBlockedCapped ||
    result.contentReportFailures > 0 ||
    result.contentReportFailuresCapped
  );
}

export type CommerceDisplayRetentionResult = Readonly<{
  processed: number;
  hasMore: boolean;
}>;

export type OAuthAnonPrivacyStatus = Readonly<{
  openFuture: number;
  due: number;
  blocked: number;
  failures: number;
  scrubbedRecent: number;
  capped: boolean;
}>;

const OAUTH_ANON_PRIVACY_STATUS_KEYS = [
  "blocked",
  "capped",
  "due",
  "failures",
  "openFuture",
  "scrubbedRecent",
] as const;

/** Exact fail-closed shape for OAuth anonymous-data privacy convergence. */
export function parseOAuthAnonPrivacyStatus(
  value: unknown,
): OAuthAnonPrivacyStatus | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== OAUTH_ANON_PRIVACY_STATUS_KEYS.length ||
    keys.some(
      (key, index) =>
        key !== OAUTH_ANON_PRIVACY_STATUS_KEYS[index],
    ) ||
    !count(row.openFuture, PRIVACY_RETENTION_COUNT_CAP) ||
    !count(row.due, PRIVACY_RETENTION_COUNT_CAP) ||
    !count(row.blocked, PRIVACY_RETENTION_COUNT_CAP) ||
    !count(row.failures, PRIVACY_RETENTION_COUNT_CAP) ||
    !count(row.scrubbedRecent, PRIVACY_RETENTION_COUNT_CAP) ||
    typeof row.capped !== "boolean"
  ) {
    return null;
  }
  return {
    openFuture: row.openFuture,
    due: row.due,
    blocked: row.blocked,
    failures: row.failures,
    scrubbedRecent: row.scrubbedRecent,
    capped: row.capped,
  };
}

export function oauthAnonPrivacyNeedsRetry(
  status: OAuthAnonPrivacyStatus,
): boolean {
  return (
    status.due > 0 ||
    status.blocked > 0 ||
    status.capped
  );
}

export function oauthAnonPrivacyHasFailure(
  status: OAuthAnonPrivacyStatus,
): boolean {
  return status.failures > 0;
}

function parseBoundedEvidenceRetentionResult(
  value: unknown,
  limit: number,
  maximum: number,
): CommerceDisplayRetentionResult | null {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximum ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== "has_more,ok,processed" ||
    row.ok !== true ||
    !count(row.processed, limit) ||
    typeof row.has_more !== "boolean"
  ) {
    return null;
  }
  return {
    processed: row.processed,
    hasMore: row.has_more,
  };
}

export function parseCommerceDisplayRetentionResult(
  value: unknown,
  limit = COMMERCE_DISPLAY_RETENTION_LIMIT,
): CommerceDisplayRetentionResult | null {
  return parseBoundedEvidenceRetentionResult(
    value,
    limit,
    COMMERCE_DISPLAY_RETENTION_LIMIT,
  );
}

