import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePayError } from "@/lib/pay/error-catalog";
import { DB_RAISE_CODES } from "@/lib/pay/db-raise-codes.gen";
import {
  getPortonePaymentSnapshot,
  cancelPortonePaymentPartial,
  parseRefundMarker,
  refundCorrelationMarker,
  type PortonePaymentSnapshot,
  type PortoneCancellationSnapshot,
} from "@/lib/portone";
import {
  FailClosedReadError,
  resolveFailClosedRead,
  type FailClosedReadResult,
} from "@/lib/pay/fail-closed-read";
import { log, errInfo } from "@/lib/log";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  isCanceledUnpaidPostcondition,
  isResolvedFullCancellationPostcondition,
  parseAutoFullCancellationResult,
  parseMarkOrderCanceledUnpaidResult,
} from "@/lib/pay/order-mutation-result";
import {
  isRefundAttemptStatePostcondition,
  isRefundPgRequestedPostcondition,
  parseRefundCommitResult,
  parseRefundMarkRequestedResult,
  parseRefundRecordResult,
  type RefundPgRequestBody,
} from "@/lib/pay/refund-mutation-result";
import {
  exactPortoneEvidenceFailure,
  type PortoneOrderEvidence,
} from "@/lib/pay/payment-evidence";

/**
 * 환불 saga 앱측 오케스트레이션(v0.76) — **정본은 0062 SECURITY DEFINER RPC**, 앱은 절차만 수행한다.
 * fresh GET(스냅샷) → mark_pg_requested(preflight 영속) → 부분취소 POST → record_pg_result → commit.
 * 오류 4분류(§7.3)·3h cutoff(§7.4 — 내부 보수적 retry 한계)·관측 이벤트 ingest 를 이 파일이 공유한다.
 * 사용처: /api/admin/refund-credits(process) · /api/ops/reconcile(sweep 확장) · /api/pay/webhook ·
 *        /api/pay/order-status · /api/admin/cancel · /api/admin/resolve-* .
 */

/** 최초 POST 후 동일 key·동일 body 재시도 허용 창(§7.4 — PortOne 보장이 아닌 내부 보수적 cutoff). */
export const PG_RETRY_CUTOFF_MS = 3 * 60 * 60 * 1000;

export type RefundRpcErrorInfo = { code: string; http: number; sentryFatal: boolean };

/**
 * P0001 raise 메시지 → {안전 코드, HTTP}(§38). 분류의 단일 소스는
 * lib/pay/error-catalog.ts — 여기서는 카탈로그에 위임만 한다.
 *  - cataloged: 정상 거절(4xx/503, fatal 아님)
 *  - invariant: DB raise 전수 스냅샷에는 있으나 카탈로그에 없는 코드 = 불변식
 *    위반(도달 자체가 버그) — 500 + Sentry fatal(§8 ③, rollback 은 DB 가 수행)
 *  - uncataloged: DB raise 계약 밖 미지 토큰 = 카탈로그/스냅샷 등록 누락 결함 —
 *    500 이지만 fatal 이 아닌 별도 신호(pay.uncataloged_reject)로 보고
 */
export function mapRefundRpcError(message: string | undefined): RefundRpcErrorInfo {
  const token = (message ?? "").split(":")[0].trim();
  const resolved = resolvePayError(token, DB_RAISE_CODES);
  if (resolved.kind === "cataloged") {
    return { code: resolved.code, http: resolved.entry.status, sentryFatal: false };
  }
  if (resolved.kind === "invariant") {
    return { code: "invariant_violation", http: 500, sentryFatal: true };
  }
  return { code: "uncataloged_reject", http: 500, sentryFatal: false };
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
  } else if (info.code === "uncataloged_reject") {
    // DB raise 계약 밖 토큰 — 카탈로그/스냅샷 등록을 잊은 개발 결함 신호.
    // 불변식 위반이 아니므로 fatal 로 승격하지 않되, 조사 가능하게 남긴다.
    log.error("pay.uncataloged_reject", { ...ctx, ...errInfo(error) });
  }
  return { body: { error: info.code }, status: info.http };
}

type RefundRpcCallResult =
  | { ok: true; data: unknown }
  | { ok: false; error: unknown; thrown: boolean };

/**
 * Supabase RPC는 DB 오류를 `{ error }`로 resolve할 수도 있고 transport/client 오류를
 * reject할 수도 있다. 금융 전이 호출부가 reject를 놓쳐 사후조건 확인을 건너뛰지 않도록
 * 두 형태를 하나의 fail-closed 결과로 정규화한다.
 */
