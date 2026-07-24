import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getPortonePaymentSnapshot,
  cancelPortonePaymentPartial,
  parseRefundMarker,
  refundCorrelationMarker,
  type PortonePaymentSnapshot,
  type PortoneCancellationSnapshot,
} from "@/lib/portone";
import { log, errInfo } from "@/lib/log";

/**
 * 환불 saga 앱측 오케스트레이션(v0.76) — **정본은 0062 SECURITY DEFINER RPC**, 앱은 절차만 수행한다.
 * fresh GET(스냅샷) → mark_pg_requested(preflight 영속) → 부분취소 POST → record_pg_result → commit.
 * 오류 4분류(§7.3)·3h cutoff(§7.4 — 내부 보수적 retry 한계)·관측 이벤트 ingest 를 이 파일이 공유한다.
 * 사용처: /api/admin/refund-credits(process) · /api/ops/reconcile(sweep 확장) · /api/pay/webhook ·
 *        /api/pay/order-status · /api/admin/cancel · /api/admin/resolve-* .
 */

/** 최초 POST 후 동일 key·동일 body 재시도 허용 창(§7.4 — PortOne 보장이 아닌 내부 보수적 cutoff). */
export const PG_RETRY_CUTOFF_MS = 3 * 60 * 60 * 1000;

// ── §38 오류코드 → HTTP 매핑 (saga.test.ts 계약과 동일 멤버십) ─────────────────────────────
const CONFLICT_409 = new Set([
  "request_conflict", "invalid_state", "version_conflict", "order_has_open_refund", "payout_ref_duplicate",
]);
const NOT_FOUND_404 = new Set([
  "order_not_found", "attempt_not_found", "generation_not_found", "purchase_lot_not_found",
  "event_not_found", "issue_not_found", "member_not_found",
]);
const VALIDATION_400 = new Set([
  "reason_invalid", "qty_invalid", "rail_invalid", "cra_future", "amount_nonpositive", "payout_ref_invalid",
  "order_not_paid", "qty_exceeds_available", "qty_exceeds_order_remaining", "nothing_to_refund",
  "insufficient_credits", "rail_not_pg", "rail_not_manual", "malformed", "note_invalid",
  "resolution_invalid", "issue_not_open", "evidence_invalid", "verification_source_invalid",
  "cancel_id_required", "result_invalid", "economic_exceeds_remaining", "no_cancel_intent",
  "event_requires_resolution", "event_still_unmatched", "delta_invalid", "not_cancelable",
  "already_canceled", "use_refund_saga", "cancellation_id_invalid", "amount_invalid",
  "open_refund_blocks_delete", "open_issue_blocks_delete", "paid_at_required", "paid_at_future",
  "account_deleted", "invalid_product", "product_amount_mismatch", "invalid_provider",
  "invalid_channel", "payment_id_format", "not_settleable", "status_changed", "invalid_job",
  "invalid_phase",
]);

export type RefundRpcErrorInfo = { code: string; http: number; sentryFatal: boolean };

/**
 * P0001 raise 메시지 → {안전 코드, HTTP}(§38). 미매핑/불변식 위반은 500 fatal —
 * `invariant_violation` 은 issue 큐가 아니라 Sentry `pay.refund_invariant_violation` 로만 보고(§8 ③).
 */
export function mapRefundRpcError(message: string | undefined): RefundRpcErrorInfo {
  const token = (message ?? "").split(":")[0].trim();
  if (CONFLICT_409.has(token)) return { code: token, http: 409, sentryFatal: false };
  if (NOT_FOUND_404.has(token)) return { code: token, http: 404, sentryFatal: false };
  if (VALIDATION_400.has(token)) return { code: token, http: 400, sentryFatal: false };
  // 사후 불변식 위반(§8 ③) — 전체 rollback 은 DB 가 이미 수행, 여기선 fatal 보고만.
  return { code: "invariant_violation", http: 500, sentryFatal: true };
}

/** RPC P0001 을 라우트 응답으로 변환 + fatal 이면 Sentry 보고. */
export function refundRpcErrorResponsePayload(
  error: { message?: string } | null,
  ctx: Record<string, unknown>
): { body: { error: string }; status: number } {
  const info = mapRefundRpcError(error?.message);
  if (info.sentryFatal) {
    log.error("pay.refund_invariant_violation", { ...ctx, ...errInfo(error) });
    Sentry.captureMessage("pay.refund_invariant_violation", {
      level: "fatal",
      extra: { ...ctx, message: error?.message },
    });
  }
  return { body: { error: info.code }, status: info.http };
}

