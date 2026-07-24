import "server-only";
import { Webhook } from "@portone/server-sdk";
import { SERVER_ENV } from "@/lib/env.server";
import { PUBLIC_ENV } from "@/lib/env";
import { anyPaymentChannelConfigured } from "@/lib/pay-channels";
import { log, errInfo } from "@/lib/log";

/**
 * 포트원(PortOne) V2 연동 — 서버 전용.
 *
 * 흐름: 클라 브라우저 SDK `requestPayment`(paymentId=가맹점 채번) → 웹훅/폴링 → 서버는 항상
 * 단건 조회(GET /payments/{paymentId})로 재검증 후 지급(포트원 권장: 웹훅 내용 대신 API 재조회 신뢰).
 * 취소는 POST /payments/{paymentId}/cancel(전액). 웹훅 서명은 Standard Webhooks(@portone/server-sdk).
 */

// 리허설 stub E2E 만 오버라이드(PORTONE_API_BASE_URL) — 프로덕션 기본값 고정.
const PORTONE_API_URL = SERVER_ENV.PORTONE_API_BASE_URL;

/** 포트원 연동값 설정 여부 — 미설정이면 결제 라우트 비활성(503). 채널은 live/test 어느 한쪽이면 충분. */
export function portoneConfigured(): boolean {
  return (
    !!SERVER_ENV.PORTONE_V2_API_SECRET &&
    !!PUBLIC_ENV.PORTONE_STORE_ID &&
    anyPaymentChannelConfigured()
  );
}

/** 웹훅 검증 가능 여부 — 실연동/테스트 시크릿 중 하나라도 있으면 활성. */
export function portoneWebhookConfigured(): boolean {
  return !!SERVER_ENV.PORTONE_WEBHOOK_SECRET || !!SERVER_ENV.PORTONE_WEBHOOK_SECRET_TEST;
}

/** 취소 API 사용 가능 여부 — 단건 조회와 동일 시크릿(별도 키 없음). */
export function portoneCancelConfigured(): boolean {
  return !!SERVER_ENV.PORTONE_V2_API_SECRET;
}

/**
 * 포트원 paymentId — order_uuid 의 하이픈 제거 hex(32자).
 * KPN 이 paymentId 에 영문/숫자만 허용(하이픈 불가)해 UUID 원문을 쓸 수 없다.
 */
export function paymentIdForOrder(orderUuid: string): string {
  return orderUuid.replace(/-/g, "");
}

// 결제수단 ↔ 채널 매핑은 lib/pay-channels.ts(클라 공용 — 브라우저 SDK 호출에도 필요).

// ── 단건 조회 (GET /payments/{paymentId}) ──────────────────────────────
export type PortonePayment = {
  status:
    | "READY"
    | "PENDING"
    | "VIRTUAL_ACCOUNT_ISSUED"
    | "PAID"
    | "FAILED"
    | "PARTIAL_CANCELLED"
    | "CANCELLED";
  id: string; // paymentId(가맹점 채번)
  transactionId: string;
  orderName?: string;
  amount?: { total: number };
  /** 결제가 승인된 채널 — type 으로 테스트/실연동 대사(지급 백스톱). 실패(FAILED) 응답엔 없을 수 있음. */
  channel?: { type?: "LIVE" | "TEST" };
};

/**
 * 지급 전 채널 모드 대사 — 주문의 is_test 와 실제 승인 채널을 비교.
 * "테스트 채널 결제가 실주문(is_test=false)에 지급"되는 것만 차단(무료 크레딧 구멍의 최종 백스톱).
 * 반대(실채널 결제 → 테스트 주문)는 실돈이 이동했으므로 지급하되 경고(수동 확인).
 * 채널 정보가 응답에 없으면 판정 불가 → 통과(체크아웃이 서버 결정이라 평시엔 불일치 자체가 없음).
 */
export function paymentModeMismatch(
  payment: PortonePayment,
  orderIsTest: boolean
): "block" | "warn" | null {
  const type = payment.channel?.type;
  if (!type) return null;
  if (!orderIsTest && type === "TEST") return "block";
  if (orderIsTest && type === "LIVE") return "warn";
  return null;
}

export type GetPaymentResult =
  | { ok: true; payment: PortonePayment }
  | { ok: false; kind: "not_found" | "unreachable" | "error"; error: string };