async function resolveRefundRpc(
  run: () => PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<RefundRpcCallResult> {
  try {
    const result = await run();
    if (result.error) {
      return { ok: false, error: result.error, thrown: false };
    }
    return { ok: true, data: result.data };
  } catch (error) {
    return { ok: false, error, thrown: true };
  }
}

function refundRpcFailureCode(
  failure: Extract<RefundRpcCallResult, { ok: false }>,
): string {
  if (failure.thrown) return "rpc_unavailable";
  const message =
    failure.error &&
    typeof failure.error === "object" &&
    "message" in failure.error &&
    typeof failure.error.message === "string"
      ? failure.error.message
      : undefined;
  return mapRefundRpcError(message).code;
}

// ── 관측 이벤트 ingest (§5·§11 — 웹훅/폴링/reconcile 공용) ────────────────────────────────
export type IngestCounts = {
  recorded: number;
  noop: number;
  discrepancy: number;
  issuesOpened: number;
  skipped: number;
  failed: number;
};

/**
 * 스냅샷의 종단(SUCCEEDED·FAILED) 취소들을 record_payment_cancellation_observation 으로 영속.
 * REQUESTED/미인식/금액 판정불가는 skip(행 금지 — §5 fail-closed). 멱등(재관측 no_op).
 */
export async function ingestObservedCancellations(
  admin: SupabaseClient,
  orderUuid: string,
  snapshot: PortonePaymentSnapshot
): Promise<IngestCounts> {
  const counts: IngestCounts = {
    recorded: 0,
    noop: 0,
    discrepancy: 0,
    issuesOpened: 0,
    skipped: 0,
    failed: 0,
  };
  for (const c of snapshot.cancellations) {
    if ((c.status !== "SUCCEEDED" && c.status !== "FAILED") || !c.id || c.totalAmount === null || c.totalAmount <= 0) {
      counts.skipped += 1;
      continue;
    }
    let data: unknown;
    let error: unknown = null;
    try {
      const result = await admin.rpc("record_payment_cancellation_observation", {
        p_order_uuid: orderUuid,
        p_cancellation_id: c.id,
        p_status: c.status,
        p_amount: c.totalAmount,
        p_requested_at: c.requestedAt,
        p_cancelled_at: c.cancelledAt,
        p_raw: { reason: c.reason, receiptUrl: c.receiptUrl, status: c.status },
      });
      data = result.data;
      error = result.error;
    } catch (caught) {
      error = caught;
    }
    if (error) {
      log.error("pay.cancellation_ingest_fail", {
        orderUuid,
        cancellationId: c.id,
        ...errInfo(error),
      });
      counts.failed += 1;
      continue;
    }
    const acknowledgement = data as {
      outcome?: string;
      self_attributed?: boolean;
    } | null;
    const outcome = acknowledgement?.outcome;
    if (outcome === "recorded") {
      counts.recorded += 1;
      // A newly recorded successful cancellation that is not attributable to
      // this saga opens an unmatched-cancellation reconciliation issue.
      if (
        c.status === "SUCCEEDED" &&
        acknowledgement?.self_attributed === false
      ) {
        counts.issuesOpened += 1;
      }
    } else if (outcome === "no_op") counts.noop += 1;
    else if (outcome === "discrepancy") {
      counts.discrepancy += 1;
      counts.issuesOpened += 1;
    } else {
      log.error("pay.cancellation_ingest_bad_result", {
        orderUuid,
        cancellationId: c.id,
        outcome: outcome ?? null,
      });
      counts.failed += 1;
    }
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
  order: PortoneOrderEvidence & {
    order_uuid: string;
    paid_at: string | null;
  },
  snapshot: PortonePaymentSnapshot
): Promise<ExternalCancellationOutcome> {
  const evidenceFailure = exactPortoneEvidenceFailure(snapshot, order);
  if (evidenceFailure) {
    log.error("pay.cancellation_evidence_rejected", {
      orderUuid: order.order_uuid,
      paymentId: order.payment_id,
      reason: evidenceFailure,
    });
    return {
      outcome: "error",
      error:
        evidenceFailure === "legacy_snapshot"
          ? "payment_evidence_incomplete"
          : "payment_evidence_mismatch",
    };
  }
  const ingest = await ingestObservedCancellations(admin, order.order_uuid, snapshot);
  if (ingest.failed > 0) {
    // 종단 취소 관측을 잃은 채 webhook 2xx/로컬 종단으로 진행하면 외부 환불이 영구 유실된다.
    // caller가 webhook 5xx·poll 503·reconcile unresolved로 재시도할 수 있도록 먼저 중단한다.
    return { outcome: "error", error: "cancellation_ingest_failed" };
  }

  if (snapshot.status === "CANCELLED") {
    if (!order.paid_at) {
      const transition = await resolveRefundRpc(() =>
        admin.rpc("mark_order_canceled_unpaid", {
          p_order_uuid: order.order_uuid,
          p_pg_status: "CANCELLED",
          p_pg_tx_id: null,
          p_raw: snapshot.raw,
        }),
      );
      if (!transition.ok) {
        const code = refundRpcFailureCode(transition);
        // paid 인데 로컬 미지급(use_refund_saga) — 지급 finalizer 가 먼저 수렴해야 하는 레이스.
        log.warn("pay.canceled_unpaid_fail", {
          orderUuid: order.order_uuid,
          code,
          ...errInfo(transition.error),
        });
        return { outcome: "error", error: code };
      }
      const canceledResult = parseMarkOrderCanceledUnpaidResult(transition.data);
      if (!canceledResult || canceledResult.outcome === "skipped") {
        log.error("pay.canceled_unpaid_invalid_result", {
          orderUuid: order.order_uuid,
          outcome: canceledResult?.outcome ?? null,
        });
        return { outcome: "error", error: "cancellation_transition_invalid" };
      }
      const { data: current, error: currentError } = await admin
        .from("orders")
        .select("status, canceled_at, paid_at")
        .eq("order_uuid", order.order_uuid)
        .maybeSingle();
      if (currentError || !isCanceledUnpaidPostcondition(current)) {
        log.error("pay.canceled_unpaid_postcondition_fail", {
          orderUuid: order.order_uuid,
          ...errInfo(currentError),
        });
        return { outcome: "error", error: "cancellation_transition_incomplete" };
      }
      return { outcome: "canceled_unpaid" };
    }
    const resolution = await resolveRefundRpc(() =>
      admin.rpc("resolve_external_cancellation_auto_full", {
        p_order_uuid: order.order_uuid,
      }),
    );
    if (!resolution.ok) {
      const code = refundRpcFailureCode(resolution);
      log.warn("pay.auto_full_fail", {
        orderUuid: order.order_uuid,
        code,
        ...errInfo(resolution.error),
      });
      return { outcome: "error", error: code };
    }
    const result = parseAutoFullCancellationResult(resolution.data);
    if (!result) {
      log.error("pay.auto_full_invalid_result", { orderUuid: order.order_uuid });
      return { outcome: "error", error: "cancellation_resolution_invalid" };
    }
    if (result.outcome === "ineligible") return { outcome: "ineligible" };
    const { data: current, error: currentError } = await admin
      .from("orders")
      .select(
        "status, canceled_at, paid_at, amount, credits, refunded_amount, refunded_credits",
      )
      .eq("order_uuid", order.order_uuid)
      .maybeSingle();
    if (currentError || !isResolvedFullCancellationPostcondition(current)) {
      log.error("pay.auto_full_postcondition_fail", {
        orderUuid: order.order_uuid,
        batchId: result.batchId,
        ...errInfo(currentError),
      });
      return { outcome: "error", error: "cancellation_resolution_incomplete" };
    }
    return { outcome: "resolved_full", batchId: result.batchId };
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
  /** This processing pass observed/created durable reconciliation work. */
  issuesOpened?: number;
};

function addObservedIssues(
  result: ProcessAttemptOutcome,
  issuesOpened: number,
): ProcessAttemptOutcome {
  const total = (result.issuesOpened ?? 0) + issuesOpened;
  if (total === 0) return result;
  return {
    ...result,
    issuesOpened: total,
  };
}

const REFUND_SWEEP_SYSTEM_FAILURES = new Set([
  "action_failed",
  "attempt_lookup_failed",
  "order_lookup_failed",
  "cancellation_ingest_failed",
  "record_result_invalid",
  "record_result_unproven",
  "commit_result_invalid",
  "commit_result_unproven",
  "preflight_result_invalid",
  "preflight_result_unproven",
  "pg_request_incomplete",
  "payment_evidence_incomplete",
  "payment_evidence_mismatch",
  "rpc_unavailable",
]);

export function refundAttemptOutcomeIsSystemError(
  result: ProcessAttemptOutcome,
): boolean {
  if (
    result.outcome === "outstanding" &&
    result.detail?.startsWith("snapshot_")
  ) {
    return true;
  }
  return (
    result.outcome === "blocked" &&
    !!result.detail &&
    REFUND_SWEEP_SYSTEM_FAILURES.has(result.detail)
  );
}

async function loadAttempt(
  admin: SupabaseClient,
  attemptId: string,
): Promise<FailClosedReadResult<AttemptRow | null>> {
  const result = await resolveFailClosedRead(() =>
    admin
      .from("order_refund_attempts")
      .select(
        "id, request_id, order_uuid, user_id, state, rail, qty, amount, pg_requested_at, pg_request_body, pg_cancel_id"
      )
      .eq("id", attemptId)
      .maybeSingle(),
  );
  if (!result.ok) return result;
  return { ok: true, data: (result.data as AttemptRow | null) ?? null };
}

type RefundOrderEvidence = PortoneOrderEvidence & {
  order_uuid: string;
};

async function paymentEvidenceOfOrder(
  admin: SupabaseClient,
  orderUuid: string,
): Promise<FailClosedReadResult<RefundOrderEvidence | null>> {
  const result = await resolveFailClosedRead(() =>
    admin
      .from("orders")
      .select(
        "order_uuid, payment_id, amount, is_test, expected_store_id, expected_currency, expected_channel_key",
      )
      .eq("order_uuid", orderUuid)
      .maybeSingle(),
  );
  if (!result.ok) return result;
  if (!result.data) return { ok: true, data: null };
  try {
    const row = validateAdminRows<RefundOrderEvidence>(
      "refund.order_evidence",
      [result.data],
      {
        order_uuid: "uuid",
        payment_id: "nullableString",
        amount: "nonnegativeInteger",
        is_test: "boolean",
        expected_store_id: "nullableString",
        expected_currency: "nullableString",
        expected_channel_key: "nullableString",
      },
    )[0]!;
    if (row.order_uuid !== orderUuid) {
      return { ok: false, error: new Error("order_evidence_mismatch") };
    }
    return { ok: true, data: row };
  } catch (error) {
    return { ok: false, error };
  }
}

async function loadAttemptPostcondition(
  admin: SupabaseClient,
  attemptId: string,
  columns: string,
): Promise<FailClosedReadResult<unknown>> {
  return resolveFailClosedRead(() =>
    admin
      .from("order_refund_attempts")
      .select(columns)
      .eq("id", attemptId)
      .maybeSingle(),
  );
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
  const record = await resolveRefundRpc(() =>
    admin.rpc("admin_refund_record_pg_result", {
      p_attempt_id: attemptId,
      p_result: "succeeded",
      p_cancel_id: c.id,
      p_cancel_status: "SUCCEEDED",
      p_cancelled_amount: c.totalAmount,
      p_receipt_url: c.receiptUrl,
      p_raw: raw,
      p_requested_at: c.requestedAt,
      p_cancelled_at: c.cancelledAt,
    }),
  );
  if (!record.ok) {
    const code = refundRpcFailureCode(record);
    log.warn("pay.refund_record_fail", {
      attemptId,
      code,
      ...errInfo(record.error),
    });
    return { outcome: "blocked", attemptId, detail: code };
  }
  if (
    !parseRefundRecordResult(record.data, {
      kind: "succeeded",
      cancellationId: c.id,
    })
  ) {
    log.error("pay.refund_record_invalid_result", { attemptId });
    return { outcome: "blocked", attemptId, detail: "record_result_invalid" };
  }
  const recorded = await loadAttemptPostcondition(
    admin,
    attemptId,
    "state, pg_cancel_id",
  );
  if (
    !recorded.ok ||
    !isRefundAttemptStatePostcondition(
      recorded.data,
      ["pg_succeeded", "committed"],
      c.id,
    )
  ) {
    log.error("pay.refund_record_postcondition_fail", {
      attemptId,
      ...(!recorded.ok ? errInfo(recorded.error) : {}),
    });
    return { outcome: "blocked", attemptId, detail: "record_result_unproven" };
  }
  const commit = await resolveRefundRpc(() =>
    admin.rpc("admin_refund_commit", {
      p_attempt_id: attemptId,
    }),
  );
  if (!commit.ok) {
    const code = refundRpcFailureCode(commit);
    // 웹훅 선착 등으로 이미 committed 면 no-op 이 정상 — 그 외는 blocked 로 노출.
    log.warn("pay.refund_commit_fail_v2", {
      attemptId,
      code,
      ...errInfo(commit.error),
    });
    return { outcome: "blocked", attemptId, detail: code };
  }
  if (!parseRefundCommitResult(commit.data, attemptId)) {
    log.error("pay.refund_commit_invalid_result", { attemptId });
    return { outcome: "blocked", attemptId, detail: "commit_result_invalid" };
  }
  const committed = await loadAttemptPostcondition(admin, attemptId, "state");
  if (
    !committed.ok ||
    !isRefundAttemptStatePostcondition(committed.data, ["committed"])
  ) {
    log.error("pay.refund_commit_postcondition_fail", {
      attemptId,
      ...(!committed.ok ? errInfo(committed.error) : {}),
    });
    return { outcome: "blocked", attemptId, detail: "commit_result_unproven" };
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
  const record = await resolveRefundRpc(() =>
    admin.rpc("admin_refund_record_pg_result", {
      p_attempt_id: attemptId,
      p_result: "failed",
      p_cancel_id: null,
      p_cancel_status: cancelStatus,
      p_cancelled_amount: null,
      p_receipt_url: null,
      p_raw: raw,
      p_requested_at: null,
      p_cancelled_at: null,
    }),
  );
  if (!record.ok) {
    const code = refundRpcFailureCode(record);
    log.warn("pay.refund_record_failed_fail", {
      attemptId,
      code,
      ...errInfo(record.error),
    });
    return { outcome: "blocked", attemptId, detail: code };
  }
  if (!parseRefundRecordResult(record.data, { kind: "failed" })) {
    log.error("pay.refund_record_failed_invalid_result", { attemptId });
    return { outcome: "blocked", attemptId, detail: "record_result_invalid" };
  }
  const reviewed = await loadAttemptPostcondition(admin, attemptId, "state");
  if (
    !reviewed.ok ||
    !isRefundAttemptStatePostcondition(reviewed.data, ["manual_review"])
  ) {
    log.error("pay.refund_record_failed_postcondition_fail", {
      attemptId,
      ...(!reviewed.ok ? errInfo(reviewed.error) : {}),
    });
    return { outcome: "blocked", attemptId, detail: "record_result_unproven" };
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
  const attemptRead = await loadAttempt(admin, attemptId);
  if (!attemptRead.ok) {
    log.error("pay.refund_attempt_load_fail", {
      attemptId,
      ...errInfo(attemptRead.error),
    });
    return { outcome: "blocked", attemptId, detail: "attempt_lookup_failed" };
  }
  const attempt = attemptRead.data;
  if (!attempt) return { outcome: "blocked", attemptId, detail: "attempt_not_found" };
  if (attempt.state === "committed" || attempt.state === "released") {
    return { outcome: "no_op", attemptId, detail: `already_${attempt.state}` };
  }
  if (attempt.rail !== "portone_cancel") {
    return { outcome: "blocked", attemptId, detail: "rail_not_pg" };
  }
  const orderRead = await paymentEvidenceOfOrder(admin, attempt.order_uuid);
  if (!orderRead.ok) {
    log.error("pay.refund_order_load_fail", {
      attemptId,
      orderUuid: attempt.order_uuid,
      ...errInfo(orderRead.error),
    });
    return { outcome: "blocked", attemptId, detail: "order_lookup_failed" };
  }
  const orderEvidence = orderRead.data;
  const paymentId = orderEvidence?.payment_id ?? null;
  if (!orderEvidence || !paymentId) {
    return { outcome: "blocked", attemptId, detail: "payment_id_missing" };
  }

  const snapRes = await getPortonePaymentSnapshot(
    paymentId,
    orderEvidence.expected_store_id ?? undefined,
  );
  if (!snapRes.ok) {
    // GET 실패 — 전이 없이 보존(재시도 무해).
    return { outcome: "outstanding", attemptId, detail: `snapshot_${snapRes.error}` };
  }
  const snapshot = snapRes.snapshot;
  const evidenceFailure = exactPortoneEvidenceFailure(
    snapshot,
    orderEvidence,
  );
  if (evidenceFailure) {
    log.error("pay.refund_evidence_rejected", {
      attemptId,
      orderUuid: attempt.order_uuid,
      paymentId,
      reason: evidenceFailure,
    });
    return {
      outcome: "blocked",
      attemptId,
      detail:
        evidenceFailure === "legacy_snapshot"
          ? "payment_evidence_incomplete"
          : "payment_evidence_mismatch",
    };
  }

  // 관측 이벤트는 언제나 영속(멱등) — 우리 marker 취소는 자기 귀속이라 issue 미생성.
  const ingest = await ingestObservedCancellations(admin, attempt.order_uuid, snapshot);
  return addObservedIssues(
    await (async (): Promise<ProcessAttemptOutcome> => {
      if (ingest.failed > 0) {
        return {
          outcome: "blocked",
          attemptId,
          detail: "cancellation_ingest_failed",
        };
      }

      // pg_succeeded 잔여(commit 만 남음) — 마무리.
      if (attempt.state === "pg_succeeded") {
        const commit = await resolveRefundRpc(() =>
          admin.rpc("admin_refund_commit", {
            p_attempt_id: attemptId,
          }),
        );
        if (!commit.ok) {
          return {
            outcome: "blocked",
            attemptId,
            detail: refundRpcFailureCode(commit),
          };
        }
        if (!parseRefundCommitResult(commit.data, attemptId)) {
          return {
            outcome: "blocked",
            attemptId,
            detail: "commit_result_invalid",
          };
        }
        const committed = await loadAttemptPostcondition(
          admin,
          attemptId,
          "state",
        );
        if (
          !committed.ok ||
          !isRefundAttemptStatePostcondition(committed.data, ["committed"])
        ) {
          return {
            outcome: "blocked",
            attemptId,
            detail: "commit_result_unproven",
          };
        }
        return { outcome: "processed", attemptId };
      }

      const markerCancel = findMarkerCancellation(snapshot, attempt.id);

      if (attempt.state === "prepared") {
        // §7.1 preflight: 부분취소 가능 status 에서만 신규 POST. 아니면 POST 미발행·상태 보존(T60).
        if (
          snapshot.status !== "PAID" &&
          snapshot.status !== "PARTIAL_CANCELLED"
        ) {
          return {
            outcome: "blocked",
            attemptId,
            detail: `preflight_status_${snapshot.status}`,
          };
        }
        if (
          snapshot.totalAmount === null ||
          snapshot.cancellableAmount === null ||
          snapshot.cancellableAmount < attempt.amount
        ) {
          return {
            outcome: "blocked",
            attemptId,
            detail: "preflight_cancellable_insufficient",
          };
        }
        const body: RefundPgRequestBody = {
          amount: attempt.amount,
          reason: refundCorrelationMarker(attempt.id),
          currentCancellableAmount: snapshot.cancellableAmount,
        };
        const cancellationIdsBefore = snapshot.cancellations
          .map((c) => c.id)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
        const cancelledBefore = snapshot.cancelledAmount ?? 0;
        const marked = await resolveRefundRpc(() =>
          admin.rpc("admin_refund_mark_pg_requested", {
            p_attempt_id: attempt.id,
            p_total_before: snapshot.totalAmount,
            p_cancelled_before: cancelledBefore,
            p_cancellable_before: snapshot.cancellableAmount,
            p_cancellation_ids_before: cancellationIdsBefore,
            p_request_body: body,
          }),
        );
        if (!marked.ok) {
          return {
            outcome: "blocked",
            attemptId,
            detail: refundRpcFailureCode(marked),
          };
        }
        if (!parseRefundMarkRequestedResult(marked.data, attempt.id)) {
          return {
            outcome: "blocked",
            attemptId,
            detail: "preflight_result_invalid",
          };
        }
        const persisted = await loadAttemptPostcondition(
          admin,
          attempt.id,
          "id, state, pg_total_before, pg_cancelled_before, pg_cancellable_before, pg_cancellation_ids_before, pg_idempotency_key, pg_requested_at, pg_request_body",
        );
        if (
          !persisted.ok ||
          !isRefundPgRequestedPostcondition(persisted.data, {
            attemptId: attempt.id,
            totalBefore: snapshot.totalAmount,
            cancelledBefore,
            cancellableBefore: snapshot.cancellableAmount,
            cancellationIdsBefore,
            requestBody: body,
          })
        ) {
          log.error("pay.refund_preflight_postcondition_fail", {
            attemptId,
            ...(!persisted.ok ? errInfo(persisted.error) : {}),
          });
          return {
            outcome: "blocked",
            attemptId,
            detail: "preflight_result_unproven",
          };
        }
        return executePgPost(
          admin,
          { ...attempt, state: "pg_requested", pg_request_body: body },
          paymentId,
          snapshot,
          orderEvidence,
        );
      }

      if (attempt.state === "pg_requested") {
        if (!attempt.pg_request_body || !attempt.pg_requested_at) {
          return {
            outcome: "blocked",
            attemptId,
            detail: "pg_request_incomplete",
          };
        }
        const age = Date.now() - new Date(attempt.pg_requested_at).getTime();
        if (markerCancel && markerCancel.status === "SUCCEEDED") {
          return recordSucceededAndCommit(
            admin,
            attempt.id,
            markerCancel,
            snapshot.raw,
          );
        }
        if (markerCancel && markerCancel.status === "FAILED") {
          return recordFailedToReview(
            admin,
            attempt.id,
            "FAILED",
            snapshot.raw,
            "pg_failed_observed",
          );
        }
        if (age <= PG_RETRY_CUTOFF_MS) {
          // 3h 내 — 동일 key·동일 persisted body 재시도만(§7.4).
          return executePgPost(
            admin,
            attempt,
            paymentId,
            snapshot,
            orderEvidence,
          );
        }
        // 3h 경과 — 신규 POST 금지, 증빙 없으면 manual_review 전환(B.8.6 ⓑ).
        return recordFailedToReview(
          admin,
          attempt.id,
          "OUTSTANDING",
          snapshot.raw,
          "retry_cutoff_elapsed",
        );
      }

      if (attempt.state === "pg_pending") {
        if (markerCancel && markerCancel.status === "SUCCEEDED") {
          return recordSucceededAndCommit(
            admin,
            attempt.id,
            markerCancel,
            snapshot.raw,
          );
        }
        if (markerCancel && markerCancel.status === "FAILED") {
          return recordFailedToReview(
            admin,
            attempt.id,
            "FAILED",
            snapshot.raw,
            "pg_failed_observed",
          );
        }
        return { outcome: "pending", attemptId };
      }

      // manual_review·manual_pending 은 auto 대상 아님 — 운영자 액션(switch/commit_manual/replan) 대기.
      return {
        outcome: "blocked",
        attemptId,
        detail: `state_${attempt.state}`,
      };
    })(),
    ingest.issuesOpened,
  );
}

/** 영속된 body/key 로 부분취소 POST 실행 + 결과 반영(§7.3 4분류). */
async function executePgPost(
  admin: SupabaseClient,
  attempt: AttemptRow,
  paymentId: string,
  freshSnapshot: PortonePaymentSnapshot,
  orderEvidence: RefundOrderEvidence,
): Promise<ProcessAttemptOutcome> {
  const body = attempt.pg_request_body!;
  const pc = await cancelPortonePaymentPartial({
    paymentId,
    storeId: orderEvidence.expected_store_id!,
    attemptId: attempt.id,
    amount: body.amount,
    currentCancellableAmount: body.currentCancellableAmount,
  });
  if (pc.ok) {
    if (pc.cancellation.status === "SUCCEEDED") {
      return recordSucceededAndCommit(admin, attempt.id, pc.cancellation, pc.raw);
    }
    // REQUESTED(비동기 처리 중) — pending 기록 후 폴링으로 종단(§6).
    const record = await resolveRefundRpc(() =>
      admin.rpc("admin_refund_record_pg_result", {
        p_attempt_id: attempt.id,
        p_result: "pending",
        p_cancel_id: null,
        p_cancel_status: "REQUESTED",
        p_cancelled_amount: null,
        p_receipt_url: null,
        p_raw: pc.raw,
        p_requested_at: pc.cancellation.requestedAt,
        p_cancelled_at: null,
      }),
    );
    if (!record.ok) {
      return {
        outcome: "blocked",
        attemptId: attempt.id,
        detail: refundRpcFailureCode(record),
      };
    }
    if (!parseRefundRecordResult(record.data, { kind: "pending" })) {
      return {
        outcome: "blocked",
        attemptId: attempt.id,
        detail: "record_result_invalid",
      };
    }
    const pending = await loadAttemptPostcondition(admin, attempt.id, "state");
    if (
      !pending.ok ||
      !isRefundAttemptStatePostcondition(
        pending.data,
        ["pg_pending", "pg_succeeded", "committed"],
      )
    ) {
      return {
        outcome: "blocked",
        attemptId: attempt.id,
        detail: "record_result_unproven",
      };
    }
    return { outcome: "pending", attemptId: attempt.id };
  }

  if (pc.kind === "outstanding") {
    // POST 도달 불명 — 상태 보존(pg_requested), 3h 내 재시도/이후 증빙 폴링은 sweep 이 담당.
    log.warn("pay.refund_attempt_outstanding", { attemptId: attempt.id, error: pc.error });
    return { outcome: "outstanding", attemptId: attempt.id, detail: pc.error };
  }

  // stale_cancellable / already_cancelled / hard_reject — fresh 재관측 후 처리.
  const snapRes = await getPortonePaymentSnapshot(
    paymentId,
    orderEvidence.expected_store_id ?? undefined,
  );
  const snapshot = snapRes.ok ? snapRes.snapshot : freshSnapshot;
  const evidenceFailure = exactPortoneEvidenceFailure(
    snapshot,
    orderEvidence,
  );
  if (evidenceFailure) {
    log.error("pay.refund_retry_evidence_rejected", {
      attemptId: attempt.id,
      orderUuid: attempt.order_uuid,
      paymentId,
      reason: evidenceFailure,
    });
    return {
      outcome: "blocked",
      attemptId: attempt.id,
      detail:
        evidenceFailure === "legacy_snapshot"
          ? "payment_evidence_incomplete"
          : "payment_evidence_mismatch",
    };
  }
  const ingest = await ingestObservedCancellations(admin, attempt.order_uuid, snapshot);
  return addObservedIssues(
    await (async (): Promise<ProcessAttemptOutcome> => {
      if (ingest.failed > 0) {
        return {
          outcome: "blocked",
          attemptId: attempt.id,
          detail: "cancellation_ingest_failed",
        };
      }
      const markerCancel = findMarkerCancellation(snapshot, attempt.id);
      if (
        pc.kind === "already_cancelled" &&
        markerCancel &&
        markerCancel.status === "SUCCEEDED"
      ) {
        // 우리 POST 가 사실은 성공해 있었음(멱등 재발견) — 정상 종단.
        return recordSucceededAndCommit(
          admin,
          attempt.id,
          markerCancel,
          snapshot.raw,
        );
      }
      return recordFailedToReview(
        admin,
        attempt.id,
        "FAILED",
        snapshot.raw,
        pc.error,
      );
    })(),
    ingest.issuesOpened,
  );
}

/** reconcile 확장 sweep(B.8.6): open PG attempt 들을 독립 처리. */
export type RefundSweepResult = {
  attemptsChecked: number;
  transitions: number;
  issuesOpened: number;
  retryPending: number;
  systemErrors: number;
  boundedBacklogs: number;
  blocked: number;
  outstanding: number;
  pending: number;
};

export async function sweepOpenPgAttempts(
  admin: SupabaseClient,
  limit = 20,
  processAttempt: (
    admin: SupabaseClient,
    attemptId: string,
  ) => Promise<ProcessAttemptOutcome> = processAttemptAuto,
): Promise<RefundSweepResult> {
  const rowsRead = await resolveFailClosedRead(() =>
    admin
      .from("order_refund_attempts")
      .select("id, state")
      .in("state", ["pg_requested", "pg_pending", "pg_succeeded"])
      .order("created_at", { ascending: true })
      .limit(limit),
  );
  if (!rowsRead.ok) {
    log.error("pay.refund_sweep_query_fail", errInfo(rowsRead.error));
    throw new FailClosedReadError(
      "refund_sweep_lookup_failed",
      rowsRead.error,
    );
  }
  const rows = validateAdminRows<{ id: string; state: string }>(
    "refund_sweep.lookup",
    rowsRead.data,
    { id: "uuid", state: "string" },
  );
  let transitions = 0;
  let issuesOpened = 0;
  let retryPending = 0;
  let systemErrors = 0;
  let blocked = 0;
  let outstanding = 0;
  let pending = 0;
  for (const row of rows) {
    try {
      const res = await processAttempt(admin, row.id);
      issuesOpened += res.issuesOpened ?? 0;
      if (
        res.outcome === "processed" ||
        res.outcome === "manual_review" ||
        res.outcome === "pending"
      ) {
        transitions += 1;
      }
      if (res.outcome === "pending") {
        pending += 1;
        retryPending += 1;
      } else if (res.outcome === "blocked") {
        blocked += 1;
        if (refundAttemptOutcomeIsSystemError(res)) systemErrors += 1;
        else retryPending += 1;
      } else if (res.outcome === "outstanding") {
        outstanding += 1;
        if (refundAttemptOutcomeIsSystemError(res)) systemErrors += 1;
        else retryPending += 1;
      }
    } catch (e) {
      systemErrors += 1;
      log.warn("pay.refund_sweep_item_fail", { attemptId: row.id, ...errInfo(e) });
    }
  }
  return {
    attemptsChecked: rows.length,
    transitions,
    issuesOpened,
    retryPending,
    systemErrors,
    boundedBacklogs: rows.length >= limit ? 1 : 0,
    blocked,
    outstanding,
    pending,
  };
}