// ── 관측 이벤트 ingest (§5·§11 — 웹훅/폴링/reconcile 공용) ────────────────────────────────
export type IngestCounts = { recorded: number; noop: number; discrepancy: number; skipped: number };

/**
 * 스냅샷의 종단(SUCCEEDED·FAILED) 취소들을 record_payment_cancellation_observation 으로 영속.
 * REQUESTED/미인식/금액 판정불가는 skip(행 금지 — §5 fail-closed). 멱등(재관측 no_op).
 */
export async function ingestObservedCancellations(
  admin: SupabaseClient,
  orderUuid: string,
  snapshot: PortonePaymentSnapshot
): Promise<IngestCounts> {
  const counts: IngestCounts = { recorded: 0, noop: 0, discrepancy: 0, skipped: 0 };
  for (const c of snapshot.cancellations) {
    if ((c.status !== "SUCCEEDED" && c.status !== "FAILED") || !c.id || c.totalAmount === null || c.totalAmount <= 0) {
      counts.skipped += 1;
      continue;
    }
    const { data, error } = await admin.rpc("record_payment_cancellation_observation", {
      p_order_uuid: orderUuid,
      p_cancellation_id: c.id,
      p_status: c.status,
      p_amount: c.totalAmount,
      p_requested_at: c.requestedAt,
      p_cancelled_at: c.cancelledAt,
      p_raw: { reason: c.reason, receiptUrl: c.receiptUrl, status: c.status },
    });
    if (error) {
      log.warn("pay.cancellation_ingest_fail", { orderUuid, cancellationId: c.id, ...errInfo(error) });
      counts.skipped += 1;
      continue;
    }
    const outcome = (data as { outcome?: string } | null)?.outcome;
    if (outcome === "recorded") counts.recorded += 1;
    else if (outcome === "no_op") counts.noop += 1;
    else if (outcome === "discrepancy") counts.discrepancy += 1;
    else counts.skipped += 1;
  }
  return counts;
}

// ── 외부 취소 관측 처리 (웹훅/폴링/reconcile 의 CANCELLED·PARTIAL_CANCELLED 공용) ──────────
export type ExternalCancellationOutcome =
  | { outcome: "canceled_unpaid" }
  | { outcome: "resolved_full"; batchId?: string }
  | { outcome: "ineligible" }
  | { outcome: "observed" } // 이벤트 영속만(부분취소 등) — 경제 해소는 resolver/운영자
  | { outcome: "error"; error: string };

/**
 * 외부에서 취소가 관측된 주문 처리: ① 이벤트 영속(멱등) ② 전액(CANCELLED)+무결제 → canceled 종단,
 * paid → system auto-full 시도(eligibility 미충족은 issue 큐가 담당) ③ PARTIAL → 영속만(1급 관측).
 * 로컬 상태 직접 종단 금지(§13) — 전이는 전부 RPC.
 */
export async function handleObservedCancellation(
  admin: SupabaseClient,
  order: { order_uuid: string; paid_at: string | null },
  snapshot: PortonePaymentSnapshot
): Promise<ExternalCancellationOutcome> {
  await ingestObservedCancellations(admin, order.order_uuid, snapshot);

  if (snapshot.status === "CANCELLED") {
    if (!order.paid_at) {
      const { error } = await admin.rpc("mark_order_canceled_unpaid", {
        p_order_uuid: order.order_uuid,
        p_pg_status: "CANCELLED",
        p_pg_tx_id: null,
        p_raw: snapshot.raw,
      });
      if (error) {
        const info = mapRefundRpcError(error.message);
        // paid 인데 로컬 미지급(use_refund_saga) — 지급 finalizer 가 먼저 수렴해야 하는 레이스.
        log.warn("pay.canceled_unpaid_fail", { orderUuid: order.order_uuid, code: info.code });
        return { outcome: "error", error: info.code };
      }
      return { outcome: "canceled_unpaid" };
    }
    const { data, error } = await admin.rpc("resolve_external_cancellation_auto_full", {
      p_order_uuid: order.order_uuid,
    });
    if (error) {
      const info = mapRefundRpcError(error.message);
      log.warn("pay.auto_full_fail", { orderUuid: order.order_uuid, code: info.code });
      return { outcome: "error", error: info.code };
    }
    const res = data as { outcome?: string; batch_id?: string } | null;
    return res?.outcome === "resolved_full"
      ? { outcome: "resolved_full", batchId: res.batch_id }
      : { outcome: "ineligible" };
  }

  return { outcome: "observed" };
}

