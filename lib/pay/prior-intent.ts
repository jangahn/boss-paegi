import "server-only";
import { getPortonePaymentSnapshot } from "@/lib/portone";
import { log } from "@/lib/log";

export type PriorIntentRef = Readonly<{
  order_uuid: string;
  payment_id: string | null;
}>;

export type PriorIntentResolutionInput = Readonly<{
  order_uuid: string;
  pg_status: string;
  raw: Record<string, unknown> | null;
}>;

export type PriorIntentMeasurement =
  | { kind: "measured"; resolutions: PriorIntentResolutionInput[] }
  | { kind: "prior_paid"; orderUuid: string }
  | { kind: "unmeasurable" };

/**
 * checkout RPC 가 `needs_provider_resolution` 로 알려온 미해결 intent 들의
 * 포트원 실상태를 **측정만** 한다 — 종단은 RPC 재호출(p_prior_resolutions)이
 * 같은 트랜잭션에서 수행한다(0105 계약).
 *
 *  - payment_id 없음(결제창을 연 적 없음) → 확인 불요 종단 대상(NO_PAYMENT_ID)
 *  - 포트원 PAID → 종단 금지: 지급 대상(웹훅/reconcile 소유) — prior_paid
 *  - 포트원 미존재 → NOT_FOUND / 그 외 비-PAID → 관측 status 그대로
 *  - 포트원 불달 → 비-PAID 실측 없는 장님 종단은 하지 않는다(unmeasurable)
 */
export async function measureUnsettledIntents(
  intents: readonly PriorIntentRef[],
  userId: string,
  signal: AbortSignal,
): Promise<PriorIntentMeasurement> {
  const resolutions: PriorIntentResolutionInput[] = [];
  for (const intent of intents) {
    if (!intent.payment_id) {
      resolutions.push({
        order_uuid: intent.order_uuid,
        pg_status: "NO_PAYMENT_ID",
        raw: null,
      });
      continue;
    }
    const snapRes = await getPortonePaymentSnapshot(
      intent.payment_id,
      undefined,
      signal,
    );
    if (snapRes.ok) {
      if (snapRes.snapshot.status === "PAID") {
        return { kind: "prior_paid", orderUuid: intent.order_uuid };
      }
      resolutions.push({
        order_uuid: intent.order_uuid,
        pg_status: snapRes.snapshot.status,
        raw: snapRes.snapshot.raw,
      });
    } else if (snapRes.kind === "not_found") {
      resolutions.push({
        order_uuid: intent.order_uuid,
        pg_status: "NOT_FOUND",
        raw: null,
      });
    } else {
      log.warn("pay.prior_intent_snapshot_unavailable", {
        userId,
        orderUuid: intent.order_uuid,
        reason: snapRes.kind,
      });
      return { kind: "unmeasurable" };
    }
  }
  return { kind: "measured", resolutions };
}

/** RPC 의 needs receipt 에서 intents 배열을 안전 파싱한다(형식 어긋나면 null). */
export function parseNeedsProviderResolution(
  value: unknown,
): PriorIntentRef[] | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { outcome?: unknown }).outcome !== "needs_provider_resolution"
  ) {
    return null;
  }
  const intents = (value as { intents?: unknown }).intents;
  if (!Array.isArray(intents) || intents.length < 1 || intents.length > 11) {
    return null;
  }
  const parsed: PriorIntentRef[] = [];
  for (const item of intents) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const orderUuid = (item as { order_uuid?: unknown }).order_uuid;
    const paymentId = (item as { payment_id?: unknown }).payment_id;
    if (typeof orderUuid !== "string") return null;
    if (paymentId !== null && typeof paymentId !== "string") return null;
    parsed.push({ order_uuid: orderUuid, payment_id: paymentId ?? null });
  }
  return parsed;
}
