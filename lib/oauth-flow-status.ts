import { safeNext } from "./oauth-metadata.ts";
import { isOAuthFlowId } from "./oauth-flow-lease.ts";
import type { OAuthFlowProvider } from "./oauth-flow-proof.ts";

export type OAuthFlowState =
  | "pending"
  | "claimed"
  | "signout_required"
  | "signout_revoked"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned"
  | "expired";

export type OAuthFlowStatus = {
  flowId: string;
  provider: OAuthFlowProvider;
  sourceIsAnonymous: boolean;
  requestedNext: string;
  state: OAuthFlowState;
  active: boolean;
  outcome:
    | "completed"
    | "failed"
    | "cancelled"
    | "abandoned"
    | "expired"
    | null;
  targetUserId: string | null;
  targetSessionId: string | null;
  destination: string | null;
  action: "continue" | "signout" | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  revokeConfirmedAt: string | null;
  finishedAt: string | null;
  releasedAt: string | null;
  migrationConsumedAt: string | null;
};

export type OAuthFlowStatusReadReceipt =
  | { kind: "found"; status: OAuthFlowStatus }
  | { kind: "absent" };

export type OAuthFlowFinalizeReceipt = {
  outcome: "completed" | "failed";
  targetUserId: string | null;
  targetSessionId: string | null;
  destination: string;
  action: "continue" | "signout";
};

export type OAuthFlowRecoveredAuthority = {
  sourceUserId: string;
  sourceSessionId: string;
  status: OAuthFlowStatus;
};

export type OAuthFlowMinimalRecovery = {
  flowId: string;
  state:
    | "absent"
    | "signout_revoked"
    | "completed"
    | "failed"
    | "cancelled"
    | "abandoned"
    | "expired";
  active: boolean;
};

export type OAuthFlowDiscoveryAbsent = {
  state: "absent";
  active: false;
};

export type OAuthFlowTargetEvidence = {
  flowId: string;
  state: "claimed" | "signout_required" | "completed";
  targetUserId: string;
  targetSessionId: string;
  accessTokenSha256: string;
  refreshTokenSha256: string;
  releasedAt: string | null;
};

export type OAuthFlowRevokeBoundTargetReceipt = {
  ok: true;
  flowId: string;
  state: "abandoned" | "completed";
  outcome: "abandoned" | "completed";
  destination: "/";
  revokeConfirmedAt: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
const STATES: readonly unknown[] = [
  "pending",
  "claimed",
  "signout_required",
  "signout_revoked",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "expired",
];
const OUTCOMES: readonly unknown[] = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "expired",
];

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function uuidOrNull(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" && UUID_RE.test(value)
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function iso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isoOrNull(value: unknown): value is string | null {
  return value === null || iso(value);
}

function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 2048 &&
    safeNext(value) === value
  );
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function validStatusStateShape(
  value: Record<string, unknown>,
  state: OAuthFlowState,
): boolean {
  const hasTarget = value.targetUserId !== null;
  const hasDestination = value.destination !== null;
  const hasClaim = value.claimedAt !== null;
  const hasRevoke = value.revokeConfirmedAt !== null;
  const hasFinish = value.finishedAt !== null;
  const hasRelease = value.releasedAt !== null;
  const hasMigration = value.migrationConsumedAt !== null;
  const expectedOutcome = [
    "completed",
    "failed",
    "cancelled",
    "abandoned",
    "expired",
  ].includes(state)
    ? state
    : null;

  if (value.outcome !== expectedOutcome) return false;

  switch (state) {
    case "pending":
      return (
        !hasTarget &&
        !hasDestination &&
        value.action === null &&
        !hasClaim &&
        !hasRevoke &&
        !hasFinish &&
        !hasRelease &&
        !hasMigration
      );
    case "claimed":
      return (
        !hasDestination &&
        value.action === null &&
        hasClaim &&
        !hasRevoke &&
        !hasFinish &&
        !hasRelease &&
        !hasMigration
      );
    case "signout_required":
      return (
        hasTarget &&
        hasDestination &&
        value.action === "signout" &&
        hasClaim &&
        !hasRevoke &&
        !hasFinish &&
        !hasRelease &&
        !hasMigration
      );
    case "signout_revoked":
      return (
        hasTarget &&
        hasDestination &&
        value.action === "signout" &&
        hasClaim &&
        hasRevoke &&
        !hasFinish &&
        !hasRelease &&
        !hasMigration
      );
    case "completed":
      return (
        hasTarget &&
        hasDestination &&
        hasClaim &&
        hasFinish &&
        (
          (
            value.action === "continue" &&
            (!hasRevoke || hasRelease) &&
            (!hasMigration || value.sourceIsAnonymous === true)
          ) ||
          (
            value.action === "signout" &&
            hasRevoke &&
            !hasRelease &&
            !hasMigration
          )
        )
      );
    case "failed":
      return (
        !hasTarget &&
        hasDestination &&
        value.action === "continue" &&
        hasClaim &&
        !hasRevoke &&
        hasFinish &&
        !hasRelease &&
        !hasMigration
      );
    case "cancelled":
    case "expired":
      return (
        !hasTarget &&
        !hasDestination &&
        value.action === null &&
        !hasClaim &&
        !hasRevoke &&
        hasFinish &&
        !hasRelease &&
        !hasMigration
      );
    case "abandoned":
      return (
        hasTarget &&
        !hasDestination &&
        value.action === null &&
        hasClaim &&
        hasRevoke &&
        hasFinish &&
        !hasRelease &&
        !hasMigration
      );
  }
}

