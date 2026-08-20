import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
import { getGrowthLeversStrict } from "@/lib/config/getters";
import { activeCreditProducts, payModeFor } from "@/lib/config/domains/growth";
import { getReviewerStatus } from "@/lib/reviewer";
import { paymentChannels, type PayChannelMethod } from "@/lib/pay-channels";
import { portoneConfigured, paymentIdForOrder } from "@/lib/portone";
import { refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import { parseAtomicCheckoutReceipt } from "@/lib/pay/checkout-reuse";
import { parseCheckoutHttpResponse } from "@/lib/pay/http-contract";
import { rateLimit } from "@/lib/rate-limit";
import { log, errInfo } from "@/lib/log";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import {
  CHECKOUT_WITHDRAWAL_CONFIRMATION,
  parseCheckoutRequestBody,
} from "@/lib/pay/withdrawal-evidence";
import { waitForCheckoutDependency } from "@/lib/pay/checkout-dependency-deadline";
import {
  measureUnsettledIntents,
  parseNeedsProviderResolution,
  type PriorIntentResolutionInput,
} from "@/lib/pay/prior-intent";

export const runtime = "nodejs";
export const maxDuration = 25;
const CHECKOUT_DEPENDENCY_TIMEOUT_MS = 20_000;

/**
 * 결제 주문 생성 — 로그인 회원만. price/credits 는 서버 allowlist 로만 결정(클라 조작 차단).
 * pending 주문을 먼저 insert(웹훅이 먼저 와도 payment_id 로 조회되게) 후 결제 파라미터 반환.
 * 결제창 호출은 클라(@portone/browser-sdk/v2 requestPayment)가 수행 — 금액은 응답의 서버 결정값을
 * 그대로 전달해야 하며, 최종 신뢰는 웹훅/폴링의 단건 조회 재검증(금액 대사)이 담당.
 */
export async function POST(req: NextRequest) {
  if (!portoneConfigured()) {
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  // One wall-clock budget starts before the first potentially blocking
  // dependency. SDKs without AbortSignal support are Promise-fenced below;
  // PostgREST reads/RPCs also receive this exact signal.
  const checkoutSignal = AbortSignal.timeout(
    CHECKOUT_DEPENDENCY_TIMEOUT_MS,
  );
  let gate: Awaited<ReturnType<typeof requireMember>>;
  try {
    gate = await waitForCheckoutDependency(
      requireMember(),
      checkoutSignal,
    );
  } catch (error) {
    log.error("pay.member_gate_timeout", errInfo(error));
    return NextResponse.json(
      { error: "payment_unavailable" },
      { status: 503 },
    );
  }
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  // 연령(만 19세)/약관/방침 동의는 로그인 직후 통합 게이트(requireMember 의 consent_required)에서 보장 — 여기 backstop 없음.

  // 인메모리 고정창 rate-limit — 결제 요청 난사 완화(per-instance 한계는 lib/rate-limit.ts 주석).
  if (!rateLimit(`pay-checkout:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  let requestBody: Awaited<ReturnType<typeof readApiJsonObjectRequest>>;
  try {
    requestBody = await waitForCheckoutDependency(
      readApiJsonObjectRequest(req),
      checkoutSignal,
    );
  } catch (error) {
    log.error("pay.request_body_timeout", {
      userId: user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "payment_unavailable" },
      { status: 503 },
    );
  }
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = parseCheckoutRequestBody(requestBody.value);
  if (!body) {
    // v0.92 이전 클라 본문(expectedProduct/expectedMode 포함 8키)은 구 탭 —
    // 자가치유(자동 새로고침) 코드로 안내한다.
    const legacyShape =
      requestBody.value !== null &&
      typeof requestBody.value === "object" &&
      "expectedProduct" in (requestBody.value as Record<string, unknown>);
    return NextResponse.json(
      { error: legacyShape ? "client_refresh_required" : "invalid_request" },
      { status: 400 },
    );
  }
  // 가격/개수/상품명은 서버 config 의 **active 상품**으로만 결정(클라 조작·비활성 상품 차단).
  let growth: Awaited<ReturnType<typeof getGrowthLeversStrict>>;
  try {
    // Checkout creates an immutable financial receipt. A cached/silent
    // fallback could retain a removed reviewer allowlist entry or stale
    // creditsEnabled/product state, so this boundary must read fresh and fail
    // closed on dependency or schema errors.
    growth = await waitForCheckoutDependency(
      getGrowthLeversStrict(),
      checkoutSignal,
    );
  } catch (error) {
    log.error("pay.growth_config_read_fail", {
      userId: user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "payment_unavailable" },
      { status: 503 },
    );
  }
  // 결제 노출 OFF(성장레버 creditsEnabled=false/미설정) → 준비중. 단 심사·테스트 계정은 허용.
  // reviewer = config allowlist(OAuth) OR reviewer_accounts(ID/PW, 0060) — /credits 표시와 동일 판정.
  let reviewer: Awaited<ReturnType<typeof getReviewerStatus>>;
  try {
    reviewer = await waitForCheckoutDependency(
      getReviewerStatus(growth, user),
      checkoutSignal,
    );
  } catch (error) {
    log.error("pay.reviewer_lookup_timeout", {
      userId: user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "payment_unavailable" },
      { status: 503 },
    );
  }
  if (!reviewer.ok) {
    // 분류 불확실 상태에서 false로 진행하면 실제 심사 계정에 LIVE 채널을 반환할 수 있다.
    log.error("pay.reviewer_lookup_fail", {
      userId: user.id,
      ...errInfo(reviewer.error),
    });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  const isReviewer = reviewer.isReviewer;
  if (!(growth.creditsEnabled ?? false) && !isReviewer) {
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  const products = activeCreditProducts(growth);
  const product =
    products.find((candidate) => candidate.productId === body.productId) ??
    null;
  if (!product) {
    return NextResponse.json({ error: "invalid_product" }, { status: 400 });
  }

  // 결제 파라미터는 전부 서버 판정 — 화면과의 정합(상품명·가격·문구)은 RPC 가
  // offer evidence(사용자가 본 스냅샷) + registry 로 단일 검증한다(0105).
  const mode = payModeFor(isReviewer, body.reviewerLive);
  const availableChannels = paymentChannels(mode);
  const channel =
    availableChannels.find(
      (candidate) => candidate.method === (body.method as PayChannelMethod),
    ) ?? null;
  if (!channel) {
    // 해당 모드의 채널키 미설정(예: 실연동 계약 전) 또는 알 수 없는 method.
    return NextResponse.json({ error: "channel_unavailable" }, { status: 503 });
  }
  const isTest = mode === "test";

  // 리다이렉트/웹훅 베이스 URL 검증 — 주문 생성 전에 fail-fast.
  // SITE_URL 이 오형식이거나 localhost 면 포트원 웹훅이 외부에서 도달 불가
  // → "결제는 됐는데 크레딧 미지급" 사고. 그 전에 막는다.
  let base: string;
  try {
    base = new URL(PUBLIC_ENV.SITE_URL).origin;
  } catch {
    log.error("pay.bad_site_url", { siteUrl: PUBLIC_ENV.SITE_URL });
    return NextResponse.json({ error: "payment_misconfigured" }, { status: 503 });
  }
  if (/localhost|127\.0\.0\.1/.test(base)) {
    log.error("pay.site_url_unreachable", { base });
    return NextResponse.json({ error: "payment_misconfigured" }, { status: 503 });
  }

  const admin = createAdminClient();

  // 조회→생성 분리는 두 탭이 동시에 "없음"을 보고 서로 다른 결제창을 여는
  // TOCTOU가 된다. 후보 ID 생성, 최근 pending 재사용, insert와 전체 snapshot
  // receipt를 하나의 user-serialized DB mutation으로 수렴시킨다.
  const candidateOrderUuid = randomUUID();
  const candidatePaymentId = paymentIdForOrder(candidateOrderUuid);
  const runCheckoutMutation = (
    priorResolutions: PriorIntentResolutionInput[] | null,
  ) =>
    admin
      .rpc("create_or_reuse_pending_order", {
        p_prior_resolutions: priorResolutions,
        p_user: user.id,
        p_order_uuid: candidateOrderUuid,
        p_product_id: product.productId,
        p_amount: product.price,
        p_credits: product.credits,
        p_payment_id: candidatePaymentId,
        p_provider: "portone",
        p_pay_channel: channel.method,
        p_is_test: isTest,
        p_expected_store_id: PUBLIC_ENV.PORTONE_STORE_ID,
        p_expected_currency: "KRW",
        p_expected_channel_key: channel.channelKey,
        p_checkout_request_id: body.checkoutRequestId,
        p_product_name: product.goodname,
        p_offer_evidence_id: body.offerEvidenceId,
        p_offer_snapshot_sha256: body.offerSnapshotSha256,
        p_withdrawal_copy_version:
          CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
        p_withdrawal_copy: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
        p_withdrawal_confirmed: true,
      })
      .abortSignal(checkoutSignal);
  let { data: mutationResult, error: insErr } = await runCheckoutMutation(null);
  {
    // 미해결 intent(다른 상품/수단·legacy·다건)는 예외가 아니라 정상 반환 —
    // 건별 포트원 비-PAID 실측 후 resolutions 로 1회 재호출하면 RPC 가 같은
    // 트랜잭션에서 종단+생성한다(0105 계약).
    const intents = insErr ? null : parseNeedsProviderResolution(mutationResult);
    if (intents) {
      const measurement = await measureUnsettledIntents(
        intents,
        user.id,
        checkoutSignal,
      );
      if (measurement.kind === "prior_paid") {
        // 직전 결제가 실제 완료된 미지급 주문 — 종단 금지, 웹훅/reconcile 지급 대기.
        log.warn("pay.prior_intent_paid_unsettled", {
          userId: user.id,
          orderUuid: measurement.orderUuid,
        });
        return NextResponse.json(
          { error: "checkout_prior_intent_paid" },
          { status: 409 },
        );
      }
      if (measurement.kind === "unmeasurable") {
        return NextResponse.json(
          { error: "checkout_prior_intent_unresolved" },
          { status: 409 },
        );
      }
      log.info("pay.prior_intent_auto_resolved", {
        userId: user.id,
        canceled: measurement.resolutions.length,
      });
      ({ data: mutationResult, error: insErr } = await runCheckoutMutation(
        measurement.resolutions,
      ));
      if (!insErr && parseNeedsProviderResolution(mutationResult)) {
        // 재호출 사이에 새 미해결이 또 생긴 경합 — 한 번 더 돌지 않고 정직하게 알린다.
        return NextResponse.json(
          { error: "checkout_prior_intent_unresolved" },
          { status: 409 },
        );
      }
    }
  }
  if (insErr) {
    // invalid_product 는 §38 매핑으로 기존 400 {error:'invalid_product'} 그대로(서버 config↔RPC allowlist 드리프트 신호).
    log.error("pay.order_insert_fail", { userId: user.id, ...errInfo(insErr) });
    const p = refundRpcErrorResponsePayload(insErr, {
      route: "pay/checkout",
      userId: user.id,
      orderUuid: candidateOrderUuid,
    });
    return NextResponse.json(p.body, { status: p.status });
  }
  const receipt = parseAtomicCheckoutReceipt(mutationResult, {
    candidateOrderUuid,
    userId: user.id,
    productId: product.productId,
    amount: product.price,
    credits: product.credits,
    isTest,
    payChannel: channel.method,
    expectedStoreId: PUBLIC_ENV.PORTONE_STORE_ID,
    expectedCurrency: "KRW",
    expectedChannelKey: channel.channelKey,
    checkoutRequestId: body.checkoutRequestId,
    productName: product.goodname,
    payMode: mode,
    offerEvidenceId: body.offerEvidenceId,
    offerSnapshotSha256: body.offerSnapshotSha256,
    withdrawalCopyVersion:
      CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
    withdrawalCopy: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
  });
  if (!receipt) {
    log.error("pay.order_insert_invalid_result", {
      userId: user.id,
      candidateOrderUuid,
      resultType: typeof mutationResult,
    });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  const {
    orderUuid,
    paymentId,
    amount,
    credits,
    status,
    expectedStoreId,
    expectedCurrency,
    expectedChannelKey,
    withdrawalEvidenceId,
  } = receipt;

  Sentry.setTag("pay.product", product.productId);
  log.info("pay.checkout_ok", {
    userId: user.id,
    orderUuid,
    productId: product.productId,
    channel: channel.method,
    mode,
    reused: receipt.reused,
  });
  // 클라는 이 서버 결정값으로 requestPayment 호출. redirectUrl 은 클라가 /credits/done?order= 로 구성.
  const response = parseCheckoutHttpResponse({
    orderUuid,
    paymentId,
    orderName: product.goodname,
    totalAmount: amount,
    storeId: expectedStoreId,
    currency: expectedCurrency,
    channelKey: expectedChannelKey,
    payMethod: channel.payMethod,
  });
  if (!response) {
    log.error("pay.checkout_invalid_http_contract", { orderUuid });
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  return NextResponse.json(response);
}
