import "server-only";
import { Webhook } from "@portone/server-sdk";
import { SERVER_ENV } from "@/lib/env.server";
import { PUBLIC_ENV } from "@/lib/env";
import { paymentChannels } from "@/lib/pay-channels";
import { log, errInfo } from "@/lib/log";

/**
 * 포트원(PortOne) V2 연동 — 서버 전용.
 *
 * 흐름: 클라 브라우저 SDK `requestPayment`(paymentId=가맹점 채번) → 웹훅/폴링 → 서버는 항상
 * 단건 조회(GET /payments/{paymentId})로 재검증 후 지급(포트원 권장: 웹훅 내용 대신 API 재조회 신뢰).
 * 취소는 POST /payments/{paymentId}/cancel(전액). 웹훅 서명은 Standard Webhooks(@portone/server-sdk).
 */

const PORTONE_API_URL = "https://api.portone.io";

/** 포트원 연동값 설정 여부 — 미설정이면 결제 라우트 비활성(503). */
export function portoneConfigured(): boolean {
  return (
    !!SERVER_ENV.PORTONE_V2_API_SECRET &&
    !!PUBLIC_ENV.PORTONE_STORE_ID &&
    paymentChannels().length > 0
  );
}

/** 웹훅 검증 가능 여부 — 시크릿 미설정이면 웹훅 라우트 비활성. */
export function portoneWebhookConfigured(): boolean {
  return !!SERVER_ENV.PORTONE_WEBHOOK_SECRET;
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
};

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

// ── 결제 취소 (POST /payments/{paymentId}/cancel — 전액) ───────────────
export type PortoneCancelResult =
  | { ok: true; alreadyCanceled: boolean }
  | { ok: false; kind: "unknown" | "unreachable"; error: string };

/**
 * 전액 취소. 구조화 에러 타입으로 분류(페이앱의 한국어 문구 allowlist 파싱 대체):
 * PAYMENT_ALREADY_CANCELLED → ok(alreadyCanceled — 환불 재시도 멱등의 핵심), 그 외 → unknown(로컬 무변경 안전 실패).
 */
export async function cancelPortonePayment(args: {
  paymentId: string;
  reason: string;
}): Promise<PortoneCancelResult> {
  try {
    const res = await fetch(
      `${PORTONE_API_URL}/payments/${encodeURIComponent(args.paymentId)}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `PortOne ${SERVER_ENV.PORTONE_V2_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: args.reason.slice(0, 200), requester: "Admin" }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (res.ok) return { ok: true, alreadyCanceled: false };

    const body = (await res.json().catch(() => null)) as { type?: string; message?: string } | null;
    if (body?.type === "PAYMENT_ALREADY_CANCELLED") {
      return { ok: true, alreadyCanceled: true };
    }
    log.warn("pay.cancel_unknown", { paymentId: args.paymentId, type: body?.type, status: res.status });
    return { ok: false, kind: "unknown", error: body?.type ?? `http_${res.status}` };
  } catch (e) {
    log.warn("pay.cancel_exception", { paymentId: args.paymentId, ...errInfo(e) });
    return { ok: false, kind: "unreachable", error: "request_exception" };
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

/** 서명 검증 + 페이로드 구조 확인. 실패 = 위조/설정 오류(재시도 무의미). */
export async function verifyPortoneWebhook(
  rawBody: string,
  headers: Headers
): Promise<VerifyWebhookResult> {
  try {
    const verified = (await Webhook.verify(
      SERVER_ENV.PORTONE_WEBHOOK_SECRET,
      rawBody,
      Object.fromEntries(headers.entries())
    )) as unknown as PortoneWebhookEvent;
    if (!verified?.type) return { ok: false, error: "unrecognized_event" };
    return { ok: true, event: verified };
  } catch (e) {
    log.warn("pay.webhook_verify_fail", errInfo(e));
    return { ok: false, error: "verification_failed" };
  }
}
