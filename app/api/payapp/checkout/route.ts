import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
import { getCreditProduct } from "@/lib/credit-products";
import { createPayRequest, payappConfigured } from "@/lib/payapp";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// 같은 user+product 의 미완료 주문을 재사용해 결제 중복 클릭 시 주문 난립을 막는 창.
const REUSE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 결제요청 생성 — 로그인 회원만. price/credits 는 서버 allowlist 로만 결정(클라 조작 차단).
 * pending 주문을 먼저 insert(웹훅이 먼저 와도 order_uuid 로 조회되게) 후 payrequest.
 */
export async function POST(req: NextRequest) {
  if (!payappConfigured()) {
    return NextResponse.json({ error: "payment_unavailable" }, { status: 503 });
  }
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const body = (await req.json().catch(() => null)) as { productId?: string } | null;
  const product = body?.productId ? getCreditProduct(body.productId) : null;
  if (!product) {
    return NextResponse.json({ error: "invalid_product" }, { status: 400 });
  }

  // 콜백 베이스 URL 검증 — 주문 생성 전에 fail-fast.
  // SITE_URL 이 오형식이거나 localhost 면 페이앱 웹훅/return 이 외부에서 도달 불가
  // → "결제는 됐는데 크레딧 미지급" 사고. 그 전에 막는다.
  let base: string;
  try {
    base = new URL(PUBLIC_ENV.SITE_URL).origin;
  } catch {
    log.error("payapp.bad_site_url", { siteUrl: PUBLIC_ENV.SITE_URL });
    return NextResponse.json({ error: "payment_misconfigured" }, { status: 503 });
  }
  if (/localhost|127\.0\.0\.1/.test(base)) {
    log.error("payapp.site_url_unreachable", { base });
    return NextResponse.json({ error: "payment_misconfigured" }, { status: 503 });
  }

  const admin = createAdminClient();

  // 1) 최근 재사용 가능한 pending 주문 있으면 그 payurl 재사용.
  const since = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
  const { data: reuse } = await admin
    .from("payapp_orders")
    .select("order_uuid, payurl")
    .eq("user_id", user.id)
    .eq("product_id", product.productId)
    .eq("status", "pending")
    .not("mul_no", "is", null)
    .not("payurl", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (reuse?.payurl) {
    log.info("payapp.checkout_reuse", {
      userId: user.id,
      orderUuid: reuse.order_uuid,
    });
    return NextResponse.json({ payurl: reuse.payurl });
  }

  // 2) 새 주문 pending 선삽입.
  const orderUuid = randomUUID();
  const { error: insErr } = await admin.from("payapp_orders").insert({
    order_uuid: orderUuid,
    user_id: user.id,
    product_id: product.productId,
    amount: product.price,
    credits: product.credits,
    status: "pending",
  });
  if (insErr) {
    log.error("payapp.order_insert_fail", { userId: user.id, ...errInfo(insErr) });
    return NextResponse.json({ error: "order_create_failed" }, { status: 500 });
  }

  // 3) payrequest. (base 는 위에서 검증됨) — 저볼륨이라 전수 트레이싱, 태그는 저카디널리티(product)만.
  Sentry.setTag("payapp.product", product.productId);
  const result = await Sentry.startSpan(
    {
      name: "payapp.payrequest",
      attributes: { product: product.productId, amount: product.price },
    },
    () =>
      createPayRequest({
        product,
        userId: user.id,
        orderUuid,
        feedbackUrl: `${base}/api/payapp/feedback`,
        returnUrl: `${base}/api/payapp/return?order=${orderUuid}`,
      })
  );

  if (!result.ok) {
    await admin
      .from("payapp_orders")
      .update({ status: "failed", error_message: result.error })
      .eq("order_uuid", orderUuid);
    return NextResponse.json({ error: "payment_request_failed" }, { status: 502 });
  }

  // 4) mul_no + payurl 기록. 실패해도 결제는 진행(웹훅은 order_uuid 로 조회) — 로그만.
  const { error: updErr } = await admin
    .from("payapp_orders")
    .update({ mul_no: result.mulNo, payurl: result.payurl })
    .eq("order_uuid", orderUuid);
  if (updErr) {
    log.error("payapp.checkout_payurl_update_fail", { orderUuid, ...errInfo(updErr) });
  }

  log.info("payapp.checkout_ok", {
    userId: user.id,
    orderUuid,
    productId: product.productId,
  });
  return NextResponse.json({ payurl: result.payurl });
}
