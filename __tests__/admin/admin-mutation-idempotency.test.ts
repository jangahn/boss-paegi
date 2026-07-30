import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicAdminRequestId,
  parseExactTimestampFence,
} from "../../lib/admin-operation-id.ts";
import {
  isAdminSettlementReceiptProof,
  isAdminMutationOperation,
  isGenericAdminMutationReceiptOperation,
  isOperationRequestId,
  parseAccountReactivationBeginResult,
  parseAccountReactivationCompleteResult,
  parsePendingAccountReactivation,
  parseAdminEventMutationResult,
  parseAdminIntegrityMutationResult,
  parseAdminModerationMutationResult,
  parseAdminMutationReceipt,
  parseAdminSettlementMutationResult,
  parseAdminSettlementReceipt,
} from "../../lib/admin-mutation.ts";
import { eventSaveSchema } from "../../lib/events/types.ts";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const REQUEST = "00000000-0000-4000-8000-000000000003";

test("operation UUID is canonical, deterministic, version 8, and domain-separated", () => {
  const first = deterministicAdminRequestId(
    "event_save",
    ADMIN,
    TARGET,
    {
      nested: { z: 2, a: 1, ignored: undefined },
      list: [true, null, "x"],
      zero: -0,
    },
  );
  const reordered = deterministicAdminRequestId(
    "event_save",
    ADMIN,
    TARGET,
    {
      zero: 0,
      list: [true, null, "x"],
      nested: { a: 1, z: 2 },
    },
  );
  assert.equal(first, reordered);
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(isOperationRequestId(first), true);

  const variants = [
    deterministicAdminRequestId("event_delete", ADMIN, TARGET, {
      nested: { a: 1, z: 2 },
      list: [true, null, "x"],
      zero: 0,
    }),
    deterministicAdminRequestId(
      "event_save",
      "00000000-0000-4000-8000-000000000009",
      TARGET,
      { nested: { a: 1, z: 2 }, list: [true, null, "x"], zero: 0 },
    ),
    deterministicAdminRequestId(
      "event_save",
      ADMIN,
      "00000000-0000-4000-8000-000000000009",
      { nested: { a: 1, z: 2 }, list: [true, null, "x"], zero: 0 },
    ),
    deterministicAdminRequestId("event_save", ADMIN, TARGET, {
      nested: { a: 1, z: 2 },
      list: [null, true, "x"],
      zero: 0,
    }),
  ];
  assert.equal(new Set([first, ...variants]).size, variants.length + 1);
});

test("operation UUID rejects values outside canonical JSON", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const sparse = new Array(2);
  sparse[1] = "present";
  for (const invalid of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    BigInt(1),
    Symbol("x"),
    () => true,
    new Date(0),
    new Map([["key", "value"]]),
    new Set(["value"]),
    circular,
    sparse,
  ]) {
    assert.throws(() =>
      deterministicAdminRequestId("event_save", ADMIN, TARGET, {
        invalid,
      }),
    );
  }
});

test("PostgreSQL microsecond lifecycle timestamps are validated without truncation", () => {
  const microseconds = "2026-07-20T01:02:03.123456+00:00";
  assert.equal(parseExactTimestampFence(` ${microseconds} `), microseconds);
  assert.notEqual(
    new Date(microseconds).toISOString(),
    microseconds,
    "JavaScript serialization demonstrates the precision loss this guard avoids",
  );
  for (const invalid of [
    null,
    "",
    "not-a-date",
    "1".repeat(65),
  ]) {
    assert.equal(parseExactTimestampFence(invalid), null);
  }
});

test("event mutation input accepts only real KST datetime-local minutes", () => {
  const base = {
    type: "notice",
    title: "title",
    summary: "summary",
    body: "body",
    popupActive: false,
    bannerHomeActive: false,
    bannerGalleryActive: false,
    bannerLeaderboardActive: false,
    priority: 0,
    pinned: false,
    noindex: false,
    popupDismissDays: 7,
  };
  assert.equal(
    eventSaveSchema.safeParse({
      ...base,
      startsAt: "2028-02-29T23:59",
      endsAt: null,
    }).success,
    true,
  );
  for (const startsAt of [
    "2027-02-29T12:00",
    "2028-13-01T12:00",
    "2028-01-01T24:00",
    "2028-01-01",
    "2028-01-01T12:00:00",
    "not-a-date",
  ]) {
    assert.equal(eventSaveSchema.safeParse({ ...base, startsAt }).success, false);
  }
});