function validStatusTimeOrder(
  value: Record<string, unknown>,
  state: OAuthFlowState,
): boolean {
  const createdAt = timestamp(value.createdAt as string);
  const expiresAt = timestamp(value.expiresAt as string);
  const claimedAt = value.claimedAt === null
    ? null
    : timestamp(value.claimedAt as string);
  const revokeConfirmedAt = value.revokeConfirmedAt === null
    ? null
    : timestamp(value.revokeConfirmedAt as string);
  const finishedAt = value.finishedAt === null
    ? null
    : timestamp(value.finishedAt as string);
  const releasedAt = value.releasedAt === null
    ? null
    : timestamp(value.releasedAt as string);
  const migrationConsumedAt =
    value.migrationConsumedAt === null
      ? null
      : timestamp(value.migrationConsumedAt as string);

  if (expiresAt - createdAt !== 10 * 60 * 1_000) return false;
  if (
    claimedAt !== null &&
    (claimedAt < createdAt || claimedAt >= expiresAt)
  ) {
    return false;
  }
  if (
    revokeConfirmedAt !== null &&
    (claimedAt === null || revokeConfirmedAt < claimedAt)
  ) {
    return false;
  }
  if (
    finishedAt !== null &&
    finishedAt < (claimedAt ?? createdAt)
  ) {
    return false;
  }
  if (
    finishedAt !== null &&
    revokeConfirmedAt !== null &&
    finishedAt < revokeConfirmedAt &&
    !(
      state === "completed" &&
      value.action === "continue" &&
      releasedAt !== null &&
      releasedAt >= revokeConfirmedAt
    )
  ) {
    return false;
  }
  if (
    migrationConsumedAt !== null &&
    (finishedAt === null || migrationConsumedAt < finishedAt)
  ) {
    return false;
  }
  if (
    releasedAt !== null &&
    (
      finishedAt === null ||
      releasedAt < finishedAt ||
      (
        revokeConfirmedAt !== null &&
        releasedAt < revokeConfirmedAt
      )
    )
  ) {
    return false;
  }
  return !(
    state === "expired" &&
    (finishedAt === null || finishedAt < expiresAt)
  );
}