/** 결제 단건 조회 — 지급/대사/수동정산 전 재검증의 단일 소스(웹훅 페이로드는 신뢰하지 않음). */
export async function getPortonePayment(paymentId: string): Promise<GetPaymentResult> {
  try {
    const res = await fetch(`${PORTONE_API_URL}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `PortOne ${SERVER_ENV.PORTONE_V2_API_SECRET}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (res.status === 404) {
      return { ok: false, kind: "not_found", error: "payment_not_found" };
    }
    if (!res.ok) {
      log.warn("pay.get_http_error", { status: res.status, paymentId });
      return { ok: false, kind: "error", error: `http_${res.status}` };
    }
    const payment = (await res.json()) as PortonePayment;
    if (!payment?.status || payment.id !== paymentId) {
      log.warn("pay.get_bad_payload", { paymentId });
      return { ok: false, kind: "error", error: "bad_payload" };
    }
    return { ok: true, payment };
  } catch (e) {
    log.warn("pay.get_exception", { paymentId, ...errInfo(e) });
    return { ok: false, kind: "unreachable", error: "request_exception" };
  }
}

// ── V2 정규화 스냅샷·부분취소 (v0.76 환불 saga — §6·§27) ────────────────
// 단건 조회 응답의 cancellations[]·취소 누계를 canonical 형태로 정규화한 스냅샷이
// 경제 재대사·record_pg_result p_raw·switch_to_manual 증빙·이벤트 ingest 의 단일 소스다.
// SDK(@portone/server-sdk ^0.19.0) 실재 필드만 사용 — 미확인 필드 신설 금지.

/** correlation marker(§27) — PG cancel reason 은 정확히 이 문자열(중립·PII 없음·200자 내). */
export const REFUND_MARKER_PREFIX = "BP_REFUND:";
export function refundCorrelationMarker(attemptId: string): string {
  return `${REFUND_MARKER_PREFIX}${attemptId}`.slice(0, 200);
}
/** marker 에서 attempt uuid 추출 — 형식 불일치는 null(fail-closed). */
export function parseRefundMarker(reason: string | null | undefined): string | null {
  if (!reason || !reason.startsWith(REFUND_MARKER_PREFIX)) return null;
  const id = reason.slice(REFUND_MARKER_PREFIX.length, REFUND_MARKER_PREFIX.length + 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}
/** Idempotency-Key = attempt.id 의 RFC 8941 quoted-string(따옴표 포함). */
export function refundIdempotencyKey(attemptId: string): string {
  return `"${attemptId}"`;
}

export type PortoneCancellationStatus = "REQUESTED" | "SUCCEEDED" | "FAILED" | "UNRECOGNIZED";
export type PortoneCancellationSnapshot = {
  id: string;
  status: PortoneCancellationStatus;
  totalAmount: number | null; // nonnegative safe integer 아니면 null(fail-closed)
  reason: string | null;
  requestedAt: string | null;
  cancelledAt: string | null;
  receiptUrl: string | null; // SUCCEEDED 전용 필드
};
export type PortonePaymentSnapshot = {
  paymentId: string;
  /** 정규화 status — 비공식 PAY_PENDING→PENDING, 미인식은 UNRECOGNIZED(신규 POST 금지). */
  status: PortonePayment["status"] | "UNRECOGNIZED";
  totalAmount: number | null;
  /** PG 측 취소 누계(amount.cancelled) — Σ SUCCEEDED 과 대사, 불일치 시 경고 후 PG 값 채택. */
  cancelledAmount: number | null;
  /** 취소가능액 = total − cancelled. 음수/판정불가 = null(호출부 fail-closed). */
  cancellableAmount: number | null;
  cancellations: PortoneCancellationSnapshot[];
  channelType: "LIVE" | "TEST" | null;
  raw: Record<string, unknown>;
};

function asSafeNonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "READY", "PENDING", "VIRTUAL_ACCOUNT_ISSUED", "PAID", "FAILED", "PARTIAL_CANCELLED", "CANCELLED",
]);

