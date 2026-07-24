import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  portoneWebhookConfigured,
  verifyPortoneWebhook,
  getPortonePaymentSnapshot,
} from "@/lib/portone";
import { handleObservedCancellation } from "@/lib/refund-saga";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/** 채널 모드 대사(백스톱) — paymentModeMismatch 와 동일 판정을 snapshot.channelType 으로 수행. */
function channelModeMismatch(
  channelType: "LIVE" | "TEST" | null,
  orderIsTest: boolean
): "block" | "warn" | null {
  if (channelType === "TEST" && !orderIsTest) return "block";
  if (channelType === "LIVE" && orderIsTest) return "warn";
  return null;
}

/**
 * 포트원 결제 웹훅. public — 세션 없음(requireMember 금지), proxy/인증으로 막지 말 것(lib/routes.ts WEBHOOK_PATHS).
 *
 * 프로토콜(페이앱 SUCCESS/FAIL 텍스트 규약과 다름):
 *  - 2xx = 확인(재전송 중단) / 그 외 = 포트원이 최대 5회 재전송(exponential backoff).
 *  - 서명은 Standard Webhooks(raw body 필수 — formData/json 파싱 전에 text() 로 읽는다).
 *  - 페이로드는 참조로만 쓰고, 상태·금액은 **단건 조회 API 재검증**만 신뢰(포트원 권장 패턴).
 * 응답 3분류(기존 설계 사상 유지): 위조/우리 것 아님 → 재시도 무의미(401/200), 일시 오류 → 5xx(재시도 유도),
 * 처리 완료·중복 → 200.
 *
 * v0.76: 상태 전이는 전부 definer RPC 경유(§13 — 직접 금융/금융인접 UPDATE 금지).
 * drain 경로라 Phase-A 게이트(assertWriteAllowed) 미적용 — closed 에서도 기시작 결제는 종결돼야 한다.
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
    .select("order_uuid, user_id, amount, status, paid_at, is_test")
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

  // 상태·금액은 웹훅 페이로드가 아니라 단건 조회 재검증(canonical 스냅샷)만 신뢰.
  const snapRes = await getPortonePaymentSnapshot(paymentId);
  if (!snapRes.ok) {
    if (snapRes.kind === "not_found") {
      // 웹훅은 왔는데 조회 불가 — 비정상. 재시도로 해소될 수 있어 5xx.
      log.error("pay.wh_payment_not_found", { paymentId });
    }
    return NextResponse.json({ error: "payment_lookup_failed" }, { status: 502 });
  }
  const snapshot = snapRes.snapshot;

  try {
    if (snapshot.status === "PAID") {
      const total = snapshot.totalAmount ?? -1;
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
      const mismatch = channelModeMismatch(snapshot.channelType, order.is_test === true);
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
      // paid_at 은 명시 전달 필수(§12.4 — now() fallback 폐기). 부재 시 RPC 가 paid_at_required 로
      // 거부하므로 grant 시도 자체를 실패 로깅으로 종결(기존 '미지급' 응답 경로).
      const paidAt = typeof snapshot.raw.paidAt === "string" ? snapshot.raw.paidAt : null;
      if (!paidAt) {
        log.error("pay.paid_at_missing", { orderUuid: order.order_uuid, paymentId });
        return NextResponse.json({ ok: true });
      }
      const { data: granted, error } = await Sentry.startSpan(
        { name: "pay.grant", attributes: { orderUuid: order.order_uuid } },
        () =>
          admin.rpc("mark_paid_and_grant", {
            p_order_uuid: order.order_uuid,
            p_pg_tx_id:
              typeof snapshot.raw.transactionId === "string" ? snapshot.raw.transactionId : null,
            p_price: total,
            p_raw: snapshot.raw,
            p_paid_at: paidAt,
            p_receipt_url:
              typeof snapshot.raw.receiptUrl === "string" ? snapshot.raw.receiptUrl : null,
          })
      );
      if (error) {
        log.error("pay.wh_grant_fail", { orderUuid: order.order_uuid, ...errInfo(error) });
        return NextResponse.json({ error: "grant_failed" }, { status: 500 }); // 일시 오류 → 재시도
      }
      if (granted === false) {
        // PAID 재검증까지 됐는데 지급 안 됨 — 이미 지급(중복)·금액 불일치 등 멱등 skip.
        // late_paid(취소 후 늦은 PAID)·cancel intent·탈퇴자 케이스는 RPC 가 quarantine 로트 +
        // late_paid issue 로 흡수하고 true 를 반환하므로 여기 도달하지 않는다(§40).
        // '수금됐는데 미지급' 가능성이 섞여 있어 경고로 가시화(Sentry).
        log.warn("pay.wh_paid_not_granted", {
          orderUuid: order.order_uuid,
          userId: order.user_id,
          orderStatus: order.status,
        });
      } else {
        // true 반환이어도 무지급 흡수 분기(탈퇴자·late_paid·cancel intent)일 수 있음 — error_message 로 구분.
        const { data: chk } = await admin
          .from("orders")
          .select("error_message")
          .eq("order_uuid", order.order_uuid)
          .maybeSingle();
        const em = (chk as { error_message?: string | null } | null)?.error_message;
        if (em === "account_deleted_no_grant") {
          log.warn("pay.wh_deleted_no_grant", {
            orderUuid: order.order_uuid,
            userId: order.user_id,
          });
        } else if (em === "late_paid_no_grant" || em === "cancel_intent_no_grant") {
          // RPC 가 late_paid issue 로 흡수 — 실취소·환불은 issue/intent resolve 소관, 여기선 가시화만.
          log.warn("pay.wh_late_paid_no_grant", {
            orderUuid: order.order_uuid,
            userId: order.user_id,
            errorMessage: em,
          });
        } else {
          log.info("pay.wh_paid", { orderUuid: order.order_uuid, userId: order.user_id });
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (snapshot.status === "CANCELLED" || snapshot.status === "PARTIAL_CANCELLED") {
      // 직접 종단(status/canceled_at UPDATE) 금지(§13) — 외부취소 이벤트 영속 + 대사 RPC 가 전이를 소유:
      // 무결제 전액취소 = canceled 종단, paid 전액취소 = system auto-full 시도(부적격은 issue 큐),
      // 부분취소 = 이벤트 영속만(1급 관측 — 경제 해소는 resolver/운영자).
      const res = await handleObservedCancellation(
        admin,
        { order_uuid: order.order_uuid, paid_at: order.paid_at },
        snapshot
      );
      if (res.outcome === "error") {
        // 일시 오류/레이스(지급 finalizer 선행 필요 등) — 5xx 로 재시도 유도.
        return NextResponse.json({ error: res.error }, { status: 500 });
      }
      if (snapshot.status === "PARTIAL_CANCELLED") {
        log.info("pay.wh_partial_cancelled", {
          orderUuid: order.order_uuid,
          outcome: res.outcome,
        });
      } else {
        log.info("pay.wh_canceled", {
          orderUuid: order.order_uuid,
          pgStatus: snapshot.status,
          outcome: res.outcome,
        });
      }
      return NextResponse.json({ ok: true });
    }

    if (snapshot.status === "FAILED") {
      // 결제 시도 실패 — pending 한정 전이는 RPC 소관(paid/canceled 종단 경합은 skipped 로 보존·멱등).
      const { error: failErr } = await admin.rpc("mark_order_failed", {
        p_order_uuid: order.order_uuid,
        p_pg_status: snapshot.status,
        p_error_message: "pg_failed",
        p_raw: snapshot.raw,
      });
      if (failErr) {
        log.error("pay.wh_fail_update_fail", { orderUuid: order.order_uuid, ...errInfo(failErr) });
        return NextResponse.json({ error: "fail_update_failed" }, { status: 500 });
      }
      log.info("pay.wh_failed", { orderUuid: order.order_uuid });
      return NextResponse.json({ ok: true });
    }

    // READY/PENDING/VIRTUAL_ACCOUNT_ISSUED 등 비종단 — 지급 없이 기록만(operational 컬럼 column-grant).
    const { error: recErr } = await admin
      .from("orders")
      .update({ pg_status: snapshot.status, raw: { webhook: event, verified_status: snapshot.status } })
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
