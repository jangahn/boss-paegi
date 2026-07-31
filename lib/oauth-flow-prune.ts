export const OAUTH_FLOW_PRUNE_RESULT_KEYS = [
  "expiredPending",
  "boundRecoveryConverged",
  "prunedTerminal",
  "targetAuthorityLossConverged",
  "targetAuthorityLossBacklog",
  "pendingExpiryBacklog",
  "terminalRetentionBacklog",
  "unconsumedMigrationBacklog",
  "unreleasedContinueBacklog",
  "unboundClaimBacklog",
  "boundRecoveryBacklog",
] as const;

export type OAuthFlowPruneResult = {
  expiredPending: number;
  boundRecoveryConverged: number;
  prunedTerminal: number;
  targetAuthorityLossConverged: number;
  targetAuthorityLossBacklog: number;
  pendingExpiryBacklog: number;
  terminalRetentionBacklog: number;
  unconsumedMigrationBacklog: number;
  unreleasedContinueBacklog: number;
  unboundClaimBacklog: number;
  boundRecoveryBacklog: number;
};

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseOAuthFlowPruneResult(
  value: unknown,
): OAuthFlowPruneResult | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== OAUTH_FLOW_PRUNE_RESULT_KEYS.length ||
    !OAUTH_FLOW_PRUNE_RESULT_KEYS.every((key) => keys.includes(key)) ||
    !OAUTH_FLOW_PRUNE_RESULT_KEYS.every((key) => isCount(record[key]))
  ) {
    return null;
  }
  return {
    expiredPending: record.expiredPending as number,
    boundRecoveryConverged:
      record.boundRecoveryConverged as number,
    prunedTerminal: record.prunedTerminal as number,
    targetAuthorityLossConverged:
      record.targetAuthorityLossConverged as number,
    targetAuthorityLossBacklog:
      record.targetAuthorityLossBacklog as number,
    pendingExpiryBacklog: record.pendingExpiryBacklog as number,
    terminalRetentionBacklog:
      record.terminalRetentionBacklog as number,
    unconsumedMigrationBacklog:
      record.unconsumedMigrationBacklog as number,
    unreleasedContinueBacklog:
      record.unreleasedContinueBacklog as number,
    unboundClaimBacklog: record.unboundClaimBacklog as number,
    boundRecoveryBacklog:
      record.boundRecoveryBacklog as number,
  };
}

export function oauthFlowPruneHasBacklog(
  result: OAuthFlowPruneResult,
): boolean {
  return (
    result.targetAuthorityLossBacklog > 0 ||
    result.pendingExpiryBacklog > 0 ||
    result.terminalRetentionBacklog > 0 ||
    result.unconsumedMigrationBacklog > 0 ||
    result.unreleasedContinueBacklog > 0 ||
    result.unboundClaimBacklog > 0 ||
    result.boundRecoveryBacklog > 0
  );
}
