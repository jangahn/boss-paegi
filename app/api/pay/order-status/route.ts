import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { portoneConfigured, getPortonePayment } from "@/lib/portone";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 주문 상태 조회 — /credits/done 폴링용. 본인 주문만(order.user_id === user.id).
 * 크레딧 숫자만 보지 않고 주문 status 로 판단(여러 결제·기존 크레딧과 무관하게 정확).
 *
 * pending·failed 면 포트원 단건 조회로 **능동 재검증**(웹훅 지연/유실 자가치유 — 포트원 권장의
 * '리다이렉트 복귀 시 재조회'를 이 폴링이 담당). failed 포함 이유: 포트원 paymentId 는 성공 전까지
 * 재시도 가능이라 실패 마킹 후 같은 paymentId 로 결제가 성공할 수 있음(failed=준종단, 0058).
 * PAID 확인 시 지급 RPC 는 웹훅과 동일 멱등(mark_paid_and_grant, FOR UPDATE + 상태 가드)이라
 * 웹훅과 경합해도 1회만 지급.
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
    .select("order_uuid, user_id, status, credits, amount, product_id, provider, payment_id, canceled_at, pg_tx_id")
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
    const got = await getPortonePayment(order.payment_id);
    if (got.ok) {
      const payment = got.payment;
      if (payment.status === "PAID" && (payment.amount?.total ?? -1) === order.amount) {
        const { data: granted, error } = await admin.rpc("mark_paid_and_grant", {
          p_order_uuid: order.order_uuid,
          p_pg_tx_id: payment.transactionId || null,
          p_price: payment.amount!.total,
          p_raw: { source: "order-status-poll", verified_status: payment.status },
        });
        if (error) {
          log.error("pay.poll_grant_fail", { orderUuid, ...errInfo(error) });
        } else if (granted !== false) {
          status = "paid";
          log.info("pay.poll_paid", { orderUuid, userId: user.id });
        }
      } else if (payment.status === "CANCELLED") {
        // PARTIAL_CANCELLED 는 여기서 종단하지 않음(웹훅과 동일 — 자동 화해 시 전량 회수 위험).
        const { error: cErr } = await admin
          .from("orders")
          .update({
            status: "canceled",
            pg_status: payment.status,
            canceled_at: order.canceled_at ?? new Date().toISOString(),
            pg_tx_id: order.pg_tx_id ?? payment.transactionId ?? null,
          })
          .eq("order_uuid", order.order_uuid);
        if (!cErr) status = "canceled";
      } else if (payment.status === "FAILED") {
        const { error: fErr } = await admin
          .from("orders")
          .update({ status: "failed", pg_status: payment.status, error_message: "pg_failed" })
          .eq("order_uuid", order.order_uuid)
          .eq("status", "pending");
        if (!fErr) status = "failed";
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
