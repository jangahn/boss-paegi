// saga.test.ts — 환불 saga 멱등 계약·오류코드↔HTTP mapping·correlation marker·PG body 검증 (§9·§27·§38·§42).
//
// 상태: generated / statically-checked (tsc) — node:test 로 실행 가능하나 **runtime-unverified**:
//   라이브 Postgres/PostgREST 없이 RPC 계약의 "형태"만 in-process **mock DB 어댑터**로 검증한다.
//   실제 RPC 본문(0062)과의 런타임 동치는 DB 필요(pgTAP·G-gate 담당) — 여기선 API 계약면만 고정한다.
//   실행: node --test __tests__/refund/saga.test.ts   (Node 24 기본 / Node 22 는 --experimental-strip-types)
//
// 검증 대상:
//   §9  멱등 계약 통일 — 동일 payload 재호출→{outcome:'no_op',idempotent:true} / 다른 payload→request_conflict /
//        terminal exact replay 는 invalid_state 가 아니라 no_op / terminal 에 다른 작업 시도만 invalid_state.
//   §38 오류코드↔HTTP manifest — conflict/CAS/idempotency→409·not found→404·auth→401/403·
//        malformed/business validation→400·maintenance→503·business block+issue→200 structured·invariant→500 fatal.
//   §27 correlation marker — 중립 문구(PII 없음)·`BP_REFUND:<attempt_id>` 형식·PG cancel reason 으로 사용·
//        Idempotency-Key = attempt.id 의 RFC 8941 quoted-string.
//   §7  PG request body 3필드 — 정확히 {amount, reason, currentCancellableAmount}·amount=attempt.amount·
//        reason=marker·currentCancellableAmount=preflight cancellable.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §38 오류코드 → HTTP manifest. PG RPC 는 전부 errcode='P0001' 로 raise 하며 message 가 의미 토큰이다.
// (0062 RPC 본문에서 실제로 raise 되는 토큰을 망라. 삭제된 옛 alias 는 포함하지 않음.)
// ─────────────────────────────────────────────────────────────────────────────────────────────
type Sentry = "fatal" | null;
interface HttpMapping {
  http: number;
  retryable: boolean;
  sentry: Sentry;
}

const CONFLICT_409 = new Set([
  "request_conflict", "invalid_state", "version_conflict", "order_has_open_refund", "payout_ref_duplicate",
]);
const NOT_FOUND_404 = new Set([
  "order_not_found", "attempt_not_found", "generation_not_found", "purchase_lot_not_found",
]);
const AUTH = new Map<string, number>([
  ["unauthorized", 401], ["forbidden", 403], ["not_admin", 403],
]);
const VALIDATION_400 = new Set([
  "reason_invalid", "qty_invalid", "rail_invalid", "cra_future", "amount_nonpositive", "payout_ref_invalid",
  "order_not_paid", "qty_exceeds_available", "qty_exceeds_order_remaining", "nothing_to_refund",
  "insufficient_credits", "rail_not_pg", "rail_not_manual", "malformed",
]);
const MAINTENANCE_503 = new Set(["maintenance"]);
// 사후 불변식 위반(§15 ③) — pattern·정확 토큰. 500 fatal + Sentry fatal.
const INVARIANT_PATTERNS = [/_derive_mismatch$/, /_append_only_violation$/, /_delete_forbidden$/];
const INVARIANT_TOKENS = new Set(["invariant_violation"]);

/** P0001 raise 메시지 토큰 → HTTP mapping(§38). 미매핑 토큰은 500 fatal(예상 못한 raise=불변식으로 취급). */
export function mapRpcError(message: string): HttpMapping {
  if (CONFLICT_409.has(message)) return { http: 409, retryable: false, sentry: null };
  if (NOT_FOUND_404.has(message)) return { http: 404, retryable: false, sentry: null };
  if (AUTH.has(message)) return { http: AUTH.get(message)!, retryable: false, sentry: null };
  if (VALIDATION_400.has(message)) return { http: 400, retryable: false, sentry: null };
  if (MAINTENANCE_503.has(message)) return { http: 503, retryable: true, sentry: null };
  if (INVARIANT_TOKENS.has(message) || INVARIANT_PATTERNS.some((re) => re.test(message))) {
    return { http: 500, retryable: false, sentry: "fatal" };
  }
  return { http: 500, retryable: false, sentry: "fatal" };
}