export function parseOAuthFlowStatus(
  value: unknown,
  expectedFlowId: string,
): OAuthFlowStatus | null {
  const keys = [
    "ok",
    "flowId",
    "provider",
    "sourceIsAnonymous",
    "requestedNext",
    "state",
    "active",
    "outcome",
    "targetUserId",
    "targetSessionId",
    "destination",
    "action",
    "createdAt",
    "expiresAt",
    "claimedAt",
    "revokeConfirmedAt",
    "finishedAt",
    "releasedAt",
    "migrationConsumedAt",
  ] as const;
  if (
    !isOAuthFlowId(expectedFlowId) ||
    !exactRecord(value, keys) ||
    value.ok !== true ||
    value.flowId !== expectedFlowId ||
    (value.provider !== "kakao" &&
      value.provider !== "google") ||
    typeof value.sourceIsAnonymous !== "boolean" ||
    !safePath(value.requestedNext) ||
    !STATES.includes(value.state) ||
    typeof value.active !== "boolean" ||
    (value.outcome !== null &&
      !OUTCOMES.includes(value.outcome)) ||
    !uuidOrNull(value.targetUserId) ||
    !uuidOrNull(value.targetSessionId) ||
    ((value.targetUserId === null) !==
      (value.targetSessionId === null)) ||
    (value.destination !== null && !safePath(value.destination)) ||
    (value.action !== null &&
      value.action !== "continue" &&
      value.action !== "signout") ||
    !isoOrNull(value.createdAt) ||
    value.createdAt === null ||
    !isoOrNull(value.expiresAt) ||
    value.expiresAt === null ||
    !isoOrNull(value.claimedAt) ||
    !isoOrNull(value.revokeConfirmedAt) ||
    !isoOrNull(value.finishedAt) ||
    !isoOrNull(value.releasedAt) ||
    !isoOrNull(value.migrationConsumedAt)
  ) {
    return null;
  }
  const state = value.state as OAuthFlowState;
  const activeState = [
    "pending",
    "claimed",
    "signout_required",
    "signout_revoked",
  ].includes(state);
  if (
    value.active !== activeState ||
    !validStatusStateShape(value, state) ||
    !validStatusTimeOrder(value, state)
  ) {
    return null;
  }
  return {
    flowId: expectedFlowId,
    provider: value.provider,
    sourceIsAnonymous: value.sourceIsAnonymous,
    requestedNext: value.requestedNext,
    state,
    active: value.active,
    outcome: value.outcome as OAuthFlowStatus["outcome"],
    targetUserId: value.targetUserId,
    targetSessionId: value.targetSessionId,
    destination: value.destination as string | null,
    action: value.action as OAuthFlowStatus["action"],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    claimedAt: value.claimedAt,
    revokeConfirmedAt: value.revokeConfirmedAt,
    finishedAt: value.finishedAt,
    releasedAt: value.releasedAt,
    migrationConsumedAt: value.migrationConsumedAt,
  };
}

export function parseOAuthFlowStatusReadReceipt(
  value: unknown,
  expectedFlowId: string,
): OAuthFlowStatusReadReceipt | null {
  const status = parseOAuthFlowStatus(value, expectedFlowId);
  if (status) return { kind: "found", status };
  if (
    exactRecord(value, ["ok", "error"]) &&
    value.ok === false &&
    value.error === "oauth_flow_not_found"
  ) {
    return { kind: "absent" };
  }
  return null;
}

export function oauthFlowStatusNeedsRecoveryAuthority(
  status: OAuthFlowStatus,
): boolean {
  return (
    status.active ||
    (
      status.state === "completed" &&
      status.action === "continue" &&
      status.releasedAt === null
    )
    ||
    (
      status.state === "completed" &&
      status.action === "continue" &&
      status.sourceIsAnonymous &&
      status.revokeConfirmedAt === null &&
      status.releasedAt !== null &&
      status.migrationConsumedAt === null
    )
  );
}

export function parseOAuthFlowDiscoveredAuthority(
  value: unknown,
): OAuthFlowRecoveredAuthority | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const flowId = (value as Record<string, unknown>).flowId;
  const recovered = isOAuthFlowId(flowId)
    ? parseOAuthFlowRecoveredAuthority(value, flowId)
    : null;
  if (!recovered) return null;
  const status = recovered.status;
  return oauthFlowStatusNeedsRecoveryAuthority(status)
    ? recovered
    : null;
}

