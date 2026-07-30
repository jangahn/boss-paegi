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
import {
  parseMarkOrderFailedResult,
  parseMarkPaidAndGrantResult,
  parsePaidOrderPostcondition,
} from "@/lib/pay/order-mutation-result";
import {
  readPortoneWebhookBody,
} from "@/lib/pay/webhook-request-boundary";
import {
  classifyPortoneEvidenceForRollout,
  classifyPortoneNonMoneyEvidence,
} from "@/lib/pay/payment-evidence";
import {
  recordOrderEvidenceMarkerIfUnsettled,
  recordOrderProviderStateIfUnsettled,
} from "@/lib/pay/order-observation-write";

export const runtime = "nodejs";

/**
 * 포트원 결제 웹훅. public — 세션 없음(requireMember 금지), proxy/인증으로 막지 말 것(lib/routes.ts WEBHOOK_PATHS).
 *
 * 프로토콜(페이앱 SUCCESS/FAIL 텍스트 규약과 다름):
 *  - 2xx = 확인(재전송 중단) / 그 외 = 포트원이 최대 5회 재전송(exponential backoff).
 *  - 서명은 Standard Webhooks(raw body 필수 — 제한된 스트림에서 strict UTF-8 원문을 보존한다).
 *  - 페이로드는 참조로만 쓰고, 상태·금액은 **단건 조회 API 재검증**만 신뢰(포트원 권장 패턴).
 * 응답 3분류(기존 설계 사상 유지): 위조/우리 것 아님 → 재시도 무의미(401/200), 일시 오류 → 5xx(재시도 유도),
 * 처리 완료·중복 → 200.
 *
 * v0.76: 상태 전이는 전부 definer RPC 경유(§13 — 직접 금융/금융인접 UPDATE 금지).
 */
