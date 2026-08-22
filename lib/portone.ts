import "server-only";
import { Webhook } from "@portone/server-sdk";
import { SERVER_ENV } from "@/lib/env.server";
import { PUBLIC_ENV } from "@/lib/env";
import { anyPaymentChannelConfigured } from "@/lib/pay-channels";
import { log, errInfo } from "@/lib/log";
import { classifyPortoneCancelResponse } from "@/lib/pay/portone-cancel-contract";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";

/**
 * 포트원(PortOne) V2 연동 — 서버 전용.
 *
 * 흐름: 클라 브라우저 SDK `requestPayment`(paymentId=가맹점 채번) → 웹훅/폴링 → 서버는 항상
 * 단건 조회(GET /payments/{paymentId})로 재검증 후 지급(포트원 권장: 웹훅 내용 대신 API 재조회 신뢰).
 * 취소는 POST /payments/{paymentId}/cancel(전액). 웹훅 서명은 Standard Webhooks(@portone/server-sdk).
 */

// 리허설 stub E2E 만 오버라이드(PORTONE_API_BASE_URL) — 프로덕션 기본값 고정.
const PORTONE_API_URL = SERVER_ENV.PORTONE_API_BASE_URL;
export const PORTONE_RESPONSE_MAX_BODY_BYTES = 256 * 1024;

async function readPortoneJson(
  response: Response,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: "too_large" | "read_failed" | "invalid_json" }
> {
  const bounded = await readBoundedResponseBytes(
    response,
    PORTONE_RESPONSE_MAX_BODY_BYTES,
  );
  if (!bounded.ok) return bounded;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bounded.bytes,
    );
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

/** 포트원 연동값 설정 여부 — 미설정이면 결제 라우트 비활성(503). 채널은 live/test 어느 한쪽이면 충분. */
/**
 * 미해결 결제 intent(pending/failed·미지급·미취소)의 시효(ms) — 이 시간이 지나면
 * 포트원 단건조회로 비-PAID 를 재확인한 뒤 canceled 로 종단한다(사용자 전역 1-intent
 * 잠금 해제). 'failed=준종단(늦은 PAID 부활 지급)' 창을 이 값으로 한정하는 결정:
 * 포트원 결제창 세션은 이보다 훨씬 짧아 실부활 가능성이 소멸한 뒤다. reconcile 크론
 * (자동)과 어드민 취소(수동)가 공유한다. 배경: 2026-08-19 — 7월 결제창 이탈 잔재
 * failed 가 영구 잠금이 되어 실계정 결제가 전면 거절된 실사고.
 * 24h → 6h(2026-08-23, 사용자 결정): 종단돼도 재시도 결제는 동일 경로·동일 결과이고,
 * 종단 직후 늦은 PAID 도 grant RPC 가 미지급 canceled 주문에 지급을 허용해 손실이 없다.
 */
export const PAYMENT_INTENT_EXPIRE_MS = 6 * 60 * 60 * 1000;

export function portoneConfigured(): boolean {
  return (
    !!SERVER_ENV.PORTONE_V2_API_SECRET &&
    !!PUBLIC_ENV.PORTONE_STORE_ID &&
    anyPaymentChannelConfigured()
  );
}

/** 웹훅 검증 가능 여부 — 실연동/테스트 시크릿 중 하나라도 있으면 활성. */
export function portoneWebhookConfigured(): boolean {
  return (
    !!SERVER_ENV.PORTONE_WEBHOOK_SECRET ||
    !!SERVER_ENV.PORTONE_WEBHOOK_SECRET_TEST
  );
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
  currency?: string;
  storeId?: string;
  /** 결제가 승인된 채널 — type 으로 테스트/실연동 대사(지급 백스톱). 실패(FAILED) 응답엔 없을 수 있음. */
  channel?: { type?: "LIVE" | "TEST"; key?: string };
};

/**
 * 지급 전 채널 모드 대사 — 주문의 is_test 와 실제 승인 채널을 비교.
 * "테스트 채널 결제가 실주문(is_test=false)에 지급"되는 것만 차단(무료 크레딧 구멍의 최종 백스톱).
 * 반대(실채널 결제 → 테스트 주문)는 실돈이 이동했으므로 지급하되 경고(수동 확인).
 * 채널 정보가 응답에 없으면 판정 불가 → 통과(체크아웃이 서버 결정이라 평시엔 불일치 자체가 없음).
 */
