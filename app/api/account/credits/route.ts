import "server-only";
import { NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 내 크레딧 3분류 조회(§11.6 마이페이지 endpoint 정본) — credit_lots 직쿼리 집계.
 * - available          = Σ live 로트(expired_at null)의 잔여(qty − consumed − refunded − refund_reserved)
 * - refundProcessing   = Σ 전체 로트의 refund_reserved(open 환불 예약 — "처리 중")
 * - expiredUnrefunded  = Σ expired 로트 중 source='purchase' 이고 주문 refund_deadline(paid_at+5y)
 *                        이내인 잔여 — refund_reserved 는 refundProcessing 에만 집계(이중 집계 금지)
 * 반환 exact `{ ok, available, refundProcessing, expiredUnrefunded, asOf }` — asOf = 서버 시각.
 * 표시 전용(재시도 무해) — 실제 환불 판정 최종 권위는 begin locked planner(admin_refund_begin).
 */

type LotRow = {
  source: string;
  order_uuid: string | null;
  qty: number;
  consumed: number;
  refunded: number;
  refund_reserved: number;
  expired_at: string | null;
};

/** 로트 잔여 — 0062 counter_sum_check 로 음수 불가지만 방어적으로 0 하한. */
function lotRemaining(l: LotRow): number {
  return Math.max(0, l.qty - l.consumed - l.refunded - l.refund_reserved);
}

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
    .select("source, order_uuid, qty, consumed, refunded, refund_reserved, expired_at")
    .eq("user_id", userId);
  if (error) {
    log.error("account.credits_query_fail", { userId, ...errInfo(error) });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const lots = (data ?? []) as LotRow[];

  // expired purchase 로트의 주문 paid_at(→ deadline) 조회 — 본인 주문만.
  const expiredPurchaseOrderUuids = [
    ...new Set(
      lots
        .filter((l) => l.expired_at !== null && l.source === "purchase" && l.order_uuid)
        .map((l) => l.order_uuid as string)
    ),
  ];
  const paidAtByOrder = new Map<string, string>();
  if (expiredPurchaseOrderUuids.length > 0) {
    const { data: orders, error: ordErr } = await admin
      .from("orders")
      .select("order_uuid, paid_at")
      .eq("user_id", userId)
      .in("order_uuid", expiredPurchaseOrderUuids);
    if (ordErr) {
      log.error("account.credits_orders_query_fail", { userId, ...errInfo(ordErr) });
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
    for (const o of (orders ?? []) as { order_uuid: string; paid_at: string | null }[]) {
      if (o.paid_at) paidAtByOrder.set(o.order_uuid, o.paid_at);
    }
  }

  const asOfDate = new Date();
  const nowMs = asOfDate.getTime();

  let available = 0;
  let refundProcessing = 0;
  let expiredUnrefunded = 0;
  for (const l of lots) {
    refundProcessing += l.refund_reserved;
    if (l.expired_at === null) {
      available += lotRemaining(l);
      continue;
    }
    if (l.source !== "purchase" || !l.order_uuid) continue;
    const paidAt = paidAtByOrder.get(l.order_uuid);
    if (!paidAt || nowMs > refundDeadlineMs(paidAt)) continue;
    expiredUnrefunded += lotRemaining(l);
  }

  return NextResponse.json({
    ok: true,
    available,
    refundProcessing,
    expiredUnrefunded,
    asOf: asOfDate.toISOString(),
  });
}