// ── saga 실행(process auto) — attempt 1건의 PG 경로 전진 ──────────────────────────────────
type AttemptRow = {
  id: string;
  request_id: string;
  order_uuid: string;
  user_id: string;
  state: string;
  rail: string;
  qty: number;
  amount: number;
  pg_requested_at: string | null;
  pg_request_body: { amount: number; reason: string; currentCancellableAmount: number } | null;
  pg_cancel_id: string | null;
};

export type ProcessAttemptOutcome = {
  /** §10.1 process 결과 enum 부분집합 — processed(committed)·pending·manual_review·blocked·no_op·outstanding */
  outcome: "processed" | "pending" | "manual_review" | "blocked" | "no_op" | "outstanding";
  attemptId: string;
  detail?: string;
  cancellationId?: string;
};

async function loadAttempt(admin: SupabaseClient, attemptId: string): Promise<AttemptRow | null> {
  const { data } = await admin
    .from("order_refund_attempts")
    .select(
      "id, request_id, order_uuid, user_id, state, rail, qty, amount, pg_requested_at, pg_request_body, pg_cancel_id"
    )
    .eq("id", attemptId)
    .maybeSingle();
  return (data as AttemptRow | null) ?? null;
}

async function paymentIdOfOrder(admin: SupabaseClient, orderUuid: string): Promise<string | null> {
  const { data } = await admin
    .from("orders")
    .select("payment_id")
    .eq("order_uuid", orderUuid)
    .maybeSingle();
  return (data as { payment_id: string | null } | null)?.payment_id ?? null;
}

/** 스냅샷에서 이 attempt 의 marker 를 단 SUCCEEDED/FAILED 취소 찾기(§27 자기 귀속). */
function findMarkerCancellation(
  snapshot: PortonePaymentSnapshot,
  attemptId: string
): PortoneCancellationSnapshot | null {
  return (
    snapshot.cancellations.find((c) => parseRefundMarker(c.reason) === attemptId) ?? null
  );
}

async function recordSucceededAndCommit(
  admin: SupabaseClient,
  attemptId: string,
  c: PortoneCancellationSnapshot,
  raw: Record<string, unknown>
): Promise<ProcessAttemptOutcome> {
  const { error: recErr } = await admin.rpc("admin_refund_record_pg_result", {
    p_attempt_id: attemptId,
    p_result: "succeeded",
    p_cancel_id: c.id,
    p_cancel_status: "SUCCEEDED",
    p_cancelled_amount: c.totalAmount,
    p_receipt_url: c.receiptUrl,
    p_raw: raw,
    p_requested_at: c.requestedAt,
    p_cancelled_at: c.cancelledAt,
  });
  if (recErr) {
    const info = mapRefundRpcError(recErr.message);
    log.warn("pay.refund_record_fail", { attemptId, code: info.code, ...errInfo(recErr) });
    return { outcome: "blocked", attemptId, detail: info.code };
  }
  const { error: commitErr } = await admin.rpc("admin_refund_commit", { p_attempt_id: attemptId });
  if (commitErr) {
    const info = mapRefundRpcError(commitErr.message);
    // 웹훅 선착 등으로 이미 committed 면 no-op 이 정상 — 그 외는 blocked 로 노출.
    log.warn("pay.refund_commit_fail_v2", { attemptId, code: info.code, ...errInfo(commitErr) });
    return { outcome: "blocked", attemptId, detail: info.code };
  }
  log.info("pay.refund_attempt_committed", { attemptId, cancellationId: c.id });
  return { outcome: "processed", attemptId, cancellationId: c.id };
}

async function recordFailedToReview(
  admin: SupabaseClient,
  attemptId: string,
  cancelStatus: string,
  raw: Record<string, unknown>,
  detail: string
): Promise<ProcessAttemptOutcome> {
  const { error } = await admin.rpc("admin_refund_record_pg_result", {
    p_attempt_id: attemptId,
    p_result: "failed",
    p_cancel_id: null,
    p_cancel_status: cancelStatus,
    p_cancelled_amount: null,
    p_receipt_url: null,
    p_raw: raw,
    p_requested_at: null,
    p_cancelled_at: null,
  });
  if (error) {
    const info = mapRefundRpcError(error.message);
    log.warn("pay.refund_record_failed_fail", { attemptId, code: info.code });
    return { outcome: "blocked", attemptId, detail: info.code };
  }
  log.warn("pay.refund_attempt_manual_review", { attemptId, detail });
  return { outcome: "manual_review", attemptId, detail };
}