export function parseOAuthFlowDiscoveredStatus(
  value: unknown,
): OAuthFlowStatus | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const flowId = (value as Record<string, unknown>).flowId;
  return isOAuthFlowId(flowId)
    ? parseOAuthFlowStatus(value, flowId)
    : null;
}

export function parseOAuthFlowDiscoveryAbsent(
  value: unknown,
): OAuthFlowDiscoveryAbsent | null {
  if (
    !exactRecord(value, ["ok", "state", "active"]) ||
    value.ok !== true ||
    value.state !== "absent" ||
    value.active !== false
  ) {
    return null;
  }
  return { state: "absent", active: false };
}

export function parseOAuthFlowFinalizeReceipt(
  value: unknown,
  expectedFlowId: string,
): OAuthFlowFinalizeReceipt | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "outcome",
      "targetUserId",
      "targetSessionId",
      "destination",
      "action",
    ]) ||
    value.ok !== true ||
    value.flowId !== expectedFlowId ||
    (value.outcome !== "completed" &&
      value.outcome !== "failed") ||
    !uuidOrNull(value.targetUserId) ||
    !uuidOrNull(value.targetSessionId) ||
    ((value.targetUserId === null) !==
      (value.targetSessionId === null)) ||
    typeof value.destination !== "string" ||
    safeNext(value.destination) !== value.destination ||
    (value.action !== "continue" && value.action !== "signout")
  ) {
    return null;
  }
  return {
    outcome: value.outcome,
    targetUserId: value.targetUserId,
    targetSessionId: value.targetSessionId,
    destination: value.destination,
    action: value.action,
  };
}

export function parseOAuthFlowRecoveredAuthority(
  value: unknown,
  expectedFlowId: string,
): OAuthFlowRecoveredAuthority | null {
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
    keys.length !== 21 ||
    !keys.includes("sourceUserId") ||
    !keys.includes("sourceSessionId") ||
    !uuid(record.sourceUserId) ||
    !uuid(record.sourceSessionId)
  ) {
    return null;
  }
  const statusRecord = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        key !== "sourceUserId" &&
        key !== "sourceSessionId",
    ),
  );
  const status = parseOAuthFlowStatus(
    statusRecord,
    expectedFlowId,
  );
  return (
    status &&
    status.targetSessionId !== record.sourceSessionId &&
    (
      !status.sourceIsAnonymous ||
      status.targetUserId !== record.sourceUserId
    )
  )
    ? {
        sourceUserId: record.sourceUserId,
        sourceSessionId: record.sourceSessionId,
        status,
      }
    : null;
}

export function parseOAuthFlowMinimalRecovery(
  value: unknown,
  expectedFlowId: string,
): OAuthFlowMinimalRecovery | null {
  if (
    !exactRecord(value, ["ok", "flowId", "state", "active"]) ||
    value.ok !== true ||
    value.flowId !== expectedFlowId ||
    typeof value.state !== "string" ||
    ![
      "signout_revoked",
      "absent",
      "completed",
      "failed",
      "cancelled",
      "abandoned",
      "expired",
    ].includes(value.state) ||
    typeof value.active !== "boolean" ||
    value.active !== (value.state === "signout_revoked")
  ) {
    return null;
  }
  return {
    flowId: expectedFlowId,
    state: value.state as OAuthFlowMinimalRecovery["state"],
    active: value.active,
  };
}