test("operation and UUID allowlists reject lookalikes", () => {
  for (const operation of [
    "config_update",
    "event_save",
    "moderation_takedown",
    "moderation_permanent_delete",
    "integrity_ban",
    "account_reactivate",
    "order_settle",
  ]) {
    assert.equal(isAdminMutationOperation(operation), true);
  }
  assert.equal(isAdminMutationOperation("event_save "), false);
  assert.equal(isAdminMutationOperation("__proto__"), false);
  assert.equal(isGenericAdminMutationReceiptOperation("event_save"), true);
  assert.equal(
    isGenericAdminMutationReceiptOperation("moderation_permanent_delete"),
    true,
  );
  assert.equal(
    isGenericAdminMutationReceiptOperation("account_reactivate"),
    false,
  );
  assert.equal(isGenericAdminMutationReceiptOperation("order_settle"), false);
  assert.equal(isOperationRequestId(REQUEST), true);
  assert.equal(
    isOperationRequestId("00000000-0000-0000-0000-000000000003"),
    false,
  );
  assert.equal(isOperationRequestId("not-a-uuid"), false);
});

test("receipt parser accepts only coherent terminal and pending shapes", () => {
  assert.deepEqual(
    parseAdminMutationReceipt({ ok: true, state: "aborted", result: null }),
    { ok: true, state: "aborted", result: null },
  );
  assert.deepEqual(
    parseAdminMutationReceipt({ ok: true, state: "pending", result: null }),
    { ok: true, state: "pending", result: null },
  );
  assert.deepEqual(
    parseAdminMutationReceipt({
      ok: true,
      state: "completed",
      result: { ok: true, id: TARGET },
    }),
    {
      ok: true,
      state: "completed",
      result: { ok: true, id: TARGET },
    },
  );
  for (const invalid of [
    null,
    { ok: false, state: "aborted", result: null },
    { ok: true, state: "pending", result: {} },
    { ok: true, state: "completed", result: null },
    { ok: true, state: "completed", result: { ok: false } },
  ]) {
    assert.equal(parseAdminMutationReceipt(invalid), null);
  }
});

test("mutation result parsers fail closed on malformed successful responses", () => {
  const event = {
    ok: true,
    id: TARGET,
    version: 1,
    state: "draft",
    noOp: false,
    idempotent: false,
  };
  assert.deepEqual(parseAdminEventMutationResult(event), event);
  assert.equal(
    parseAdminEventMutationResult({ ...event, version: Number.MAX_VALUE }),
    null,
  );
  assert.equal(
    parseAdminEventMutationResult({ ...event, noOp: "false" }),
    null,
  );

  const integrity = {
    ok: true,
    previousStatus: "pending",
    nextStatus: "cleared",
    version: 2,
    noOp: false,
    idempotent: false,
  };
  assert.deepEqual(parseAdminIntegrityMutationResult(integrity), integrity);
  assert.equal(
    parseAdminIntegrityMutationResult({ ...integrity, nextStatus: null }),
    null,
  );

  const moderation = {
    ok: true,
    previousState: "pending",
    nextState: "dismissed",
    version: 3,
    dismissed: 2,
    noOp: false,
    idempotent: false,
  };
  assert.deepEqual(parseAdminModerationMutationResult(moderation), moderation);
  assert.equal(
    parseAdminModerationMutationResult({ ...moderation, dismissed: -1 }),
    null,
  );

  const settlement = {
    ok: true as const,
    before: 2,
    after: 5,
    credits: 3,
    requestedCredits: 3,
    quarantined: false as const,
    noOp: false,
    idempotent: false,
  };
  assert.deepEqual(parseAdminSettlementMutationResult(settlement), settlement);
  const quarantinedSettlement = {
    ...settlement,
    after: 2,
    credits: 0 as const,
    quarantined: true as const,
  };
  assert.deepEqual(
    parseAdminSettlementMutationResult(quarantinedSettlement),
    quarantinedSettlement,
  );
  for (const malformed of [
    { ...settlement, before: -1 },
    { ...settlement, after: -1 },
    { ...settlement, credits: -1 },
    { ...settlement, after: 6 },
    { ...settlement, credits: 2 },
    { ...settlement, requestedCredits: 0 },
    { ...settlement, requestedCredits: 4 },
    { ...settlement, quarantined: true },
    { ...quarantinedSettlement, credits: 1, after: 3 },
    { ...quarantinedSettlement, requestedCredits: 0 },
    {
      ok: true,
      before: 2,
      after: 5,
      credits: 3,
      noOp: false,
      idempotent: false,
    },
  ]) {
    assert.equal(parseAdminSettlementMutationResult(malformed), null);
  }
  assert.deepEqual(
    parseAdminSettlementReceipt({
      ok: true,
      found: true,
      result: { ...settlement, idempotent: true },
    }),
    {
      ok: true,
      found: true,
      result: { ...settlement, idempotent: true },
    },
  );
  assert.equal(
    parseAdminSettlementReceipt({
      ok: true,
      found: true,
      result: settlement,
    }),
    null,
  );
  assert.deepEqual(parseAdminSettlementReceipt({ ok: true, found: false }), {
    ok: true,
    found: false,
  });
  assert.equal(
    parseAdminSettlementReceipt({
      ok: true,
      found: true,
      result: { ...settlement, after: 5.5 },
    }),
    null,
  );
  assert.equal(
    isAdminSettlementReceiptProof(
      {
        ok: true,
        found: true,
        result: { ...settlement, idempotent: true },
      },
      settlement,
    ),
    true,
  );
  assert.equal(
    isAdminSettlementReceiptProof(
      {
        ok: true,
        found: true,
        result: {
          ...settlement,
          credits: 2,
          requestedCredits: 2,
          after: 4,
          idempotent: true,
        },
      },
      settlement,
    ),
    false,
  );
  assert.equal(
    isAdminSettlementReceiptProof(
      {
        ok: true,
        found: true,
        result: { ...quarantinedSettlement, idempotent: true },
      },
      settlement,
    ),
    false,
  );
});

