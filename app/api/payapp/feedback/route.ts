import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseFeedback, verifyLinkval, isCancelState } from "@/lib/payapp";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// 페이앱 결제통보(웹훅). public — 세션 없음(requireMember 금지), proxy/인증으로 막지 말 것.
// 검증된 이벤트는 반드시 텍스트 "SUCCESS". 그 외(검증 실패·일시오류)엔 페이앱이 최대 10회 재시도.
const OK = () => new Response("SUCCESS");
const FAIL = () => new Response("FAIL");

export async function POST(req: NextRequest) {
  let fb;
  try {
    fb = parseFeedback(await req.formData());
  } catch (e) {
    log.warn("payapp.fb_parse_fail", errInfo(e));
    return FAIL();
  }

  // 1) linkval(연동VALUE) — 위변조 차단.
  if (!verifyLinkval(fb.linkval)) {
    log.warn("payapp.fb_bad_linkval", { orderUuid: fb.orderUuid, mulNo: fb.mulNo });
    return FAIL();
  }
  if (!fb.orderUuid) {
    log.warn("payapp.fb_no_order", { mulNo: fb.mulNo });
    return FAIL();
  }
  // mul_no(페이앱 결제번호)는 정상 결제통보면 항상 존재 — 없으면 거부(failed/위조 통보 차단).
  if (!fb.mulNo) {
    log.warn("payapp.fb_no_mulno", { orderUuid: fb.orderUuid });
    return FAIL();
  }

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("payapp_orders")
    .select("order_uuid, user_id, amount, status, mul_no")
    .eq("order_uuid", fb.orderUuid)
    .maybeSingle();

  // 2) DB 주문 기준 정합성(외부 입력 신뢰 금지).
  if (!order) {
    log.warn("payapp.fb_order_not_found", { orderUuid: fb.orderUuid });
    return FAIL();
  }
  if (fb.price !== order.amount) {
    log.warn("payapp.fb_price_mismatch", {
      orderUuid: fb.orderUuid,
      fbPrice: fb.price,
      amount: order.amount,
    });
    return FAIL();
  }
  if (fb.var1 !== order.user_id) {
    log.warn("payapp.fb_user_mismatch", { orderUuid: fb.orderUuid });
    return FAIL();
  }
  if (order.mul_no && order.mul_no !== fb.mulNo) {
    log.warn("payapp.fb_mulno_mismatch", { orderUuid: fb.orderUuid });
    return FAIL();
  }

  // 3) 이벤트별 — 검증 통과면 모두 SUCCESS. 지급 대상은 DB order.user_id.
  try {
    if (fb.payState === 4) {
      const { data: granted, error } = await Sentry.startSpan(
        { name: "payapp.grant", attributes: { orderUuid: fb.orderUuid } },
        () =>
          admin.rpc("mark_paid_and_grant", {
            p_order_uuid: order.order_uuid,
            p_mul_no: fb.mulNo || null,
            p_price: fb.price,
            p_raw: fb.raw,
          })
      );
      if (error) {
        log.error("payapp.fb_grant_fail", { orderUuid: fb.orderUuid, ...errInfo(error) });
        return FAIL(); // 일시 오류 → 재시도 유도
      }
      if (granted === false) {
        // 결제완료(4) 통보인데 지급 안 됨 — 이미 지급(중복)·취소 선행·금액 불일치 등.
        // 중복은 정상이지만, '수금됐는데 미지급' 가능성이 섞여 있어 경고로 가시화(Sentry).
        log.warn("payapp.fb_paid_not_granted", {
          orderUuid: fb.orderUuid,
          userId: order.user_id,
          orderStatus: order.status,
        });
      } else {
        log.info("payapp.fb_paid", { orderUuid: fb.orderUuid, userId: order.user_id });
      }
      return OK(); // 멱등 — 중복/이미처리도 SUCCESS(페이앱 재시도 중단)
    }

    if (isCancelState(fb.payState)) {
      // paid→canceled 여도 paid_at 유지(미변경), 크레딧 자동 회수 없음(v1 수동 운영).
      const { error: cancelErr } = await admin
        .from("payapp_orders")
        .update({ status: "canceled", pay_state: fb.payState, raw: fb.raw })
        .eq("order_uuid", order.order_uuid);
      if (cancelErr) {
        log.error("payapp.fb_cancel_update_fail", { orderUuid: fb.orderUuid, ...errInfo(cancelErr) });
        return FAIL(); // DB 실패 → 페이앱 재시도 유도(거짓 SUCCESS 금지)
      }
      log.info("payapp.fb_canceled", { orderUuid: fb.orderUuid, payState: fb.payState });
      return OK();
    }

    // pay_state=1(요청/생성) 등 — 지급 없이 기록만.
    const { error: recErr } = await admin
      .from("payapp_orders")
      .update({ pay_state: fb.payState, raw: fb.raw })
      .eq("order_uuid", order.order_uuid);
    if (recErr) {
      log.error("payapp.fb_record_update_fail", { orderUuid: fb.orderUuid, ...errInfo(recErr) });
      return FAIL();
    }
    return OK();
  } catch (e) {
    log.error("payapp.fb_exception", { orderUuid: fb.orderUuid, ...errInfo(e) });
    return FAIL();
  }
}
