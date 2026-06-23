import "server-only";
import { timingSafeEqual } from "node:crypto";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";
import type { CreditProduct } from "@/lib/credit-products";

/**
 * 페이앱(PayApp, 무사업자) REST 연동 — 서버 전용.
 *
 * 흐름: 결제요청(payrequest) → payurl 로 구매자 이동 → 완료통보(웹훅 feedbackurl).
 * recvphone 은 필수 파라미터지만 카드·네이버페이만 쓰고 smsuse=n 이라 더미 고정값 사용.
 * (매뉴얼 JS 예제도 동일 패턴 — 990원 실결제로 통과 검증 전제.)
 */

const PAYAPP_API_URL = "https://api.payapp.kr/oapi/apiLoad.html";
const RECVPHONE_DUMMY = "01000000000"; // smsuse=n + 카드/네이버페이 → 수신폰 불요(더미)
const OPENPAYTYPE = "card,naverpay"; // 비사업자 가능 수단(카카오페이 불가)
const CANCEL_STATES = new Set([8, 9, 16, 32, 64, 70, 71]); // 요청취소/승인취소/부분취소

/** 페이앱 연동값 설정 여부 — 미설정이면 결제 라우트 비활성. */
export function payappConfigured(): boolean {
  return !!SERVER_ENV.PAYAPP_USERID && !!SERVER_ENV.PAYAPP_LINKVAL;
}

export type PayRequestResult =
  | { ok: true; mulNo: string; payurl: string }
  | { ok: false; error: string };

/**
 * 결제요청(payrequest) — form-urlencoded POST. 응답은 URL-encoded query 문자열(JSON 아님).
 * 성공 시 결제창 URL(payurl)·주문번호(mul_no) 반환.
 */
export async function createPayRequest(args: {
  product: CreditProduct;
  userId: string;
  orderUuid: string;
  feedbackUrl: string;
  returnUrl: string;
}): Promise<PayRequestResult> {
  const body = new URLSearchParams({
    cmd: "payrequest",
    userid: SERVER_ENV.PAYAPP_USERID,
    goodname: args.product.goodname,
    price: String(args.product.price),
    recvphone: RECVPHONE_DUMMY,
    smsuse: "n",
    openpaytype: OPENPAYTYPE,
    skip_cstpage: "y",
    checkretry: "y",
    feedbackurl: args.feedbackUrl,
    returnurl: args.returnUrl,
    var1: args.userId,
    var2: args.orderUuid,
  });

  try {
    const res = await fetch(PAYAPP_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn("payapp.req_http_error", { status: res.status, orderUuid: args.orderUuid });
      return { ok: false, error: `http_${res.status}` };
    }
    const parsed = new URLSearchParams(await res.text());
    if (parsed.get("state") !== "1") {
      const error = parsed.get("errorMessage") || "payrequest_failed";
      log.warn("payapp.req_state_fail", { error, orderUuid: args.orderUuid });
      return { ok: false, error };
    }
    const mulNo = parsed.get("mul_no") ?? "";
    const payurl = parsed.get("payurl") ?? "";
    if (!mulNo || !payurl) {
      log.warn("payapp.req_no_payurl", { orderUuid: args.orderUuid });
      return { ok: false, error: "no_payurl" };
    }
    return { ok: true, mulNo, payurl };
  } catch (e) {
    log.warn("payapp.req_exception", { orderUuid: args.orderUuid, ...errInfo(e) });
    return { ok: false, error: "request_exception" };
  }
}

export type FeedbackParams = {
  linkval: string;
  orderUuid: string; // var2
  var1: string;
  price: number;
  mulNo: string;
  payState: number;
  raw: Record<string, string>;
};

// raw(감사 jsonb)에 절대 영구저장하면 안 되는 키 — linkval/linkkey 는 웹훅 비밀.
// (DB 유출 시 위변조 차단 비밀이 새어나가지 않게 — 검증엔 form 에서 직접 읽음.)
const RAW_DENYLIST = new Set(["linkval", "linkkey"]);

/** 웹훅 form(application/x-www-form-urlencoded) 파싱. raw 는 감사용 — 비밀키는 제외. */
export function parseFeedback(form: FormData): FeedbackParams {
  const get = (k: string) => form.get(k)?.toString() ?? "";
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (RAW_DENYLIST.has(k)) continue; // 비밀값은 DB 저장 금지
    raw[k] = typeof v === "string" ? v : "";
  }
  return {
    linkval: get("linkval"),
    orderUuid: get("var2"),
    var1: get("var1"),
    price: Number(get("price")) || 0,
    mulNo: get("mul_no"),
    payState: Number(get("pay_state")) || 0,
    raw,
  };
}