test("reactivation parsers distinguish pending external work from DB completion", () => {
  const pending = {
    ok: true,
    pending: true,
    operationRequestId: REQUEST,
    email: "owner@example.test",
    idempotent: false,
  };
  assert.deepEqual(parseAccountReactivationBeginResult(pending), pending);
  assert.equal(
    parseAccountReactivationBeginResult({
      ...pending,
      operationRequestId: "not-a-uuid",
    }),
    null,
  );
  assert.deepEqual(
    parseAccountReactivationBeginResult({
      ok: true,
      accountReactivated: true,
      idempotent: true,
    }),
    {
      ok: true,
      pending: false,
      operationRequestId: undefined,
      accountReactivated: true,
      idempotent: true,
    },
  );

  const complete = {
    ok: true,
    userId: TARGET,
    accountReactivated: true,
    idempotent: false,
  };
  assert.deepEqual(parseAccountReactivationCompleteResult(complete), complete);
  assert.equal(
    parseAccountReactivationCompleteResult({
      ...complete,
      accountReactivated: false,
    }),
    null,
  );
});

test("pending reactivation read parser binds the exact target lifecycle", () => {
  assert.deepEqual(
    parsePendingAccountReactivation(
      { ok: true, found: false },
      TARGET,
    ),
    { ok: true, found: false },
  );
  const pending = {
    ok: true,
    found: true,
    request_id: REQUEST,
    admin_user_id: ADMIN,
    user_id: TARGET,
    expected_deleted_at: "2026-07-20T01:02:03.123456+00:00",
    expected_withdrawal_generation: 7,
    job_status: "leased",
    cancel_requested: true,
  };
  assert.deepEqual(
    parsePendingAccountReactivation(pending, TARGET),
    {
      ok: true,
      found: true,
      operationRequestId: REQUEST,
      adminUserId: ADMIN,
      userId: TARGET,
      expectedDeletedAt: pending.expected_deleted_at,
      expectedWithdrawalGeneration: 7,
      jobStatus: "leased",
      cancelRequested: true,
    },
  );
  assert.equal(
    parsePendingAccountReactivation(
      { ...pending, user_id: ADMIN },
      TARGET,
    ),
    null,
  );
  assert.equal(
    parsePendingAccountReactivation(
      { ...pending, expected_withdrawal_generation: 2 ** 53 },
      TARGET,
    ),
    null,
  );
});