/** RPC 정상 JSON 결과 분류(§15 ②) — outcome:'blocked'|'manual_review'|'ineligible' 는 HTTP 200 structured. */
const BUSINESS_BLOCK_OUTCOMES = new Set(["blocked", "manual_review", "ineligible"]);
export interface RpcResult {
  ok: boolean;
  outcome?: string;
  idempotent?: boolean;
  [k: string]: unknown;
}
export function classifyRpcResult(res: RpcResult): { http: number; businessBlock: boolean; issueRequired: boolean } {
  const businessBlock = res.outcome != null && BUSINESS_BLOCK_OUTCOMES.has(res.outcome);
  return { http: 200, businessBlock, issueRequired: businessBlock };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// mock DB 어댑터 — 0062 의 멱등 계약(§9)을 in-process 로 재현. 실제 SQL 이 아니라 계약 형태 재현.
// ─────────────────────────────────────────────────────────────────────────────────────────────
class PgError extends Error {
  code = "P0001";
  constructor(token: string) {
    super(token);
    this.name = "PgError";
  }
}

interface AttemptRow {
  id: string;
  state: string;
  rail: "portone_cancel" | "manual_transfer";
  amount: number;
  manual_commit_payload_hash: string | null;
  pg_request_body: string | null;
  pg_total_before: number | null;
}
interface RequestRow {
  id: string;
  payload_hash: string;
  state: string;
}

/** 0062 의 세 RPC(begin·commit_manual·mark_pg_requested) 멱등/충돌 분기만 계약대로 재현한 mock. */
class MockRefundDb {
  private requests = new Map<string, RequestRow>();
  private attempts = new Map<string, AttemptRow>();

  seedAttempt(row: AttemptRow): void {
    this.attempts.set(row.id, { ...row });
  }

  /** admin_refund_begin 계약: 신규→prepared / 동일 payload_hash→no_op / 상이→request_conflict. */
  adminRefundBegin(requestId: string, payloadHash: string): RpcResult {
    const existing = this.requests.get(requestId);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new PgError("request_conflict");
      return { ok: true, outcome: "no_op", idempotent: true, request_id: requestId };
    }
    this.requests.set(requestId, { id: requestId, payload_hash: payloadHash, state: "prepared" });
    return { ok: true, outcome: "prepared", request_id: requestId };
  }

  /** admin_refund_commit_manual 계약: committed+동일 hash→no_op / committed+상이→request_conflict /
   *  manual_pending 이 아니면(예: 다른 op 를 terminal 에)→invalid_state. */
  adminRefundCommitManual(attemptId: string, payloadHash: string): RpcResult {
    const a = this.attempts.get(attemptId);
    if (!a) throw new PgError("attempt_not_found");
    if (a.state === "committed") {
      if (a.manual_commit_payload_hash === payloadHash) {
        return { ok: true, outcome: "no_op", idempotent: true };
      }
      throw new PgError("request_conflict");
    }
    if (a.state !== "manual_pending") throw new PgError("invalid_state");
    if (a.rail !== "manual_transfer") throw new PgError("rail_not_manual");
    a.state = "committed";
    a.manual_commit_payload_hash = payloadHash;
    return { ok: true, outcome: "committed", attempt_id: attemptId };
  }

  /** admin_refund_mark_pg_requested 계약: 이미 pg_* & 동일 body/total→no_op / 상이→request_conflict /
   *  prepared·manual_review 가 아니면(terminal 포함)→invalid_state. */
  adminRefundMarkPgRequested(attemptId: string, body: string, totalBefore: number): RpcResult {
    const a = this.attempts.get(attemptId);
    if (!a) throw new PgError("attempt_not_found");
    if (["pg_requested", "pg_pending", "pg_succeeded"].includes(a.state)) {
      if (a.pg_request_body === body && a.pg_total_before === totalBefore) {
        return { ok: true, outcome: "no_op", idempotent: true };
      }
      throw new PgError("request_conflict");
    }
    if (!["prepared", "manual_review"].includes(a.state)) throw new PgError("invalid_state");
    if (a.rail !== "portone_cancel") throw new PgError("rail_not_pg");
    a.state = "pg_requested";
    a.pg_request_body = body;
    a.pg_total_before = totalBefore;
    return { ok: true, outcome: "pg_requested", attempt_id: attemptId };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §27 correlation marker + §7 PG request body 계약 helper.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const MARKER_RE = /^BP_REFUND:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC8941_QUOTED = /^"([\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/;

/** 중립 correlation marker — PG 사유/영수증/고객화면 노출 가능하므로 식별자만(PII 없음). */
export function correlationMarker(attemptId: string): string {
  return `BP_REFUND:${attemptId}`;
}

/** Idempotency-Key = attempt.id::text 의 RFC 8941 quoted-string. */
export function idempotencyKey(attemptId: string): string {
  return `"${attemptId}"`;
}

export interface PgCancelBody {
  amount: number;
  reason: string;
  currentCancellableAmount: number;
}
export function buildPgCancelBody(attempt: { id: string; amount: number }, preflightCancellable: number): PgCancelBody {
  return { amount: attempt.amount, reason: correlationMarker(attempt.id), currentCancellableAmount: preflightCancellable };
}

/** §7: pg_request_body 는 정확히 세 키·값 계약을 만족해야 한다. */
export function validatePgCancelBody(
  body: Record<string, unknown>, attempt: { id: string; amount: number }, preflightCancellable: number,
): true {
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, ["amount", "currentCancellableAmount", "reason"], "정확히 3키만 허용");
  assert.equal(body.amount, attempt.amount, "amount = attempt.amount");
  assert.equal(body.reason, correlationMarker(attempt.id), "reason = correlation marker");
  assert.equal(body.currentCancellableAmount, preflightCancellable, "cca = preflight cancellable");
  return true;
}

const PII_TOKENS = ["card", "account", "phone", "email", "name", "ssn", "주민"];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 테스트
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("§9 멱등: 동일 payload 재호출 → no_op idempotent, 다른 payload → request_conflict(409)", () => {
  const db = new MockRefundDb();
  const reqId = randomUUID();
  const first = db.adminRefundBegin(reqId, "hashA");
  assert.equal(first.outcome, "prepared");

  const replay = db.adminRefundBegin(reqId, "hashA");
  assert.equal(replay.outcome, "no_op");
  assert.equal(replay.idempotent, true);

  assert.throws(() => db.adminRefundBegin(reqId, "hashB"), (e: unknown) => {
    assert.ok(e instanceof PgError);
    assert.equal(e.message, "request_conflict");
    assert.equal(mapRpcError(e.message).http, 409);
    return true;
  });
});

test("§9 terminal exact replay 는 invalid_state 가 아니라 no_op (동일 작업 재호출)", () => {
  const db = new MockRefundDb();
  const attemptId = randomUUID();
  db.seedAttempt({
    id: attemptId, state: "manual_pending", rail: "manual_transfer", amount: 3000,
    manual_commit_payload_hash: null, pg_request_body: null, pg_total_before: null,
  });
  const committed = db.adminRefundCommitManual(attemptId, "mhash");
  assert.equal(committed.outcome, "committed");

  const replay = db.adminRefundCommitManual(attemptId, "mhash"); // terminal + 동일 payload
  assert.equal(replay.outcome, "no_op");
  assert.equal(replay.idempotent, true, "terminal exact replay 는 멱등 no_op — invalid_state 아님");

  // terminal + 다른 payload → request_conflict(409), invalid_state 아님.
  assert.throws(() => db.adminRefundCommitManual(attemptId, "other"), (e: unknown) => {
    assert.ok(e instanceof PgError && e.message === "request_conflict");
    return true;
  });
});

test("§9 terminal 에 '다른 작업'을 시도하면 invalid_state(409)", () => {
  const db = new MockRefundDb();
  const attemptId = randomUUID();
  // committed(terminal) attempt 에 mark_pg_requested(다른 작업) 시도.
  db.seedAttempt({
    id: attemptId, state: "committed", rail: "portone_cancel", amount: 3000,
    manual_commit_payload_hash: null, pg_request_body: null, pg_total_before: null,
  });
  assert.throws(() => db.adminRefundMarkPgRequested(attemptId, JSON.stringify({ a: 1 }), 3000), (e: unknown) => {
    assert.ok(e instanceof PgError);
    assert.equal(e.message, "invalid_state");
    assert.equal(mapRpcError(e.message).http, 409);
    return true;
  });
});

test("§9 mark_pg_requested 멱등: 동일 body/total 재시도 → no_op, 상이 → request_conflict", () => {
  const db = new MockRefundDb();
  const attemptId = randomUUID();
  db.seedAttempt({
    id: attemptId, state: "prepared", rail: "portone_cancel", amount: 3000,
    manual_commit_payload_hash: null, pg_request_body: null, pg_total_before: null,
  });
  const body = JSON.stringify(buildPgCancelBody({ id: attemptId, amount: 3000 }, 3000));
  const r1 = db.adminRefundMarkPgRequested(attemptId, body, 3000);
  assert.equal(r1.outcome, "pg_requested");
  const r2 = db.adminRefundMarkPgRequested(attemptId, body, 3000);
  assert.equal(r2.outcome, "no_op");
  assert.equal(r2.idempotent, true);
  assert.throws(() => db.adminRefundMarkPgRequested(attemptId, JSON.stringify({ x: 9 }), 3000),
    (e: unknown) => e instanceof PgError && e.message === "request_conflict");
});

test("§38 오류코드 → HTTP manifest 전수 매핑", () => {
  const cases: Array<[string, number, Sentry]> = [
    ["request_conflict", 409, null],
    ["invalid_state", 409, null],
    ["version_conflict", 409, null],
    ["order_has_open_refund", 409, null],
    ["payout_ref_duplicate", 409, null],
    ["order_not_found", 404, null],
    ["attempt_not_found", 404, null],
    ["generation_not_found", 404, null],
    ["purchase_lot_not_found", 404, null],
    ["unauthorized", 401, null],
    ["forbidden", 403, null],
    ["not_admin", 403, null],
    ["reason_invalid", 400, null],
    ["qty_invalid", 400, null],
    ["amount_nonpositive", 400, null],
    ["insufficient_credits", 400, null],
    ["malformed", 400, null],
    ["maintenance", 503, null],
    ["refund_request_state_derive_mismatch", 500, "fatal"],
    ["credit_ledger_append_only_violation", 500, "fatal"],
    ["credit_lots_delete_forbidden", 500, "fatal"],
    ["invariant_violation", 500, "fatal"],
  ];
  for (const [token, http, sentry] of cases) {
    const m = mapRpcError(token);
    assert.equal(m.http, http, `${token} → ${http}`);
    assert.equal(m.sentry, sentry, `${token} sentry`);
  }
  assert.equal(mapRpcError("maintenance").retryable, true, "503 은 retryable");
  assert.equal(mapRpcError("request_conflict").retryable, false, "409 은 non-retryable(멱등 replay 로 흡수)");
});

test("§15/§38 business block: outcome blocked/manual_review/ineligible → HTTP 200 structured + issue 필요", () => {
  for (const outcome of ["blocked", "manual_review", "ineligible"]) {
    const c = classifyRpcResult({ ok: true, outcome });
    assert.equal(c.http, 200, `${outcome} → 200 structured`);
    assert.equal(c.businessBlock, true);
    assert.equal(c.issueRequired, true, "business block 은 issue 저장 필요(§15 ②)");
  }
  // 정상 성공 outcome 은 business block 아님.
  const ok = classifyRpcResult({ ok: true, outcome: "committed" });
  assert.equal(ok.businessBlock, false);
  assert.equal(ok.issueRequired, false);
});

test("§27 correlation marker: 중립 형식·PII 없음·quoted Idempotency-Key", () => {
  const attemptId = randomUUID();
  const marker = correlationMarker(attemptId);
  assert.match(marker, MARKER_RE, "BP_REFUND:<attempt_id> 형식");
  for (const pii of PII_TOKENS) {
    assert.ok(!marker.toLowerCase().includes(pii), `marker 에 PII 토큰(${pii}) 없음`);
  }
  const key = idempotencyKey(attemptId);
  assert.match(key, RFC8941_QUOTED, "Idempotency-Key 는 RFC 8941 quoted-string");
  assert.equal(key, `"${attemptId}"`, "key 값 = attempt.id::text");
});

test("§7 PG request body 3필드 계약: 정확히 {amount, reason, currentCancellableAmount}", () => {
  const attempt = { id: randomUUID(), amount: 2700 };
  const body = buildPgCancelBody(attempt, 3000);
  assert.equal(validatePgCancelBody({ ...body }, attempt, 3000), true);

  // 추가 키 → 실패.
  assert.throws(() => validatePgCancelBody({ ...body, requester: "Admin" }, attempt, 3000));
  // 잘못된 amount → 실패.
  assert.throws(() => validatePgCancelBody({ ...body, amount: 9999 }, attempt, 3000));
  // 잘못된 reason(marker 불일치) → 실패.
  assert.throws(() => validatePgCancelBody({ ...body, reason: "환불" }, attempt, 3000));
  // 잘못된 currentCancellableAmount → 실패.
  assert.throws(() => validatePgCancelBody({ ...body, currentCancellableAmount: 1 }, attempt, 3000));
});
