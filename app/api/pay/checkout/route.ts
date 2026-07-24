import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
import { getGrowthLevers } from "@/lib/config/getters";
import { activeCreditProducts, payModeFor } from "@/lib/config/domains/growth";
import { isReviewerUser } from "@/lib/reviewer";
import { paymentChannels, type PayChannelMethod } from "@/lib/pay-channels";
import { portoneConfigured, paymentIdForOrder } from "@/lib/portone";
import { assertWriteAllowed } from "@/lib/credits-gate";
import { rateLimit } from "@/lib/rate-limit";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// 같은 user+product 의 미완료 주문을 재사용해 결제 중복 클릭 시 주문 난립을 막는 창.
// 포트원 paymentId 는 "성공 전까지 재시도 가능"이라 미결제 paymentId 재사용이 안전(중복 결제는 포트원이 차단).
const REUSE_WINDOW_MS = 10 * 60 * 1000;

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
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  // 14세/약관/방침 동의는 로그인 직후 통합 게이트(requireMember 의 consent_required)에서 보장 — 여기 backstop 없음.

  // Phase-A 유지보수 게이트(v0.76 컷오버) — closed 면 신규 결제 진입 차단.
  const maintenance = assertWriteAllowed({ actor: "user", userId: user.id });
  if (maintenance) return maintenance;

  // 인메모리 고정창 rate-limit — 결제 요청 난사 완화(per-instance 한계는 lib/rate-limit.ts 주석).
  if (!rateLimit(`pay-checkout:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    productId?: string;
    method?: string;
    wantLive?: boolean;
  } | null;
  // 가격/개수/상품명은 서버 config 의 **active 상품**으로만 결정(클라 조작·비활성 상품 차단).
  const growth = await getGrowthLevers();
  // 결제 노출 OFF(성장레버 creditsEnabled=false/미설정) → 준비중. 단 심사·테스트 계정은 허용.
  // reviewer = config allowlist(OAuth) OR reviewer_accounts(ID/PW, 0060) — /credits 표시와 동일 판정.
  const isReviewer = await isReviewerUser(growth, user);
  if (!(growth.creditsEnabled ?? false) && !isReviewer) {
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  const product = body?.productId
    ? activeCreditProducts(growth).find((p) => p.productId === body.productId) ?? null
    : null;
  if (!product) {
    return NextResponse.json({ error: "invalid_product" }, { status: 400 });
  }

  // 채널 모드·채널키는 **서버 판정**(클라 body 는 힌트) — 일반 계정은 wantLive 무관 항상 실채널이라
  // 테스트 채널로 무료 크레딧을 얻는 경로가 원천 차단된다. 심사 계정은 테스트 기본, wantLive 시 실채널.
  const mode = payModeFor(isReviewer, body?.wantLive === true);
  const channel =
    paymentChannels(mode).find((c) => c.method === (body?.method as PayChannelMethod)) ?? null;
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

  // 1) 최근 재사용 가능한 pending 주문 있으면 같은 paymentId 재사용(미결제 paymentId 재호출은 포트원 허용).
  //    amount 일치 조건 필수 — 그 사이 어드민이 가격을 바꿨으면 주문 스냅샷과 결제금액이 어긋나
  //    전 경로(웹훅/폴링/대사)의 금액 대사에 걸려 '수금됐는데 미지급'으로 고착된다(리뷰 확정 결함).
  const since = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
  const { data: reuse } = await admin
    .from("orders")
    .select("order_uuid, payment_id")
    .eq("user_id", user.id)
    .eq("product_id", product.productId)
    .eq("status", "pending")
    .eq("provider", "portone")
    .eq("amount", product.price)
    // 모드·채널까지 일치해야 재사용 — 테스트↔실 주문 교차 재사용은 지급 백스톱(채널 대사)에 걸린다.
    .eq("is_test", isTest)
    .eq("pay_channel", channel.method)
    .not("payment_id", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (reuse?.payment_id) {
    log.info("pay.checkout_reuse", { userId: user.id, orderUuid: reuse.order_uuid });
    return NextResponse.json({
      orderUuid: reuse.order_uuid,
      paymentId: reuse.payment_id,
      orderName: product.goodname,
      totalAmount: product.price,
      channelKey: channel.channelKey,
      payMethod: channel.payMethod,
    });
  }

  // 2) 새 주문 pending 선삽입 — paymentId(=order_uuid 하이픈 제거, KPN 영숫자 제약)까지 함께.
  const orderUuid = randomUUID();
  const paymentId = paymentIdForOrder(orderUuid);
  const { error: insErr } = await admin.from("orders").insert({
    order_uuid: orderUuid,
    payment_id: paymentId,
    provider: "portone",
    user_id: user.id,
    product_id: product.productId,
    amount: product.price,
    credits: product.credits,
    status: "pending",
    is_test: isTest,
    pay_channel: channel.method,
  });
  if (insErr) {
    log.error("pay.order_insert_fail", { userId: user.id, ...errInfo(insErr) });
    return NextResponse.json({ error: "order_create_failed" }, { status: 500 });
  }

  Sentry.setTag("pay.product", product.productId);
  log.info("pay.checkout_ok", {
    userId: user.id,
    orderUuid,
    productId: product.productId,
    channel: channel.method,
    mode,
  });
  // 클라는 이 서버 결정값으로 requestPayment 호출. redirectUrl 은 클라가 /credits/done?order= 로 구성.
  return NextResponse.json({
    orderUuid,
    paymentId,
    orderName: product.goodname,
    totalAmount: product.price,
    channelKey: channel.channelKey,
    payMethod: channel.payMethod,
  });
}