/**
 * PG rail attempt 1건 전진(§B.8.1 process auto·reconcile sweep 공용):
 * prepared → preflight(fresh GET)+mark_pg_requested → POST → record → commit.
 * pg_requested → 3h 내 동일 key·body 재POST / 3h 후 GET 증빙 폴링(신규 POST 금지).
 * pg_pending → GET 폴링으로 종단. pg_succeeded → commit 마무리.
 * 실패 분류는 §7.3 — stale/hard_reject 는 fresh 증빙과 함께 manual_review 로.
 */
export async function processAttemptAuto(
  admin: SupabaseClient,
  attemptId: string
): Promise<ProcessAttemptOutcome> {
  const attempt = await loadAttempt(admin, attemptId);
  if (!attempt) return { outcome: "blocked", attemptId, detail: "attempt_not_found" };
  if (attempt.state === "committed" || attempt.state === "released") {
    return { outcome: "no_op", attemptId, detail: `already_${attempt.state}` };
  }
  if (attempt.rail !== "portone_cancel") {
    return { outcome: "blocked", attemptId, detail: "rail_not_pg" };
  }
  const paymentId = await paymentIdOfOrder(admin, attempt.order_uuid);
  if (!paymentId) return { outcome: "blocked", attemptId, detail: "payment_id_missing" };

  const snapRes = await getPortonePaymentSnapshot(paymentId);
  if (!snapRes.ok) {
    // GET 실패 — 전이 없이 보존(재시도 무해).
    return { outcome: "outstanding", attemptId, detail: `snapshot_${snapRes.error}` };
  }
  const snapshot = snapRes.snapshot;

  // 관측 이벤트는 언제나 영속(멱등) — 우리 marker 취소는 자기 귀속이라 issue 미생성.
  await ingestObservedCancellations(admin, attempt.order_uuid, snapshot);

  // pg_succeeded 잔여(commit 만 남음) — 마무리.
  if (attempt.state === "pg_succeeded") {
    const { error } = await admin.rpc("admin_refund_commit", { p_attempt_id: attemptId });
    if (error) {
      const info = mapRefundRpcError(error.message);
      return { outcome: "blocked", attemptId, detail: info.code };
    }
    return { outcome: "processed", attemptId };
  }

  const markerCancel = findMarkerCancellation(snapshot, attempt.id);

  if (attempt.state === "prepared") {
    // §7.1 preflight: 부분취소 가능 status 에서만 신규 POST. 아니면 POST 미발행·상태 보존(T60).
    if (snapshot.status !== "PAID" && snapshot.status !== "PARTIAL_CANCELLED") {
      return { outcome: "blocked", attemptId, detail: `preflight_status_${snapshot.status}` };
    }
    if (
      snapshot.totalAmount === null ||
      snapshot.cancellableAmount === null ||
      snapshot.cancellableAmount < attempt.amount
    ) {
      return { outcome: "blocked", attemptId, detail: "preflight_cancellable_insufficient" };
    }
    const body = {
      amount: attempt.amount,
      reason: refundCorrelationMarker(attempt.id),
      currentCancellableAmount: snapshot.cancellableAmount,
    };
    const { error: markErr } = await admin.rpc("admin_refund_mark_pg_requested", {
      p_attempt_id: attempt.id,
      p_total_before: snapshot.totalAmount,
      p_cancelled_before: snapshot.cancelledAmount ?? 0,
      p_cancellable_before: snapshot.cancellableAmount,
      p_cancellation_ids_before: snapshot.cancellations.map((c) => c.id).filter(Boolean),
      p_request_body: body,
    });
    if (markErr) {
      const info = mapRefundRpcError(markErr.message);
      return { outcome: "blocked", attemptId, detail: info.code };
    }
    return executePgPost(admin, { ...attempt, state: "pg_requested", pg_request_body: body }, paymentId, snapshot);
  }

  if (attempt.state === "pg_requested") {
    if (!attempt.pg_request_body || !attempt.pg_requested_at) {
      return { outcome: "blocked", attemptId, detail: "pg_request_incomplete" };
    }
    const age = Date.now() - new Date(attempt.pg_requested_at).getTime();
    if (markerCancel && markerCancel.status === "SUCCEEDED") {
      return recordSucceededAndCommit(admin, attempt.id, markerCancel, snapshot.raw);
    }
    if (markerCancel && markerCancel.status === "FAILED") {
      return recordFailedToReview(admin, attempt.id, "FAILED", snapshot.raw, "pg_failed_observed");
    }
    if (age <= PG_RETRY_CUTOFF_MS) {
      // 3h 내 — 동일 key·동일 persisted body 재시도만(§7.4).
      return executePgPost(admin, attempt, paymentId, snapshot);
    }
    // 3h 경과 — 신규 POST 금지, 증빙 없으면 manual_review 전환(B.8.6 ⓑ).
    return recordFailedToReview(admin, attempt.id, "OUTSTANDING", snapshot.raw, "retry_cutoff_elapsed");
  }

  if (attempt.state === "pg_pending") {
    if (markerCancel && markerCancel.status === "SUCCEEDED") {
      return recordSucceededAndCommit(admin, attempt.id, markerCancel, snapshot.raw);
    }
    if (markerCancel && markerCancel.status === "FAILED") {
      return recordFailedToReview(admin, attempt.id, "FAILED", snapshot.raw, "pg_failed_observed");
    }
    return { outcome: "pending", attemptId };
  }

  // manual_review·manual_pending 은 auto 대상 아님 — 운영자 액션(switch/commit_manual/replan) 대기.
  return { outcome: "blocked", attemptId, detail: `state_${attempt.state}` };
}

