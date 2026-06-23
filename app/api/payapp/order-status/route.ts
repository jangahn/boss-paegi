import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * 주문 상태 조회 — /credits/done 폴링용. 본인 주문만(order.user_id === user.id).
 * 크레딧 숫자만 보지 않고 주문 status 로 판단(여러 결제·기존 크레딧과 무관하게 정확).
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
    .from("payapp_orders")
    .select("user_id, status, credits, amount, product_id")
    .eq("order_uuid", orderUuid)
    .maybeSingle();

  if (!order || order.user_id !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    status: order.status,
    credits: order.credits,
    amount: order.amount,
    productId: order.product_id,
  });
}