export function parseOAuthFlowTargetEvidence(
  value: unknown,
  expected: {
    flowId: string;
    targetUserId: string;
    targetSessionId: string;
  },
): OAuthFlowTargetEvidence | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "state",
      "targetUserId",
      "targetSessionId",
      "accessTokenSha256",
      "refreshTokenSha256",
      "releasedAt",
    ]) ||
    value.ok !== true ||
    value.flowId !== expected.flowId ||
    typeof value.state !== "string" ||
    !["claimed", "signout_required", "completed"].includes(
      value.state,
    ) ||
    value.targetUserId !== expected.targetUserId ||
    value.targetSessionId !== expected.targetSessionId ||
    typeof value.accessTokenSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.accessTokenSha256) ||
    typeof value.refreshTokenSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.refreshTokenSha256) ||
    !isoOrNull(value.releasedAt)
  ) {
    return null;
  }
  return {
    flowId: expected.flowId,
    state: value.state as OAuthFlowTargetEvidence["state"],
    targetUserId: expected.targetUserId,
    targetSessionId: expected.targetSessionId,
    accessTokenSha256: value.accessTokenSha256,
    refreshTokenSha256: value.refreshTokenSha256,
    releasedAt: value.releasedAt,
  };
}

export function parseOAuthFlowEvidenceVerification(
  value: unknown,
  expectedFlowId: string,
): {
  state: OAuthFlowState;
  releasedAt: string | null;
} | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "state",
      "matched",
      "releasedAt",
    ]) ||
    value.ok !== true ||
    value.flowId !== expectedFlowId ||
    !STATES.includes(value.state) ||
    value.matched !== true ||
    !isoOrNull(value.releasedAt)
  ) {
    return null;
  }
  return {
    state: value.state as OAuthFlowState,
    releasedAt: value.releasedAt,
  };
}

export function parseOAuthFlowRevokeBoundTargetReceipt(
  value: unknown,
  expectedFlowId: string,
): OAuthFlowRevokeBoundTargetReceipt | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "state",
      "outcome",
      "destination",
      "revokeConfirmedAt",
    ]) ||
    value.ok !== true ||
    value.flowId !== expectedFlowId ||
    value.destination !== "/" ||
    !iso(value.revokeConfirmedAt) ||
    !(
      (
        value.state === "abandoned" &&
        value.outcome === "abandoned"
      ) ||
      (
        value.state === "completed" &&
        value.outcome === "completed"
      )
    )
  ) {
    return null;
  }
  return {
    ok: true,
    flowId: expectedFlowId,
    state: value.state,
    outcome: value.outcome,
    destination: "/",
    revokeConfirmedAt: value.revokeConfirmedAt,
  };
}

export function parseOAuthFlowSourceEvidenceVerification(
  value: unknown,
  expectedFlowId: string,
): { state: OAuthFlowState } | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "state",
      "matched",
    ]) ||
    value.ok !== true ||
    value.flowId !== expectedFlowId ||
    typeof value.state !== "string" ||
    !STATES.includes(value.state) ||
    value.matched !== true
  ) {
    return null;
  }
  return { state: value.state as OAuthFlowState };
}

export function parseOAuthFlowRotateReceipt(
  value: unknown,
  expected: {
    flowId: string;
    targetUserId: string;
    targetSessionId: string;
  },
): { state: OAuthFlowTargetEvidence["state"] } | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "state",
      "targetUserId",
      "targetSessionId",
    ]) ||
    value.ok !== true ||
    value.flowId !== expected.flowId ||
    typeof value.state !== "string" ||
    !["claimed", "signout_required", "completed"].includes(
      value.state,
    ) ||
    value.targetUserId !== expected.targetUserId ||
    value.targetSessionId !== expected.targetSessionId
  ) {
    return null;
  }
  return {
    state: value.state as OAuthFlowTargetEvidence["state"],
  };
}

export function parseOAuthFlowSignoutRevokeReceipt(
  value: unknown,
  expected: {
    flowId: string;
    targetUserId: string;
    targetSessionId: string;
  },
): { state: "signout_revoked" | "completed" } | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "state",
      "targetUserId",
      "targetSessionId",
      "revokeConfirmedAt",
    ]) ||
    value.ok !== true ||
    value.flowId !== expected.flowId ||
    (value.state !== "signout_revoked" &&
      value.state !== "completed") ||
    value.targetUserId !== expected.targetUserId ||
    value.targetSessionId !== expected.targetSessionId ||
    !isoOrNull(value.revokeConfirmedAt) ||
    value.revokeConfirmedAt === null
  ) {
    return null;
  }
  return { state: value.state };
}