/** 영속된 body/key 로 부분취소 POST 실행 + 결과 반영(§7.3 4분류). */
async function executePgPost(
  admin: SupabaseClient,
  attempt: AttemptRow,
  paymentId: string,
  freshSnapshot: PortonePaymentSnapshot
): Promise<ProcessAttemptOutcome> {
  const body = attempt.pg_request_body!;
  const pc = await cancelPortonePaymentPartial({
    paymentId,
    attemptId: attempt.id,
    amount: body.amount,
    currentCancellableAmount: body.currentCancellableAmount,
  });
  if (pc.ok) {
    if (pc.cancellation.status === "SUCCEEDED") {
      return recordSucceededAndCommit(admin, attempt.id, pc.cancellation, pc.raw);
    }
    // REQUESTED(비동기 처리 중) — pending 기록 후 폴링으로 종단(§6).
    const { error } = await admin.rpc("admin_refund_record_pg_result", {
      p_attempt_id: attempt.id,
      p_result: "pending",
      p_cancel_id: null,
      p_cancel_status: "REQUESTED",
      p_cancelled_amount: null,
      p_receipt_url: null,
      p_raw: pc.raw,
      p_requested_at: pc.cancellation.requestedAt,
      p_cancelled_at: null,
    });
    if (error) {
      const info = mapRefundRpcError(error.message);
      return { outcome: "blocked", attemptId: attempt.id, detail: info.code };
    }
    return { outcome: "pending", attemptId: attempt.id };
  }

  if (pc.kind === "outstanding") {
    // POST 도달 불명 — 상태 보존(pg_requested), 3h 내 재시도/이후 증빙 폴링은 sweep 이 담당.
    log.warn("pay.refund_attempt_outstanding", { attemptId: attempt.id, error: pc.error });
    return { outcome: "outstanding", attemptId: attempt.id, detail: pc.error };
  }

  // stale_cancellable / already_cancelled / hard_reject — fresh 재관측 후 처리.
  const snapRes = await getPortonePaymentSnapshot(paymentId);
  const snapshot = snapRes.ok ? snapRes.snapshot : freshSnapshot;
  await ingestObservedCancellations(admin, attempt.order_uuid, snapshot);
  const markerCancel = findMarkerCancellation(snapshot, attempt.id);
  if (pc.kind === "already_cancelled" && markerCancel && markerCancel.status === "SUCCEEDED") {
    // 우리 POST 가 사실은 성공해 있었음(멱등 재발견) — 정상 종단.
    return recordSucceededAndCommit(admin, attempt.id, markerCancel, snapshot.raw);
  }
  return recordFailedToReview(admin, attempt.id, "FAILED", snapshot.raw, pc.error);
}

/** reconcile 확장 sweep(B.8.6): open PG attempt 들을 독립 처리. */
export async function sweepOpenPgAttempts(
  admin: SupabaseClient,
  limit = 20
): Promise<{ attemptsChecked: number; transitions: number; issuesOpened: number }> {
  const { data } = await admin
    .from("order_refund_attempts")
    .select("id, state")
    .in("state", ["pg_requested", "pg_pending", "pg_succeeded"])
    .order("created_at", { ascending: true })
    .limit(limit);
  const rows = (data ?? []) as { id: string; state: string }[];
  let transitions = 0;
  for (const row of rows) {
    try {
      const res = await processAttemptAuto(admin, row.id);
      if (res.outcome === "processed" || res.outcome === "manual_review" || res.outcome === "pending") {
        transitions += 1;
      }
    } catch (e) {
      log.warn("pay.refund_sweep_item_fail", { attemptId: row.id, ...errInfo(e) });
    }
  }
  return { attemptsChecked: rows.length, transitions, issuesOpened: 0 };
}
