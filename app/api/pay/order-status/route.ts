import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { portoneConfigured, getPortonePaymentSnapshot } from "@/lib/portone";
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
 * 주문 상태 조회 — /credits/done 폴링용. 본인 주문만(order.user_id === user.id).
 * 크레딧 숫자만 보지 않고 주문 status 로 판단(여러 결제·기존 크레딧과 무관하게 정확).
 *
 * pending·failed 면 포트원 단건 조회로 **능동 재검증**(웹훅 지연/유실 자가치유 — 포트원 권장의
 * '리다이렉트 복귀 시 재조회'를 이 폴링이 담당). failed 포함 이유: 포트원 paymentId 는 성공 전까지
 * 재시도 가능이라 실패 마킹 후 같은 paymentId 로 결제가 성공할 수 있음(failed=준종단, 0058).
 * PAID 확인 시 지급 RPC 는 웹훅과 동일 멱등(mark_paid_and_grant, FOR UPDATE + 상태 가드)이라
 * 웹훅과 경합해도 1회만 지급. 상태 전이는 전부 definer RPC 경유(§13 — 직접 UPDATE 금지, drain 경로).
 */
export async function GET(req: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const orderUuid = req.nextUrl.searchParams.get("order");
  if (!orderUuid) {
    return NextResponse.json({ error: "missing_order" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("order_uuid, user_id, status, credits, amount, product_id, provider, payment_id, paid_at, is_test")
    .eq("order_uuid", orderUuid)
    .maybeSingle();

  if (!order || order.user_id !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let status = order.status as string;

  if (
    (status === "pending" || status === "failed") &&
    order.provider === "portone" &&
    order.payment_id &&
    portoneConfigured()
  ) {
    const snapRes = await getPortonePaymentSnapshot(order.payment_id);
    if (snapRes.ok) {
      const snapshot = snapRes.snapshot;
      // 채널 모드 대사(백스톱) — 웹훅과 동일 규칙(테스트 채널 → 실주문 지급 차단).
      const mismatch =
        snapshot.status === "PAID"
          ? channelModeMismatch(snapshot.channelType, order.is_test === true)
          : null;
      if (mismatch === "block") {
        log.error("pay.poll_test_channel_on_live_order", { orderUuid, paymentId: order.payment_id });
        await admin
          .from("orders")
          .update({ error_message: "test_channel_on_live_order" })
          .eq("order_uuid", order.order_uuid);
      } else if (snapshot.status === "PAID" && snapshot.totalAmount === order.amount) {
        if (mismatch === "warn") {
          log.warn("pay.poll_live_channel_on_test_order", { orderUuid });
        }
        // paid_at 명시 전달 필수(§12.4) — 부재면 grant 시도 자체를 실패 로깅(다음 폴링/웹훅이 재시도).
        const paidAt = typeof snapshot.raw.paidAt === "string" ? snapshot.raw.paidAt : null;
        if (!paidAt) {
          log.error("pay.paid_at_missing", { orderUuid, paymentId: order.payment_id });
        } else {
          const { data: granted, error } = await admin.rpc("mark_paid_and_grant", {
            p_order_uuid: order.order_uuid,
            p_pg_tx_id:
              typeof snapshot.raw.transactionId === "string" ? snapshot.raw.transactionId : null,
            p_price: snapshot.totalAmount,
            p_raw: snapshot.raw,
            p_paid_at: paidAt,
            p_receipt_url:
              typeof snapshot.raw.receiptUrl === "string" ? snapshot.raw.receiptUrl : null,
          });
          if (error) {
            log.error("pay.poll_grant_fail", { orderUuid, ...errInfo(error) });
          } else if (granted !== false) {
            status = "paid";
            log.info("pay.poll_paid", { orderUuid, userId: user.id });
          }
        }
      } else if (snapshot.status === "CANCELLED" || snapshot.status === "PARTIAL_CANCELLED") {
        // 직접 종단 금지(§13) — 이벤트 영속 + 대사 RPC(웹훅과 동일). 부분취소는 영속만(비종단 —
        // 경제 해소는 resolver/운영자 소관), 전이가 일어난 경우만 응답 status 에 반영.
        const res = await handleObservedCancellation(
          admin,
          { order_uuid: order.order_uuid, paid_at: order.paid_at },
          snapshot
        );
        if (res.outcome === "canceled_unpaid") status = "canceled";
        // resolved_full/ineligible/observed/error — 로컬 전이는 RPC/운영자 소관, 폴링은 다음 주기 수렴.
      } else if (snapshot.status === "FAILED") {
        const { data: fRes, error: fErr } = await admin.rpc("mark_order_failed", {
          p_order_uuid: order.order_uuid,
          p_pg_status: snapshot.status,
          p_error_message: "pg_failed",
          p_raw: snapshot.raw,
        });
        if (fErr) {
          log.error("pay.poll_fail_update_fail", { orderUuid, ...errInfo(fErr) });
        } else if ((fRes as { outcome?: string } | null)?.outcome !== "skipped") {
          // failed(전이)·no_op(이미 failed) 만 반영 — skipped(paid/canceled 경합)는 현 상태 유지.
          status = "failed";
        }
      }
      // READY/PENDING 등은 그대로 pending — 클라 폴링 지속.
    }
    // 조회 실패(unreachable 등)는 pending 유지 — 다음 폴링/웹훅이 처리.
  }

  return NextResponse.json({
    status,
    credits: order.credits,
    amount: order.amount,
    productId: order.product_id,
  });
}
