import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPortonePaymentSnapshot } from "@/lib/portone";
import { parseMarkOrderCanceledUnpaidResult } from "@/lib/pay/order-mutation-result";
import { log, errInfo } from "@/lib/log";

// 미해결 intent 가 비정상적으로 누적된 계정의 폭주 방지 상한. 정상 경로에서는
// create_or_reuse 의 1-intent 원칙 때문에 1건을 넘지 않는다.
const MAX_RESOLVABLE_INTENTS = 10;

export type PriorIntentResolution =
  | { kind: "resolved"; canceled: number }
  | { kind: "prior_paid"; orderUuid: string }
  | { kind: "unresolved" };

/**
 * 결제창을 닫고 다른 상품/수단으로 갈아탄 사용자의 미해결 checkout intent 를
 * 그 자리에서 안전하게 종단한다 — "취소 → 다른 상품 즉시 전환" 허용의 서버 절차.
 *
 * 안전 근거: 종단 전 건별 포트원 단건 조회로 비-PAID 를 실측하고, 만에 하나
 * 종단 직후 늦은 PAID 가 도착해도 grant RPC 는 미지급 canceled 주문에 지급을
 * 허용한다(0087 impl — canceled 는 지급 차단 상태가 아니라 미결 정리 상태).
 * PAID 로 실측되면 종단하지 않고 prior_paid 로 반환해 웹훅/reconcile 의 지급
 * 경로를 보전한다.
 */
export async function resolveUnsettledCheckoutIntents(
  admin: SupabaseClient,
  userId: string,
  signal: AbortSignal,
): Promise<PriorIntentResolution> {
  const lookup = await admin
    .from("orders")
    .select("order_uuid, payment_id, expected_store_id")
    .eq("user_id", userId)
    .in("status", ["pending", "failed"])
    .is("paid_at", null)
    .is("canceled_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_RESOLVABLE_INTENTS + 1)
    .abortSignal(signal);
  if (lookup.error || !Array.isArray(lookup.data)) {
    log.error("pay.prior_intent_lookup_fail", {
      userId,
      ...errInfo(lookup.error),
    });
    return { kind: "unresolved" };
  }
  if (lookup.data.length > MAX_RESOLVABLE_INTENTS) {
    log.error("pay.prior_intent_overflow", {
      userId,
      count: lookup.data.length,
    });
    return { kind: "unresolved" };
  }

  let canceled = 0;
  for (const row of lookup.data) {
    const orderUuid = typeof row.order_uuid === "string" ? row.order_uuid : null;
    if (!orderUuid) return { kind: "unresolved" };
    const paymentId =
      typeof row.payment_id === "string" && row.payment_id.length > 0
        ? row.payment_id
        : null;
    let pgStatus = "NO_PAYMENT_ID";
    let raw: Record<string, unknown> | null = null;
    if (paymentId) {
      const snapRes = await getPortonePaymentSnapshot(
        paymentId,
        typeof row.expected_store_id === "string"
          ? row.expected_store_id
          : undefined,
        signal,
      );
      if (snapRes.ok) {
        if (snapRes.snapshot.status === "PAID") {
          // 실결제가 완료된 미지급 주문 — 종단 대상이 아니라 지급 대상.
          return { kind: "prior_paid", orderUuid };
        }
        pgStatus = snapRes.snapshot.status;
        raw = snapRes.snapshot.raw;
      } else if (snapRes.kind === "not_found") {
        pgStatus = "NOT_FOUND";
      } else {
        // 포트원 불달 상태에서의 종단은 비-PAID 실측 없는 장님 취소 — 하지 않는다.
        log.warn("pay.prior_intent_snapshot_unavailable", {
          userId,
          orderUuid,
          reason: snapRes.kind,
        });
        return { kind: "unresolved" };
      }
    }
    const transition = await admin
      .rpc("mark_order_canceled_unpaid", {
        p_order_uuid: orderUuid,
        p_pg_status: pgStatus,
        p_pg_tx_id: null,
        p_raw: {
          reason: "checkout_prior_intent_auto_resolve",
          observed: raw,
        },
      })
      .abortSignal(signal);
    const ack = transition.error
      ? null
      : parseMarkOrderCanceledUnpaidResult(transition.data);
    if (!ack) {
      log.error("pay.prior_intent_cancel_fail", {
        userId,
        orderUuid,
        ...errInfo(transition.error),
      });
      return { kind: "unresolved" };
    }
    if (ack.outcome === "skipped" && ack.status === "paid") {
      // 조회~종단 사이 지급 경합 — 지급 경로 보전.
      return { kind: "prior_paid", orderUuid };
    }
    canceled += 1;
  }
  return { kind: "resolved", canceled };
}