/** 원시 단건조회 JSON → canonical 스냅샷(정규화·금액 검증). */
export function normalizePortonePayment(
  paymentId: string,
  rawPayment: Record<string, unknown>
): PortonePaymentSnapshot {
  const statusRaw = String(rawPayment.status ?? "");
  const status =
    statusRaw === "PAY_PENDING"
      ? "PENDING"
      : PAYMENT_STATUSES.has(statusRaw)
        ? (statusRaw as PortonePayment["status"])
        : "UNRECOGNIZED";

  const amountObj = (rawPayment.amount ?? {}) as Record<string, unknown>;
  const totalAmount = asSafeNonNegInt(amountObj.total);
  const pgCancelled = asSafeNonNegInt(amountObj.cancelled);

  const cancellations: PortoneCancellationSnapshot[] = Array.isArray(rawPayment.cancellations)
    ? (rawPayment.cancellations as Record<string, unknown>[]).map((c) => {
        const st = String(c.status ?? "");
        return {
          id: String(c.id ?? ""),
          status: (st === "REQUESTED" || st === "SUCCEEDED" || st === "FAILED"
            ? st
            : "UNRECOGNIZED") as PortoneCancellationStatus,
          totalAmount: asSafeNonNegInt(c.totalAmount),
          reason: typeof c.reason === "string" ? c.reason : null,
          requestedAt: typeof c.requestedAt === "string" ? c.requestedAt : null,
          cancelledAt: typeof c.cancelledAt === "string" ? c.cancelledAt : null,
          receiptUrl: typeof c.receiptUrl === "string" ? c.receiptUrl : null,
        };
      })
    : [];

  // 금액 대사: Σ SUCCEEDED ≤ total, PG 누계와 일치 확인(불일치 = 경고 후 PG 값 채택).
  const succeededSum = cancellations
    .filter((c) => c.status === "SUCCEEDED")
    .reduce((s, c) => s + (c.totalAmount ?? 0), 0);
  let cancelledAmount = pgCancelled;
  if (pgCancelled === null) {
    cancelledAmount = succeededSum;
  } else if (pgCancelled !== succeededSum) {
    log.warn("pay.snapshot_cancelled_mismatch", { paymentId, pgCancelled, succeededSum });
  }
  const cancellableAmount =
    totalAmount !== null && cancelledAmount !== null && totalAmount - cancelledAmount >= 0
      ? totalAmount - cancelledAmount
      : null;
  if (totalAmount !== null && cancelledAmount !== null && cancelledAmount > totalAmount) {
    log.warn("pay.snapshot_cancelled_exceeds_total", { paymentId, totalAmount, cancelledAmount });
  }

  const channel = (rawPayment.channel ?? {}) as Record<string, unknown>;
  return {
    paymentId,
    status,
    totalAmount,
    cancelledAmount,
    cancellableAmount,
    cancellations,
    channelType: channel.type === "LIVE" || channel.type === "TEST" ? channel.type : null,
    raw: rawPayment,
  };
}

export type GetPaymentSnapshotResult =
  | { ok: true; snapshot: PortonePaymentSnapshot }
  | { ok: false; kind: "not_found" | "unreachable" | "error"; error: string };

