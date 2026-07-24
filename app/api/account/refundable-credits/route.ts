import "server-only";
import { NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 내 환불 가능 수량 조회(§11.6) — 반환 exact `{ ok, refundable, asOf }`.
 * refundable = Σ purchase 로트 잔여(qty − consumed − refunded − refund_reserved) 중 주문
 * refund_deadline(paid_at+5y) 이내인 전부 — natural/quarantine 만료와 무관(expired 로트 포함),
 * 예약분(refund_reserved)만 제외.
 * **수량만 반환 — 현금 지급을 보장하지 않는다**(산정·차감 순서는 이용약관 제10조 단일 소스).
 * 표시 전용(재시도 무해) — 실제 환불 판정 최종 권위는 begin locked planner(admin_refund_begin).
 */

type PurchaseLotRow = {
  order_uuid: string | null;
  qty: number;
  consumed: number;
  refunded: number;
  refund_reserved: number;
};

/**
 * 환불 기한(ms) — 0062 정본 `paid_at + interval '5 years'`(admin_refund_begin) 의 표시용 재현.
 * UTC 달력 연 가산(setUTCFullYear +5) — PG 의 UTC 세션 interval '5 years' 와 동일 규칙
 * (윤일 2/29 경계만 미세 차이 — 표시 전용이라 무해, 최종 판정은 RPC).
 */
function refundDeadlineMs(paidAt: string): number {
  const d = new Date(paidAt);
  d.setUTCFullYear(d.getUTCFullYear() + 5);
  return d.getTime();
}

export async function GET() {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const userId = gate.user.id;
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("credit_lots")
    .select("order_uuid, qty, consumed, refunded, refund_reserved")
    .eq("user_id", userId)
    .eq("source", "purchase");
  if (error) {
    log.error("account.refundable_query_fail", { userId, ...errInfo(error) });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const lots = (data ?? []) as PurchaseLotRow[];

  const paidAtByOrder = new Map<string, string>();
  const orderUuids = [...new Set(lots.map((l) => l.order_uuid).filter((u): u is string => !!u))];
  if (orderUuids.length > 0) {
    const { data: orders, error: ordErr } = await admin
      .from("orders")
      .select("order_uuid, paid_at")
      .eq("user_id", userId)
      .in("order_uuid", orderUuids);
    if (ordErr) {
      log.error("account.refundable_orders_query_fail", { userId, ...errInfo(ordErr) });
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
    for (const o of (orders ?? []) as { order_uuid: string; paid_at: string | null }[]) {
      if (o.paid_at) paidAtByOrder.set(o.order_uuid, o.paid_at);
    }
  }

  const asOfDate = new Date();
  const nowMs = asOfDate.getTime();

  let refundable = 0;
  for (const l of lots) {
    if (!l.order_uuid) continue;
    const paidAt = paidAtByOrder.get(l.order_uuid);
    if (!paidAt || nowMs > refundDeadlineMs(paidAt)) continue;
    refundable += Math.max(0, l.qty - l.consumed - l.refunded - l.refund_reserved);
  }

  return NextResponse.json({ ok: true, refundable, asOf: asOfDate.toISOString() });
}
