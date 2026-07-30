import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { portoneConfigured, getPortonePaymentSnapshot } from "@/lib/portone";
import { handleObservedCancellation } from "@/lib/refund-saga";
import { log, errInfo } from "@/lib/log";
import {
  parseMarkOrderFailedResult,
  parseMarkPaidAndGrantResult,
  parsePaidOrderPostcondition,
  paidOrderHttpStatus,
  type PaidOrderPostcondition,
} from "@/lib/pay/order-mutation-result";
import { parseOrderStatusHttpResponse } from "@/lib/pay/http-contract";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  classifyPortoneEvidenceForRollout,
  classifyPortoneNonMoneyEvidence,
} from "@/lib/pay/payment-evidence";
import { recordOrderEvidenceMarkerIfUnsettled } from "@/lib/pay/order-observation-write";

export const runtime = "nodejs";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = new Set(["pending", "paid", "canceled", "failed"]);

/**
 * 주문 상태 조회 — /credits/done 폴링용. 본인 주문만(order.user_id === user.id).
 * 크레딧 숫자만 보지 않고 주문 status 로 판단(여러 결제·기존 크레딧과 무관하게 정확).
 *
 * pending·failed 면 포트원 단건 조회로 **능동 재검증**(웹훅 지연/유실 자가치유 — 포트원 권장의
 * '리다이렉트 복귀 시 재조회'를 이 폴링이 담당). failed 포함 이유: 포트원 paymentId 는 성공 전까지
 * 재시도 가능이라 실패 마킹 후 같은 paymentId 로 결제가 성공할 수 있음(failed=준종단, 0058).
 * PAID + immutable evidence exact 확인 시 지급 RPC 는 웹훅과 동일 멱등(mark_paid_and_grant,
 * FOR UPDATE + 상태 가드)이라 웹훅과 경합해도 1회만 지급. 상태 전이는 전부 definer RPC
 * 경유(§13 — 직접 UPDATE 금지, drain 경로).
 */
