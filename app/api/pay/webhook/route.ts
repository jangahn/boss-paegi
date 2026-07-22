import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  portoneWebhookConfigured,
  verifyPortoneWebhook,
  getPortonePayment,
  paymentModeMismatch,
} from "@/lib/portone";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 포트원 결제 웹훅. public — 세션 없음(requireMember 금지), proxy/인증으로 막지 말 것(lib/routes.ts WEBHOOK_PATHS).
 *
 * 프로토콜(페이앱 SUCCESS/FAIL 텍스트 규약과 다름):
 *  - 2xx = 확인(재전송 중단) / 그 외 = 포트원이 최대 5회 재전송(exponential backoff).
 *  - 서명은 Standard Webhooks(raw body 필수 — formData/json 파싱 전에 text() 로 읽는다).
 *  - 페이로드는 참조로만 쓰고, 상태·금액은 **단건 조회 API 재검증**만 신뢰(포트원 권장 패턴).
 * 응답 3분류(기존 설계 사상 유지): 위조/우리 것 아님 → 재시도 무의미(401/200), 일시 오류 → 5xx(재시도 유도),
 * 처리 완료·중복 → 200.
 */
export async function POST(req: NextRequest) {
  if (!portoneWebhookConfigured()) {
    return NextResponse.json({ error: "webhook_unavailable" }, { status: 503 });
  }

  const rawBody = await req.text();
  const verified = await verifyPortoneWebhook(rawBody, req.headers);
  if (!verified.ok) {
    // 서명 불일치 = 위조 또는 시크릿 설정 오류 — 재시도해도 동일하므로 401(로그로 가시화).
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const event = verified.event;

  const paymentId = event.data?.paymentId;
  if (!paymentId) {
    // 빌링키 등 결제 외 이벤트 — 이 제품은 단건 결제만 사용. 확인만 하고 종료.
    log.info("pay.wh_ignored", { type: event.type });
    return NextResponse.json({ ok: true, ignored: true });
  }

  const admin = createAdminClient();
  const { data: order, error: loadErr } = await admin
    .from("orders")
    .select("order_uuid, user_id, amount, status, canceled_at, pg_tx_id, is_test")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (loadErr) {
    log.error("pay.wh_order_load_fail", { paymentId, ...errInfo(loadErr) });
    return NextResponse.json({ error: "order_load_failed" }, { status: 500 }); // 일시 오류 → 재시도
  }
  if (!order) {
    // 우리 주문이 아님(콘솔 수동 테스트 결제 등) — 재시도 무의미, 확인 응답. 경고로 가시화만.
    log.warn("pay.wh_order_not_found", { paymentId, type: event.type });
    return NextResponse.json({ ok: true, ignored: true });
  }

  // 상태·금액은 웹훅 페이로드가 아니라 단건 조회 재검증만 신뢰.
  const got = await getPortonePayment(paymentId);
  if (!got.ok) {
    if (got.kind === "not_found") {
      // 웹훅은 왔는데 조회 불가 — 비정상. 재시도로 해소될 수 있어 5xx.
      log.error("pay.wh_payment_not_found", { paymentId });
    }
    return NextResponse.json({ error: "payment_lookup_failed" }, { status: 502 });
  }
  const payment = got.payment;

  try {
    if (payment.status === "PAID") {
      const total = payment.amount?.total ?? -1;
      if (total !== order.amount) {
        // 단건 조회 금액이 주문 스냅샷과 다름 — 위변조/설정 오류 의심. 지급 금지, 운영 경고(재시도 무의미).
        log.error("pay.wh_amount_mismatch", {
          orderUuid: order.order_uuid,
          paymentId,
          got: total,
          expected: order.amount,
        });
        return NextResponse.json({ ok: false, error: "amount_mismatch" });
      }
      // 채널 모드 대사(백스톱) — 테스트 채널 결제가 실주문에 지급되는 것만 차단(무료 크레딧 구멍).
      const mismatch = paymentModeMismatch(payment, order.is_test === true);
      if (mismatch === "block") {
        log.error("pay.wh_test_channel_on_live_order", {
          orderUuid: order.order_uuid,
          paymentId,
        });
        await admin
          .from("orders")
          .update({ error_message: "test_channel_on_live_order" })
          .eq("order_uuid", order.order_uuid);
        return NextResponse.json({ ok: false, error: "channel_mode_mismatch" });
      }
      if (mismatch === "warn") {
        // 실채널 결제가 테스트 주문에 — 실돈이 이동했으므로 지급은 진행, 수동 확인 경고만.
        log.warn("pay.wh_live_channel_on_test_order", {
          orderUuid: order.order_uuid,
          paymentId,
        });
      }
      const { data: granted, error } = await Sentry.startSpan(
        { name: "pay.grant", attributes: { orderUuid: order.order_uuid } },
        () =>
          admin.rpc("mark_paid_and_grant", {
            p_order_uuid: order.order_uuid,
            p_pg_tx_id: payment.transactionId || null,
            p_price: total,
            p_raw: { webhook: event, verified_status: payment.status },
          })
      );
      if (error) {
        log.error("pay.wh_grant_fail", { orderUuid: order.order_uuid, ...errInfo(error) });
        return NextResponse.json({ error: "grant_failed" }, { status: 500 }); // 일시 오류 → 재시도
      }
      if (granted === false) {
        // PAID 재검증까지 됐는데 지급 안 됨 — 이미 지급(중복)·취소 선행 등.
        // 중복은 정상이지만 '수금됐는데 미지급' 가능성이 섞여 있어 경고로 가시화(Sentry).
        log.warn("pay.wh_paid_not_granted", {
          orderUuid: order.order_uuid,
          userId: order.user_id,
          orderStatus: order.status,
        });
      } else {
        // 정상 지급 vs 탈퇴자 무지급(deleted_at 가드) 구분 — 탈퇴자면 운영자 수동확인 위해 경고.
        const { data: chk } = await admin
          .from("orders")
          .select("error_message")
          .eq("order_uuid", order.order_uuid)
          .maybeSingle();
        if (
          (chk as { error_message?: string | null } | null)?.error_message ===
          "account_deleted_no_grant"
        ) {
          log.warn("pay.wh_deleted_no_grant", {
            orderUuid: order.order_uuid,
            userId: order.user_id,
          });
        } else {
          log.info("pay.wh_paid", { orderUuid: order.order_uuid, userId: order.user_id });
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (payment.status === "CANCELLED") {
      // paid→canceled 여도 paid_at 유지, 크레딧 자동 회수 없음(어드민 RECONCILE 이 회수 — 0058 admin_cancel_order).
      // canceled_at 은 최초 취소 시각 유지(이미 취소면 미변경) — 0057 폴백 정렬 갭 재발 방지.
      const { error: cancelErr } = await admin
        .from("orders")
        .update({
          status: "canceled",
          pg_status: payment.status,
          raw: { webhook: event, verified_status: payment.status },
          canceled_at: order.canceled_at ?? new Date().toISOString(),
          pg_tx_id: order.pg_tx_id ?? payment.transactionId ?? null,
        })
        .eq("order_uuid", order.order_uuid);
      if (cancelErr) {
        log.error("pay.wh_cancel_update_fail", {
          orderUuid: order.order_uuid,
          ...errInfo(cancelErr),
        });
        return NextResponse.json({ error: "cancel_update_failed" }, { status: 500 });
      }
      log.info("pay.wh_canceled", { orderUuid: order.order_uuid, pgStatus: payment.status });
      return NextResponse.json({ ok: true });
    }

    if (payment.status === "PARTIAL_CANCELLED") {
      // 자체 코드는 전액 취소만 쓰므로 부분취소 = 콘솔 수동 개입 신호. status 를 canceled 로 종단하면
      // 화해(환불 재시도)가 크레딧 **전량** 회수해 돈↔크레딧 정합이 깨진다(리뷰 확정 결함) → 기록+경고만.
      const { error: recErr } = await admin
        .from("orders")
        .update({ pg_status: payment.status, raw: { webhook: event, verified_status: payment.status } })
        .eq("order_uuid", order.order_uuid);
      if (recErr) {
        log.error("pay.wh_record_update_fail", { orderUuid: order.order_uuid, ...errInfo(recErr) });
        return NextResponse.json({ error: "record_update_failed" }, { status: 500 });
      }
      log.warn("pay.wh_partial_cancelled", {
        message: "부분취소 감지 — 크레딧 회수량 수동 판단 필요(자동 화해 금지)",
        orderUuid: order.order_uuid,
      });
      return NextResponse.json({ ok: true });
    }

    if (payment.status === "FAILED") {
      // 결제 시도 실패 — pending 만 failed 로(이미 paid/canceled 종단 상태는 건드리지 않음).
      const { error: failErr } = await admin
        .from("orders")
        .update({
          status: "failed",
          pg_status: payment.status,
          error_message: "pg_failed",
          raw: { webhook: event, verified_status: payment.status },
        })
        .eq("order_uuid", order.order_uuid)
        .eq("status", "pending");
      if (failErr) {
        log.error("pay.wh_fail_update_fail", { orderUuid: order.order_uuid, ...errInfo(failErr) });
        return NextResponse.json({ error: "fail_update_failed" }, { status: 500 });
      }
      log.info("pay.wh_failed", { orderUuid: order.order_uuid });
      return NextResponse.json({ ok: true });
    }

    // READY/PENDING/VIRTUAL_ACCOUNT_ISSUED 등 — 지급 없이 기록만.
    const { error: recErr } = await admin
      .from("orders")
      .update({ pg_status: payment.status, raw: { webhook: event, verified_status: payment.status } })
      .eq("order_uuid", order.order_uuid);
    if (recErr) {
      log.error("pay.wh_record_update_fail", { orderUuid: order.order_uuid, ...errInfo(recErr) });
      return NextResponse.json({ error: "record_update_failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error("pay.wh_exception", { orderUuid: order.order_uuid, ...errInfo(e) });
    return NextResponse.json({ error: "exception" }, { status: 500 });
  }
}