/** linkval(연동VALUE) 검증 — 위변조 웹훅 차단(LINKVAL 은 서버 비밀). 상수시간 비교. */
export function verifyLinkval(linkval: string): boolean {
  const expected = SERVER_ENV.PAYAPP_LINKVAL;
  if (!expected || !linkval) return false;
  const a = Buffer.from(linkval);
  const b = Buffer.from(expected);
  // 길이 다르면 timingSafeEqual 이 throw — 먼저 길이 체크(불일치 = 즉시 false).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 취소/환불 계열 pay_state 여부. */
export function isCancelState(payState: number): boolean {
  return CANCEL_STATES.has(payState);
}

// ── 결제 취소(paycancel) — 어드민 환불 자동연동(정산 전/D+5 내). 정산 후는 paycancelreq(미사용·수동). ──
const SAFE_CANCEL_MEMO_LENGTH = 100; // 페이앱 전송용만 잘라냄(ledger.reason 은 원문 보존).

// 보수적 allowlist — state=0 응답 중 '이미 취소됨'으로 확정 인정할 문구만(소문자 부분일치).
// ⚠️ 실제 문구는 dev 라이브 paycancel 응답으로 검증·확장 필요. 미스 시 'unknown' 으로 안전 실패(로컬 무변경).
// '이미/already' 한정자가 있는 명시 문구만 — bare "취소 완료"/"취소된 거래"는 부정문("취소 불가")에도 매칭돼 제외.
const ALREADY_CANCELED_MARKERS = ["이미 취소", "이미취소", "already cancel", "canceled already", "cancelled already"];
const SETTLED_MARKERS = ["정산", "d+5", "마감", "기간 경과", "기간경과", "settle"];

/** 취소 API 사용 가능 여부 — USERID/LINKVAL + 취소 전용 LINKKEY 필요. */
export function payappCancelConfigured(): boolean {
  return payappConfigured() && !!SERVER_ENV.PAYAPP_LINKKEY;
}

export type PayCancelResult =
  | { ok: true; alreadyCanceled: boolean } // state=1(방금 취소) 또는 allowlist(이미 취소됨) → 로컬 반영 안전
  | { ok: false; kind: "settled" | "unknown" | "unreachable"; error: string };

/**
 * paycancel 호출 — form-urlencoded POST, 응답은 URL-encoded(state/errorMessage).
 * 분류: state=1 → ok; state=0 & allowlist → ok(alreadyCanceled); state=0 & 정산문구 → settled;
 * 그 외 state=0 → unknown(운영 확인); 네트워크/timeout/비200 → unreachable.
 * 보수적: settled/실패를 '이미 취소'로 오판하지 않음 → 잘못된 로컬 회수 방지.
 */
export async function paycancelOrder(args: {
  mulNo: string;
  cancelMemo: string;
}): Promise<PayCancelResult> {
  const body = new URLSearchParams({
    cmd: "paycancel",
    userid: SERVER_ENV.PAYAPP_USERID,
    linkkey: SERVER_ENV.PAYAPP_LINKKEY,
    mul_no: args.mulNo,
    cancelmemo: args.cancelMemo.slice(0, SAFE_CANCEL_MEMO_LENGTH),
    partcancel: "0", // 전액 취소(v1)
  });

  try {
    const res = await fetch(PAYAPP_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn("payapp.cancel_http_error", { status: res.status, mulNo: args.mulNo });
      return { ok: false, kind: "unreachable", error: `http_${res.status}` };
    }
    const parsed = new URLSearchParams(await res.text());
    if (parsed.get("state") === "1") return { ok: true, alreadyCanceled: false };

    const errorMessage = parsed.get("errorMessage") ?? "";
    const msg = errorMessage.toLowerCase();
    // settled 를 먼저 — '정산 완료된 거래는 취소 완료 처리 불가' 처럼 두 의미가 겹치면 안전 방향(manual)으로.
    if (SETTLED_MARKERS.some((m) => msg.includes(m.toLowerCase()))) {
      log.warn("payapp.cancel_settled", { mulNo: args.mulNo, error: errorMessage });
      return { ok: false, kind: "settled", error: errorMessage || "settled" };
    }
    if (ALREADY_CANCELED_MARKERS.some((m) => msg.includes(m.toLowerCase()))) {
      return { ok: true, alreadyCanceled: true };
    }
    log.warn("payapp.cancel_unknown", { mulNo: args.mulNo, error: errorMessage });
    return { ok: false, kind: "unknown", error: errorMessage || "unknown_cancel_state" };
  } catch (e) {
    log.warn("payapp.cancel_exception", { mulNo: args.mulNo, ...errInfo(e) });
    return { ok: false, kind: "unreachable", error: "request_exception" };
  }
}