export async function GET(req: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const orderUuid = req.nextUrl.searchParams.get("order");
  if (!orderUuid || !UUID_RE.test(orderUuid)) {
    return NextResponse.json({ error: "missing_order" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: orderRaw, error: orderError } = await admin
    .from("orders")
    .select(
      "order_uuid, user_id, status, credits, amount, product_id, provider, payment_id, paid_at, error_message, is_test, expected_store_id, expected_currency, expected_channel_key",
    )
    .eq("order_uuid", orderUuid)
    .maybeSingle();

  if (orderError) {
    log.error("pay.poll_order_lookup_fail", { orderUuid, ...errInfo(orderError) });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  if (!orderRaw) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  let order: {
    order_uuid: string;
    user_id: string;
    status: string;
    credits: number;
    amount: number;
    product_id: string;
    provider: string | null;
    payment_id: string | null;
    paid_at: string | null;
    error_message: string | null;
    is_test: boolean;
    expected_store_id: string | null;
    expected_currency: string | null;
    expected_channel_key: string | null;
  };
  try {
    order = validateAdminRows<typeof order>(
      "pay.poll.order",
      [orderRaw],
      {
        order_uuid: "uuid",
        user_id: "uuid",
        status: "string",
        credits: "nonnegativeInteger",
        amount: "nonnegativeInteger",
        product_id: "string",
        provider: "nullableString",
        payment_id: "nullableString",
        paid_at: "nullableTimestamp",
        error_message: "nullableString",
        is_test: "boolean",
        expected_store_id: "nullableString",
        expected_currency: "nullableString",
        expected_channel_key: "nullableString",
      },
    )[0]!;
  } catch (validationError) {
    log.error("pay.poll_order_invalid", {
      orderUuid,
      ...errInfo(validationError),
    });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  if (order.user_id !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (
    !ORDER_STATUSES.has(order.status) ||
    order.credits <= 0 ||
    order.amount <= 0
  ) {
    log.error("pay.poll_order_invalid", { orderUuid });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }

  let status = order.status;
  let paidState: PaidOrderPostcondition | null =
    status === "paid" ? parsePaidOrderPostcondition(order) : null;

  if (
    (status === "pending" || status === "failed") &&
    order.provider === "portone" &&
    order.payment_id &&
    portoneConfigured()
  ) {
    const snapRes = await getPortonePaymentSnapshot(
      order.payment_id,
      order.expected_store_id ?? undefined,
    );
    if (snapRes.ok) {
      const snapshot = snapRes.snapshot;
      const evidence =
        snapshot.status === "PAID"
          ? classifyPortoneEvidenceForRollout(snapshot, order)
          : null;
      if (evidence?.kind === "mismatch") {
        log.error("pay.poll_evidence_mismatch", {
          orderUuid,
          paymentId: order.payment_id,
          reason: evidence.reason,
        });
        const markerResult = await recordOrderEvidenceMarkerIfUnsettled(admin, {
          orderUuid: order.order_uuid,
          expectedStatus: order.status,
          expectedErrorMessage: order.error_message,
          marker: `payment_evidence_${evidence.reason}`,
        });
        if (!markerResult.ok) {
          log.error("pay.poll_evidence_mismatch_record_fail", {
            orderUuid,
            ...errInfo(markerResult.error),
          });
          return NextResponse.json({ error: "state_record_failed" }, { status: 500 });
        }
        if (markerResult.outcome === "terminal") {
          status = markerResult.status;
          paidState = markerResult.paidState;
          log.info("pay.poll_evidence_mismatch_terminal_race", {
            orderUuid,
            status,
          });
        }
      } else if (snapshot.status === "PAID") {
        if (evidence?.kind === "legacy_deferred") {
          log.warn("pay.poll_legacy_evidence_deferred", {
            orderUuid,
            paymentId: order.payment_id,
          });
          // An all-NULL legacy tuple cannot prove the provider object that is
          // about to move money. Backfill must complete before a later poll
          // may call the grant RPC.
          return NextResponse.json(
            { error: "payment_evidence_incomplete" },
            { status: 503 },
          );
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
            return NextResponse.json(
              { error: "payment_unavailable" },
              { status: 503 },
            );
          }
          const grantAck = parseMarkPaidAndGrantResult(granted);
          if (grantAck === null) {
            log.error("pay.poll_grant_invalid_result", {
              orderUuid,
              resultType: typeof granted,
            });
            return NextResponse.json(
              { error: "payment_unavailable" },
              { status: 503 },
            );
          }
          const { data: current, error: currentError } = await admin
            .from("orders")
            .select("status, paid_at, error_message")
            .eq("order_uuid", order.order_uuid)
            .maybeSingle();
          paidState = parsePaidOrderPostcondition(current);
          if (currentError || !paidState) {
            log.error("pay.poll_paid_transition_incomplete", {
              orderUuid,
              grantAck,
              ...errInfo(currentError),
            });
            return NextResponse.json(
              { error: "payment_unavailable" },
              { status: 503 },
            );
          }
          if (grantAck === false) {
            log.info("pay.poll_paid_idempotent", { orderUuid, userId: user.id });
          } else {
            log.info("pay.poll_paid", { orderUuid, userId: user.id });
          }
          status = paidOrderHttpStatus(paidState);
        }
      } else if (snapshot.status === "CANCELLED" || snapshot.status === "PARTIAL_CANCELLED") {
        // 직접 종단 금지(§13) — 이벤트 영속 + 대사 RPC(웹훅과 동일). 부분취소는 영속만(비종단 —
        // 경제 해소는 resolver/운영자 소관), 전이가 일어난 경우만 응답 status 에 반영.
        const res = await handleObservedCancellation(
          admin,
          {
            order_uuid: order.order_uuid,
            paid_at: order.paid_at,
            payment_id: order.payment_id,
            amount: order.amount,
            is_test: order.is_test,
            expected_store_id: order.expected_store_id,
            expected_currency: order.expected_currency,
            expected_channel_key: order.expected_channel_key,
          },
          snapshot
        );
        if (res.outcome === "error") {
          log.error("pay.poll_cancellation_fail", {
            orderUuid,
            detail: res.error,
          });
          return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
        }
        if (res.outcome === "canceled_unpaid") status = "canceled";
        // resolved_full/ineligible/observed — 로컬 전이는 RPC/운영자 소관, 폴링은 다음 주기 수렴.
      } else if (snapshot.status === "FAILED") {
        const failedEvidence = classifyPortoneNonMoneyEvidence(
          snapshot,
          order,
        );
        if (failedEvidence.kind !== "exact") {
          log.error("pay.poll_nonmoney_evidence_rejected", {
            orderUuid,
            paymentId: order.payment_id,
            reason:
              failedEvidence.kind === "mismatch"
                ? failedEvidence.reason
                : failedEvidence.kind,
          });
          if (failedEvidence.kind === "mismatch") {
            const markerResult = await recordOrderEvidenceMarkerIfUnsettled(admin, {
              orderUuid: order.order_uuid,
              expectedStatus: order.status,
              expectedErrorMessage: order.error_message,
              marker: `payment_evidence_${failedEvidence.reason}`,
            });
            if (!markerResult.ok) {
              return NextResponse.json(
                { error: "payment_unavailable" },
                { status: 503 },
              );
            }
            if (markerResult.outcome === "terminal") {
              status = markerResult.status;
              paidState = markerResult.paidState;
            }
          }
          if (status !== "paid" && status !== "canceled") {
            const response = parseOrderStatusHttpResponse({
              status,
              credits: order.credits,
              amount: order.amount,
              productId: order.product_id,
            });
            return response
              ? NextResponse.json(response)
              : NextResponse.json(
                  { error: "payment_unavailable" },
                  { status: 503 },
                );
          }
        }
        const { data: fRes, error: fErr } = await admin.rpc("mark_order_failed", {
          p_order_uuid: order.order_uuid,
          p_pg_status: snapshot.status,
          p_error_message: "pg_failed",
          p_raw: snapshot.raw,
        });
        if (fErr) {
          log.error("pay.poll_fail_update_fail", { orderUuid, ...errInfo(fErr) });
        } else {
          const failedResult = parseMarkOrderFailedResult(fRes);
          if (!failedResult) {
            log.error("pay.poll_fail_update_invalid", { orderUuid });
            return NextResponse.json(
              { error: "payment_unavailable" },
              { status: 503 },
            );
          }
          if (failedResult.outcome === "skipped") {
            status = failedResult.status;
          } else {
            // failed(전이)·no_op(이미 failed)만 failed로 반영한다.
            status = "failed";
          }
        }
      }
      // READY/PENDING 등은 그대로 pending — 클라 폴링 지속.
    }
    // 조회 실패(unreachable 등)는 pending 유지 — 다음 폴링/웹훅이 처리.
  }

  // A concurrent failed/cancel transition may report a skipped `paid` state.
  // Re-read that terminal row before presenting it, because paid alone does
  // not prove that the live-credit grant happened.
  if (status === "paid") {
    if (!paidState) {
      const { data: current, error: currentError } = await admin
        .from("orders")
        .select("status, paid_at, error_message")
        .eq("order_uuid", order.order_uuid)
        .maybeSingle();
      paidState = parsePaidOrderPostcondition(current);
      if (currentError || !paidState) {
        log.error("pay.poll_paid_postcondition_unavailable", {
          orderUuid,
          ...errInfo(currentError),
        });
        return NextResponse.json(
          { error: "payment_unavailable" },
          { status: 503 },
        );
      }
    }
    status = paidOrderHttpStatus(paidState);
  }

  const response = parseOrderStatusHttpResponse({
    status,
    credits: order.credits,
    amount: order.amount,
    productId: order.product_id,
  });
  if (!response) {
    log.error("pay.poll_invalid_http_contract", { orderUuid });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  return NextResponse.json(response);
}