/** fresh 단건 조회 → canonical 스냅샷. saga preflight·대사·증빙의 단일 소스. */
export async function getPortonePaymentSnapshot(
  paymentId: string
): Promise<GetPaymentSnapshotResult> {
  try {
    const res = await fetch(`${PORTONE_API_URL}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `PortOne ${SERVER_ENV.PORTONE_V2_API_SECRET}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (res.status === 404) return { ok: false, kind: "not_found", error: "payment_not_found" };
    if (!res.ok) {
      log.warn("pay.snapshot_http_error", { status: res.status, paymentId });
      return { ok: false, kind: "error", error: `http_${res.status}` };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    if (!raw?.status || raw.id !== paymentId) {
      log.warn("pay.snapshot_bad_payload", { paymentId });
      return { ok: false, kind: "error", error: "bad_payload" };
    }
    return { ok: true, snapshot: normalizePortonePayment(paymentId, raw) };
  } catch (e) {
    log.warn("pay.snapshot_exception", { paymentId, ...errInfo(e) });
    return { ok: false, kind: "unreachable", error: "request_exception" };
  }
}

// ── 부분취소 (POST /payments/{paymentId}/cancel — §7.3 exact 3필드 body) ─
export type PortonePartialCancelResult =
  | { ok: true; cancellation: PortoneCancellationSnapshot; raw: Record<string, unknown> }
  | {
      ok: false;
      /**
       * 오류 4분류(§7.3): stale_cancellable=취소가능액 CAS 불일치(fresh GET 재대사) /
       * already_cancelled=이미 취소(fresh GET 후 marker 귀속) / hard_reject=한도·확정 무이동(manual rail) /
       * outstanding=타임아웃·불명(3h 내 동일 key·body 재시도만).
       */
      kind: "stale_cancellable" | "already_cancelled" | "hard_reject" | "outstanding";
      error: string;
    };

const CANCEL_ERROR_KIND: Record<string, "stale_cancellable" | "already_cancelled" | "hard_reject"> = {
  CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN: "stale_cancellable",
  PAYMENT_ALREADY_CANCELLED: "already_cancelled",
  CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT: "hard_reject",
  CANCEL_TAX_AMOUNT_EXCEEDS_CANCELLABLE_TAX_AMOUNT: "hard_reject",
  CANCEL_TAX_FREE_AMOUNT_EXCEEDS_CANCELLABLE_TAX_FREE_AMOUNT: "hard_reject",
  SUM_OF_PARTS_EXCEEDS_CANCEL_AMOUNT: "hard_reject",
  PAYMENT_NOT_PAID: "hard_reject",
  PAYMENT_NOT_FOUND: "hard_reject",
  FORBIDDEN: "hard_reject",
  INVALID_REQUEST: "hard_reject",
  UNAUTHORIZED: "hard_reject",
  PG_PROVIDER: "hard_reject",
};

/**
 * 부분취소 POST — body 는 정확히 3필드 `{amount, reason, currentCancellableAmount}`(§7.3 — 명세·
 * 영속 pg_request_body·이 helper·PortOne stub 4자 동일). reason = correlation marker(§27),
 * Idempotency-Key = attempt uuid quoted(§7.4). 최초 POST 후 3h 내 동일 key·동일 body 재시도만 허용.
 */
export async function cancelPortonePaymentPartial(args: {
  paymentId: string;
  attemptId: string;
  amount: number;
  currentCancellableAmount: number;
}): Promise<PortonePartialCancelResult> {
  const body = {
    amount: args.amount,
    reason: refundCorrelationMarker(args.attemptId),
    currentCancellableAmount: args.currentCancellableAmount,
  };
  try {
    const res = await fetch(
      `${PORTONE_API_URL}/payments/${encodeURIComponent(args.paymentId)}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `PortOne ${SERVER_ENV.PORTONE_V2_API_SECRET}`,
          "Content-Type": "application/json",
          "Idempotency-Key": refundIdempotencyKey(args.attemptId),
        },
        body: JSON.stringify(body),
        // 라우트 maxDuration=120 안에서 PG 처리 대기(§B.8.1 — fetch 65s).
        signal: AbortSignal.timeout(65_000),
      }
    );
    if (res.ok) {
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const c = (raw.cancellation ?? {}) as Record<string, unknown>;
      const st = String(c.status ?? "");
      const cancellation: PortoneCancellationSnapshot = {
        id: String(c.id ?? ""),
        status: (st === "REQUESTED" || st === "SUCCEEDED" || st === "FAILED"
          ? st
          : "UNRECOGNIZED") as PortoneCancellationStatus,
        totalAmount: asSafeNonNegInt(c.totalAmount),
        reason: typeof c.reason === "string" ? c.reason : null,
        requestedAt: typeof c.requestedAt === "string" ? c.requestedAt : null,
        cancelledAt: typeof c.cancelledAt === "string" ? c.cancelledAt : null,
        receiptUrl: typeof c.receiptUrl === "string" ? c.receiptUrl : null,
      };
      return { ok: true, cancellation, raw };
    }
    const errBody = (await res.json().catch(() => null)) as { type?: string } | null;
    const type = errBody?.type ?? `http_${res.status}`;
    const kind = (errBody?.type && CANCEL_ERROR_KIND[errBody.type]) ||
      (res.status >= 500 ? "outstanding" : "hard_reject");
    log.warn("pay.partial_cancel_rejected", {
      paymentId: args.paymentId, attemptId: args.attemptId, type, status: res.status, kind,
    });
    return { ok: false, kind, error: type };
  } catch (e) {
    // 타임아웃·네트워크 불명 — POST 가 PG 에 도달했을 수 있다(outstanding): 동일 key·body 재시도만.
    log.warn("pay.partial_cancel_outstanding", {
      paymentId: args.paymentId, attemptId: args.attemptId, ...errInfo(e),
    });
    return { ok: false, kind: "outstanding", error: "request_exception" };
  }
}

// ── 웹훅 검증 (Standard Webhooks — raw body 필수) ──────────────────────
export type PortoneWebhookEvent = {
  type: string; // "Transaction.Paid" | "Transaction.Cancelled" | "Transaction.Failed" | ...
  timestamp?: string;
  data: { storeId?: string; paymentId?: string; transactionId?: string };
};

export type VerifyWebhookResult =
  | { ok: true; event: PortoneWebhookEvent }
  | { ok: false; error: string };

/**
 * 서명 검증 + 페이로드 구조 확인. 실패 = 위조/설정 오류(재시도 무의미).
 * 테스트/실연동 웹훅이 같은 URL 로 들어오므로(콘솔 환경별 등록) 실연동 → 테스트 시크릿 순으로 시도.
 */
export async function verifyPortoneWebhook(
  rawBody: string,
  headers: Headers
): Promise<VerifyWebhookResult> {
  const headerObj = Object.fromEntries(headers.entries());
  const secrets = [SERVER_ENV.PORTONE_WEBHOOK_SECRET, SERVER_ENV.PORTONE_WEBHOOK_SECRET_TEST].filter(
    Boolean
  );
  for (const secret of secrets) {
    try {
      const verified = (await Webhook.verify(
        secret,
        rawBody,
        headerObj
      )) as unknown as PortoneWebhookEvent;
      if (!verified?.type) return { ok: false, error: "unrecognized_event" };
      return { ok: true, event: verified };
    } catch {
      // 다음 시크릿으로 — 두 환경 웹훅이 한 URL 을 공유하는 정상 상황.
    }
  }
  log.warn("pay.webhook_verify_fail", { tried: secrets.length });
  return { ok: false, error: "verification_failed" };
}
