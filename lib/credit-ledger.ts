import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log, errInfo } from "@/lib/log";

/** 크레딧 변동 사건 종류 — 생성차감 / 생성환불 / 충전(구매). 운영자 조정은 admin_actions_ledger 가 별도 기록. */
export type CreditEventType = "gen_consume" | "gen_refund" | "purchase";

/**
 * credit_ledger 에 변동 1건 기록 — **best-effort**(잔액 변경 RPC 성공 *후* 호출, 실패해도 throw 금지).
 * 0047 미적용 환경이면 insert 가 에러나지만 경고만 남기고 무시(본 작업 무영향). 감사/분석용 기록.
 */
export async function logCreditEvent(
  admin: SupabaseClient,
  e: {
    userId: string;
    delta: number;
    eventType: CreditEventType;
    balanceAfter?: number | null;
    refGenId?: string | null;
    refOrderUuid?: string | null;
    note?: string | null;
  }
): Promise<void> {
  const { error } = await admin.from("credit_ledger").insert({
    user_id: e.userId,
    delta: e.delta,
    event_type: e.eventType,
    balance_after: e.balanceAfter ?? null,
    ref_gen_id: e.refGenId ?? null,
    ref_order_uuid: e.refOrderUuid ?? null,
    note: e.note ?? null,
  });
  if (error) {
    log.warn("credit_ledger.insert_fail", {
      userId: e.userId,
      eventType: e.eventType,
      ...errInfo(error),
    });
  }
}
