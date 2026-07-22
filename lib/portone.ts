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

const PORTONE_API_URL = "https://api.portone.io";

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