export async function POST(req: NextRequest) {
  if (!portoneWebhookConfigured()) {
    return NextResponse.json({ error: "webhook_unavailable" }, { status: 503 });
  }

  const webhookBody = await readPortoneWebhookBody(req);
  if (!webhookBody.ok) {
    return NextResponse.json(
      { error: webhookBody.error },
      { status: webhookBody.error === "body_too_large" ? 413 : 400 },
    );
  }
  const rawBody = webhookBody.rawBody;
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
    .select(
      "order_uuid, user_id, amount, status, paid_at, error_message, provider, payment_id, is_test, expected_store_id, expected_currency, expected_channel_key",
    )
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
  if (order.provider !== "portone") {
    // payment_id is a provider-local identifier. A signed PortOne event must
    // never transition a legacy PayApp order that happens to share the text.
    log.warn("pay.wh_provider_mismatch", {
      paymentId,
      orderUuid: order.order_uuid,
      provider: order.provider,
    });
    return NextResponse.json({ ok: true, ignored: true });
  }

  // 상태·금액은 웹훅 페이로드가 아니라 단건 조회 재검증(canonical 스냅샷)만 신뢰.
  const snapRes = await getPortonePaymentSnapshot(
    paymentId,
    order.expected_store_id ?? undefined,
  );
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
      const evidence = classifyPortoneEvidenceForRollout(snapshot, order);
      if (evidence.kind === "mismatch") {
        log.error("pay.wh_evidence_mismatch", {
          orderUuid: order.order_uuid,
          paymentId,
          reason: evidence.reason,
        });
        const markerResult = await recordOrderEvidenceMarkerIfUnsettled(admin, {
          orderUuid: order.order_uuid,
          expectedStatus: order.status,
          expectedErrorMessage: order.error_message,
          marker: `payment_evidence_${evidence.reason}`,
        });
        if (!markerResult.ok) {
          log.error("pay.wh_evidence_mismatch_record_fail", {
            orderUuid: order.order_uuid,
            ...errInfo(markerResult.error),
          });
          // Standard Webhook 5xx 재전송으로 감사 마커 기록을 다시 시도한다.
          return NextResponse.json({ error: "state_record_failed" }, { status: 500 });
        }
        if (markerResult.outcome === "terminal") {
          log.info("pay.wh_evidence_mismatch_terminal_race", {
            orderUuid: order.order_uuid,
            status: markerResult.status,
          });
          return NextResponse.json({ ok: true, ignored: true });
        }
        return NextResponse.json({
          ok: false,
          error: "payment_evidence_mismatch",
          reason: evidence.reason,
        });
      }
      if (evidence.kind === "legacy_deferred") {
        log.warn("pay.wh_legacy_evidence_deferred", {
          orderUuid: order.order_uuid,
          paymentId,
        });
        // The all-NULL tuple identifies an unbackfilled legacy order; it does
        // not authorize a grant. Returning 5xx keeps the provider retry alive
        // until the immutable checkout evidence has been frozen.
        return NextResponse.json(
          { error: "payment_evidence_incomplete" },
          { status: 503 },
        );
      }
      // paid_at 은 명시 전달 필수(§12.4 — now() fallback 폐기). 부재 시 RPC 가 paid_at_required 로
      // 거부하므로 grant 시도 자체를 실패 로깅으로 종결(기존 '미지급' 응답 경로).
      const paidAt = typeof snapshot.raw.paidAt === "string" ? snapshot.raw.paidAt : null;
      if (!paidAt) {
        log.error("pay.paid_at_missing", { orderUuid: order.order_uuid, paymentId });
        // PAID를 확인했는데 회계 기준시각이 아직 보이지 않는 것은 처리 완료가 아니다.
        // 2xx로 ACK하면 공급자의 재전송이 끝나 사용자가 폴링하지 않는 경우 영구 미지급이
        // 될 수 있다. 스냅샷이 수렴할 때까지 webhook retry를 유지한다.
        return NextResponse.json(
          { error: "payment_evidence_incomplete" },
          { status: 503 },
        );
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
      const grantAck = parseMarkPaidAndGrantResult(granted);
      if (grantAck === null) {
        log.error("pay.wh_grant_invalid_result", {
          orderUuid: order.order_uuid,
          resultType: typeof granted,
        });
        return NextResponse.json({ error: "grant_failed" }, { status: 500 });
      }
      // true/false 모두 durable PAID postcondition을 재조회한다. false는 동시/중복
      // 성공일 수 있지만, 다른 guard 실패를 멱등 성공으로 오인해서는 안 된다.
      const { data: current, error: currentError } = await admin
        .from("orders")
        .select("status, paid_at, error_message")
        .eq("order_uuid", order.order_uuid)
        .maybeSingle();
      const paidState = parsePaidOrderPostcondition(current);
      if (currentError || !paidState) {
        log.error("pay.wh_paid_transition_incomplete", {
          orderUuid: order.order_uuid,
          userId: order.user_id,
          currentStatus:
            current && typeof current === "object" && "status" in current
              ? current.status
              : null,
          hasPaidAt:
            current &&
            typeof current === "object" &&
            "paid_at" in current &&
            typeof current.paid_at === "string",
          ...errInfo(currentError),
        });
        return NextResponse.json(
          { error: "paid_transition_incomplete" },
          { status: 500 },
        );
      }
      if (grantAck === false) {
        log.info("pay.wh_paid_idempotent", {
          orderUuid: order.order_uuid,
          userId: order.user_id,
        });
      } else {
        // true 반환이어도 무지급 흡수 분기(탈퇴자·late_paid·cancel intent)일 수 있음 — error_message 로 구분.
        const em = paidState.errorMessage;
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
      const evidence = classifyPortoneNonMoneyEvidence(snapshot, order);
      if (evidence.kind !== "exact") {
        log.error("pay.wh_nonmoney_evidence_rejected", {
          orderUuid: order.order_uuid,
          paymentId,
          reason:
            evidence.kind === "mismatch" ? evidence.reason : evidence.kind,
        });
        if (evidence.kind === "mismatch") {
          const markerResult = await recordOrderEvidenceMarkerIfUnsettled(admin, {
            orderUuid: order.order_uuid,
            expectedStatus: order.status,
            expectedErrorMessage: order.error_message,
            marker: `payment_evidence_${evidence.reason}`,
          });
          if (!markerResult.ok) {
            return NextResponse.json(
              { error: "state_record_failed" },
              { status: 500 },
            );
          }
          if (markerResult.outcome === "terminal") {
            return NextResponse.json({ ok: true, ignored: true });
          }
          return NextResponse.json({
            ok: false,
            error: "payment_evidence_mismatch",
            reason: evidence.reason,
          });
        }
        return NextResponse.json(
          { error: "payment_evidence_incomplete" },
          { status: 503 },
        );
      }
      // 결제 시도 실패 — pending 한정 전이는 RPC 소관(paid/canceled 종단 경합은 skipped 로 보존·멱등).
      const { data: failData, error: failErr } = await admin.rpc("mark_order_failed", {
        p_order_uuid: order.order_uuid,
        p_pg_status: snapshot.status,
        p_error_message: "pg_failed",
        p_raw: snapshot.raw,
      });
      if (failErr) {
        log.error("pay.wh_fail_update_fail", { orderUuid: order.order_uuid, ...errInfo(failErr) });
        return NextResponse.json({ error: "fail_update_failed" }, { status: 500 });
      }
      const failedResult = parseMarkOrderFailedResult(failData);
      if (!failedResult) {
        log.error("pay.wh_fail_update_invalid", { orderUuid: order.order_uuid });
        return NextResponse.json({ error: "fail_update_failed" }, { status: 500 });
      }
      if (failedResult.outcome === "skipped") {
        log.info("pay.wh_failed_race_skipped", {
          orderUuid: order.order_uuid,
          status: failedResult.status,
        });
      } else {
        log.info("pay.wh_failed", { orderUuid: order.order_uuid });
      }
      return NextResponse.json({ ok: true });
    }

    // READY/PENDING/VIRTUAL_ACCOUNT_ISSUED 등 비종단 — provider namespace
    // 증거가 정확할 때만 지급 없이 기록(operational 컬럼 column-grant).
    const nonMoneyEvidence = classifyPortoneNonMoneyEvidence(snapshot, order);
    if (nonMoneyEvidence.kind !== "exact") {
      log.warn("pay.wh_nonterminal_evidence_rejected", {
        orderUuid: order.order_uuid,
        paymentId,
        reason:
          nonMoneyEvidence.kind === "mismatch"
            ? nonMoneyEvidence.reason
            : nonMoneyEvidence.kind,
      });
      if (nonMoneyEvidence.kind === "mismatch") {
        const markerResult = await recordOrderEvidenceMarkerIfUnsettled(admin, {
          orderUuid: order.order_uuid,
          expectedStatus: order.status,
          expectedErrorMessage: order.error_message,
          marker: `payment_evidence_${nonMoneyEvidence.reason}`,
        });
        if (!markerResult.ok) {
          return NextResponse.json(
            { error: "state_record_failed" },
            { status: 500 },
          );
        }
        if (markerResult.outcome === "terminal") {
          return NextResponse.json({ ok: true, ignored: true });
        }
      }
      // Non-terminal provider state does not need webhook retries; a later
      // terminal event or the reconciler will re-read it after backfill.
      return NextResponse.json({ ok: true, ignored: true });
    }
    const recordResult = await recordOrderProviderStateIfUnsettled(admin, {
      orderUuid: order.order_uuid,
      expectedStatus: order.status,
      expectedErrorMessage: order.error_message,
      pgStatus: snapshot.status,
      raw: { webhook: event, verified_status: snapshot.status },
    });
    if (!recordResult.ok) {
      log.error("pay.wh_record_update_fail", {
        orderUuid: order.order_uuid,
        ...errInfo(recordResult.error),
      });
      return NextResponse.json({ error: "record_update_failed" }, { status: 500 });
    }
    if (recordResult.outcome === "terminal") {
      log.info("pay.wh_nonterminal_terminal_race", {
        orderUuid: order.order_uuid,
        status: recordResult.status,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error("pay.wh_exception", { orderUuid: order.order_uuid, ...errInfo(e) });
    return NextResponse.json({ error: "exception" }, { status: 500 });
  }
}