export function paymentModeMismatch(
  payment: PortonePayment,
  orderIsTest: boolean,
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
export async function getPortonePayment(
  paymentId: string,
): Promise<GetPaymentResult> {
  try {
    const res = await fetch(
      `${PORTONE_API_URL}/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: {
          Authorization: `PortOne ${SERVER_ENV.PORTONE_V2_API_SECRET}`,
        },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
        redirect: "error",
      },
    );
    if (res.status === 404) {
      return { ok: false, kind: "not_found", error: "payment_not_found" };
    }
    if (!res.ok) {
      log.warn("pay.get_http_error", { status: res.status, paymentId });
      return { ok: false, kind: "error", error: `http_${res.status}` };
    }
    const decoded = await readPortoneJson(res);
    if (!decoded.ok) {
      log.warn("pay.get_bad_payload", {
        paymentId,
        reason: decoded.error,
      });
      return {
        ok: false,
        kind: decoded.error === "read_failed" ? "unreachable" : "error",
        error:
          decoded.error === "read_failed" ? "request_exception" : "bad_payload",
      };
    }
    const payment = decoded.value as PortonePayment;
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
export function parseRefundMarker(
  reason: string | null | undefined,
): string | null {
  if (!reason || !reason.startsWith(REFUND_MARKER_PREFIX)) return null;
  const id = reason.slice(
    REFUND_MARKER_PREFIX.length,
    REFUND_MARKER_PREFIX.length + 36,
  );
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    id,
  )
    ? id
    : null;
}
/** Idempotency-Key = attempt.id 의 RFC 8941 quoted-string(따옴표 포함). */
export function refundIdempotencyKey(attemptId: string): string {
  return `"${attemptId}"`;
}

export type PortoneCancellationStatus =
  "REQUESTED" | "SUCCEEDED" | "FAILED" | "UNRECOGNIZED";
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
  /** PG 측 취소 누계(amount.cancelled) — Σ SUCCEEDED 과 정확히 대사되지 않으면 null(fail-closed). */
  cancelledAmount: number | null;
  /** 취소가능액 = total − cancelled. 음수/판정불가 = null(호출부 fail-closed). */
  cancellableAmount: number | null;
  cancellations: PortoneCancellationSnapshot[];
  channelType: "LIVE" | "TEST" | null;
  channelKey: string | null;
  currency: "KRW" | null;
  storeId: string | null;
  raw: Record<string, unknown>;
};

function asSafeNonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "READY",
  "PENDING",
  "VIRTUAL_ACCOUNT_ISSUED",
  "PAID",
  "FAILED",
  "PARTIAL_CANCELLED",
  "CANCELLED",
]);
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const SAFE_WIRE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeWireText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    SAFE_WIRE_TEXT_RE.test(value)
  );
}

function rfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_RE.exec(value);
  if (!match) return false;
  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
    ,
    offsetHourRaw,
    offsetMinuteRaw,
  ] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = offsetHourRaw === undefined ? 0 : Number(offsetHourRaw);
  const offsetMinute =
    offsetMinuteRaw === undefined ? 0 : Number(offsetMinuteRaw);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function optionalHttpsUrl(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

function strictCancellation(
  value: unknown,
): PortoneCancellationSnapshot | null {
  const row = record(value);
  if (
    !row ||
    (row.status !== "REQUESTED" &&
      row.status !== "SUCCEEDED" &&
      row.status !== "FAILED") ||
    !safeWireText(row.id, 256) ||
    !Number.isSafeInteger(row.totalAmount) ||
    (row.totalAmount as number) <= 0 ||
    !Number.isSafeInteger(row.taxFreeAmount) ||
    (row.taxFreeAmount as number) < 0 ||
    !Number.isSafeInteger(row.vatAmount) ||
    (row.vatAmount as number) < 0 ||
    (row.taxFreeAmount as number) > (row.totalAmount as number) ||
    (row.vatAmount as number) > (row.totalAmount as number) ||
    !safeWireText(row.reason, 200) ||
    !rfc3339Timestamp(row.requestedAt) ||
    (row.cancelledAt !== undefined &&
      row.cancelledAt !== null &&
      !rfc3339Timestamp(row.cancelledAt)) ||
    !optionalHttpsUrl(row.receiptUrl)
  ) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    totalAmount: row.totalAmount as number,
    reason: row.reason,
    requestedAt: row.requestedAt,
    cancelledAt: typeof row.cancelledAt === "string" ? row.cancelledAt : null,
    receiptUrl: typeof row.receiptUrl === "string" ? row.receiptUrl : null,
  };
}

/** 원시 단건조회 JSON → canonical 스냅샷(정규화·금액 검증). */
export function normalizePortonePayment(
  paymentId: string,
  rawPayment: Record<string, unknown>,
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

  const cancellations: PortoneCancellationSnapshot[] = Array.isArray(
    rawPayment.cancellations,
  )
    ? rawPayment.cancellations.map((value) => {
        const c = record(value) ?? {};
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

  // 금액 대사: Σ SUCCEEDED 와 PG 누계가 정확히 일치해야만 취소가능액을 계산한다.
  const succeededSum = cancellations
    .filter((c) => c.status === "SUCCEEDED")
    .reduce((s, c) => s + (c.totalAmount ?? 0), 0);
  const cancellationAmountsComplete = cancellations.every(
    (c) => c.status !== "SUCCEEDED" || c.totalAmount !== null,
  );
  const cancellationSumMatches =
    pgCancelled !== null &&
    cancellationAmountsComplete &&
    pgCancelled === succeededSum;
  if (
    pgCancelled !== null &&
    cancellationAmountsComplete &&
    pgCancelled !== succeededSum
  ) {
    log.warn("pay.snapshot_cancelled_mismatch", {
      paymentId,
      pgCancelled,
      succeededSum,
    });
  }
  // `amount.cancelled` is required by PortOne's PaymentAmount contract.
  // Missing/invalid/mismatched evidence is unknown, never "zero cancelled".
  const cancelledAmount =
    pgCancelled !== null && cancellationSumMatches ? pgCancelled : null;
  const cancellableAmount =
    totalAmount !== null &&
    cancelledAmount !== null &&
    totalAmount - cancelledAmount >= 0
      ? totalAmount - cancelledAmount
      : null;
  if (
    totalAmount !== null &&
    cancelledAmount !== null &&
    cancelledAmount > totalAmount
  ) {
    log.warn("pay.snapshot_cancelled_exceeds_total", {
      paymentId,
      totalAmount,
      cancelledAmount,
    });
  }

  const channel = (rawPayment.channel ?? {}) as Record<string, unknown>;
  return {
    paymentId,
    status,
    totalAmount,
    cancelledAmount,
    cancellableAmount,
    cancellations,
    channelType:
      channel.type === "LIVE" || channel.type === "TEST" ? channel.type : null,
    channelKey: safeWireText(channel.key, 256) ? channel.key : null,
    currency: rawPayment.currency === "KRW" ? "KRW" : null,
    storeId: safeWireText(rawPayment.storeId, 128) ? rawPayment.storeId : null,
    raw: rawPayment,
  };
}

/**
 * Provider 2xx trust boundary. Additive fields are allowed, but every required
 * economic field for PAID/PARTIAL_CANCELLED/CANCELLED must be present,
 * correlated and internally consistent before any local money mutation.
 */
export function parsePortonePaymentSnapshot(
  paymentId: string,
  value: unknown,
): PortonePaymentSnapshot | null {
  const raw = record(value);
  if (!raw || raw.id !== paymentId || typeof raw.status !== "string") {
    return null;
  }
  const snapshot = normalizePortonePayment(paymentId, raw);
  if (snapshot.status === "UNRECOGNIZED") {
    // Future provider status is observable but cannot activate a local branch.
    return snapshot;
  }

  const moneyStatus =
    snapshot.status === "PAID" ||
    snapshot.status === "PARTIAL_CANCELLED" ||
    snapshot.status === "CANCELLED";
  if (!moneyStatus) return snapshot;

  const strictCancellations = Array.isArray(raw.cancellations)
    ? raw.cancellations.map(strictCancellation)
    : snapshot.status === "PAID" && raw.cancellations === undefined
      ? []
      : null;
  if (
    !safeWireText(raw.transactionId, 500) ||
    snapshot.totalAmount === null ||
    snapshot.cancelledAmount === null ||
    snapshot.cancellableAmount === null ||
    snapshot.channelType === null ||
    snapshot.channelKey === null ||
    snapshot.currency === null ||
    snapshot.storeId === null ||
    strictCancellations === null ||
    strictCancellations.some((row) => row === null) ||
    !optionalHttpsUrl(raw.receiptUrl)
  ) {
    return null;
  }

  const cancellations = strictCancellations as PortoneCancellationSnapshot[];
  const succeededSum = cancellations
    .filter((row) => row.status === "SUCCEEDED")
    .reduce((sum, row) => sum + (row.totalAmount ?? 0), 0);
  if (succeededSum !== snapshot.cancelledAmount) return null;

  if (
    snapshot.status === "PAID" &&
    (!rfc3339Timestamp(raw.paidAt) || snapshot.cancelledAmount !== 0)
  ) {
    return null;
  }
  if (
    snapshot.status === "PARTIAL_CANCELLED" &&
    (snapshot.cancelledAmount <= 0 ||
      snapshot.cancelledAmount >= snapshot.totalAmount)
  ) {
    return null;
  }
  return { ...snapshot, cancellations };
}

export type GetPaymentSnapshotResult =
  | { ok: true; snapshot: PortonePaymentSnapshot }
  | { ok: false; kind: "not_found" | "unreachable" | "error"; error: string };

/** fresh 단건 조회 → canonical 스냅샷. saga preflight·대사·증빙의 단일 소스. */
export async function getPortonePaymentSnapshot(
  paymentId: string,
  storeId?: string,
  signal?: AbortSignal,
): Promise<GetPaymentSnapshotResult> {
  try {
    const storeQuery =
      typeof storeId === "string" && storeId.length > 0
        ? `?storeId=${encodeURIComponent(storeId)}`
        : "";
    const res = await fetch(
      `${PORTONE_API_URL}/payments/${encodeURIComponent(paymentId)}${storeQuery}`,
      {
        headers: {
          Authorization: `PortOne ${SERVER_ENV.PORTONE_V2_API_SECRET}`,
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        cache: "no-store",
        redirect: "error",
      },
    );
    if (res.status === 404)
      return { ok: false, kind: "not_found", error: "payment_not_found" };
    if (!res.ok) {
      log.warn("pay.snapshot_http_error", { status: res.status, paymentId });
      return { ok: false, kind: "error", error: `http_${res.status}` };
    }
    const decoded = await readPortoneJson(res);
    if (!decoded.ok) {
      log.warn("pay.snapshot_bad_payload", {
        paymentId,
        reason: decoded.error,
      });
      return {
        ok: false,
        kind: decoded.error === "read_failed" ? "unreachable" : "error",
        error:
          decoded.error === "read_failed" ? "request_exception" : "bad_payload",
      };
    }
    const raw = decoded.value;
    const snapshot = parsePortonePaymentSnapshot(paymentId, raw);
    if (!snapshot) {
      log.warn("pay.snapshot_bad_payload", { paymentId });
      return { ok: false, kind: "error", error: "bad_payload" };
    }
    return { ok: true, snapshot };
  } catch (e) {
    log.warn("pay.snapshot_exception", { paymentId, ...errInfo(e) });
    return { ok: false, kind: "unreachable", error: "request_exception" };
  }
}

// ── 부분취소 (POST /payments/{paymentId}/cancel — §7.3 economic CAS + store pin) ─
export type PortonePartialCancelResult =
  | {
      ok: true;
      cancellation: PortoneCancellationSnapshot & {
        status: "REQUESTED" | "SUCCEEDED";
      };
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      /**
       * 오류 4분류(§7.3): stale_cancellable=취소가능액 CAS 불일치(fresh GET 재대사) /
       * already_cancelled=이미 취소(fresh GET 후 marker 귀속) / hard_reject=한도·확정 무이동(manual rail) /
       * outstanding=타임아웃·불명(3h 내 동일 key·body 재시도만).
       */
      kind:
        | "stale_cancellable"
        | "already_cancelled"
        | "hard_reject"
        | "outstanding";
      error: string;
    };

const CANCEL_ERROR_KIND: Record<
  string,
  "stale_cancellable" | "already_cancelled" | "hard_reject"
> = {
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
 * 부분취소 POST — 경제 CAS 3필드는 영속 pg_request_body와 일치하고, wire body에는
 * 주문에 동결된 storeId를 함께 보낸다. PortOne 공식 SDK도 storeId를 취소 body에
 * 포함하며, 이를 생략하면 인증 정보의 기본 store로 해석되어 다중-store 전환에서
 * 잘못된 namespace를 취소할 수 있다. reason = correlation marker(§27),
 * Idempotency-Key = attempt uuid quoted(§7.4). 최초 POST 후 3h 내 동일 key·동일 body 재시도만 허용.
 */
export async function cancelPortonePaymentPartial(args: {
  paymentId: string;
  storeId: string;
  attemptId: string;
  amount: number;
  currentCancellableAmount: number;
}): Promise<PortonePartialCancelResult> {
  const body = {
    storeId: args.storeId,
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
        redirect: "error",
      },
    );
    if (res.ok) {
      const decoded = await readPortoneJson(res);
      const rawValue = decoded.ok ? decoded.value : null;
      const classified = classifyPortoneCancelResponse(rawValue, {
        amount: args.amount,
        reason: body.reason,
      });
      if (classified.kind === "uncertain") {
        log.warn("pay.partial_cancel_bad_payload", {
          paymentId: args.paymentId,
          attemptId: args.attemptId,
          ...(decoded.ok ? {} : { reason: decoded.error }),
        });
        return {
          ok: false,
          kind: "outstanding",
          error: "bad_payload",
        };
      }
      if (classified.kind === "failed") {
        log.warn("pay.partial_cancel_failed_response", {
          paymentId: args.paymentId,
          attemptId: args.attemptId,
          cancellationId: classified.cancellation.id,
        });
        return {
          ok: false,
          kind: "hard_reject",
          error: "cancellation_failed",
        };
      }
      return {
        ok: true,
        cancellation: classified.cancellation,
        raw: rawValue as Record<string, unknown>,
      };
    }
    const decoded = await readPortoneJson(res);
    const errBody = record(decoded.ok ? decoded.value : null);
    const errorType =
      typeof errBody?.type === "string" &&
      /^[A-Z][A-Z0-9_]{0,99}$/.test(errBody.type)
        ? errBody.type
        : null;
    const type = errorType ?? `http_${res.status}`;
    const kind =
      (errorType && CANCEL_ERROR_KIND[errorType]) ||
      (res.status >= 500 ? "outstanding" : "hard_reject");
    log.warn("pay.partial_cancel_rejected", {
      paymentId: args.paymentId,
      attemptId: args.attemptId,
      type,
      status: res.status,
      kind,
    });
    return { ok: false, kind, error: type };
  } catch (e) {
    // 타임아웃·네트워크 불명 — POST 가 PG 에 도달했을 수 있다(outstanding): 동일 key·body 재시도만.
    log.warn("pay.partial_cancel_outstanding", {
      paymentId: args.paymentId,
      attemptId: args.attemptId,
      ...errInfo(e),
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
  { ok: true; event: PortoneWebhookEvent } | { ok: false; error: string };

/**
 * 서명 검증 + 페이로드 구조 확인. 실패 = 위조/설정 오류(재시도 무의미).
 * 테스트/실연동 웹훅이 같은 URL 로 들어오므로(콘솔 환경별 등록) 실연동 → 테스트 시크릿 순으로 시도.
 */
export async function verifyPortoneWebhook(
  rawBody: string,
  headers: Headers,
): Promise<VerifyWebhookResult> {
  const headerObj = Object.fromEntries(headers.entries());
  const secrets = [
    SERVER_ENV.PORTONE_WEBHOOK_SECRET,
    SERVER_ENV.PORTONE_WEBHOOK_SECRET_TEST,
  ].filter(Boolean);
  for (const secret of secrets) {
    try {
      const verified = (await Webhook.verify(
        secret,
        rawBody,
        headerObj,
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
