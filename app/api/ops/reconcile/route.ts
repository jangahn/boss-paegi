import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 오래된 결제요청 대사 — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * 결제 시도(mul_no 有) 후 2시간+ pending 을 탐지해 **확인 필요** 경고만 낸다(자동 지급/변경 없음).
 * ⚠️ "결제완료 미지급"으로 단정 금지 — 미결제 이탈 포함. 페이앱 관리자에서 결제완료 여부 확인 필요.
 */
const STALE_MS = 2 * 60 * 60 * 1000;
const MAX_IDS = 10;

export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "reconcile_disabled" }, { status: 503 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data, error } = await admin
    .from("payapp_orders")
    .select("order_uuid, created_at, amount, user_id")
    .eq("status", "pending")
    .not("mul_no", "is", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    log.error("payapp.reconcile_query_fail", errInfo(error));
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    // 확인 필요 경고(미지급 단정 아님). orderIds 는 최대 10개만 동봉.
    log.warn("payapp.stale_payment_request", {
      message: "오래된 결제요청 — 페이앱 관리자에서 결제완료 여부 확인 필요",
      count,
      orderIds: data!.slice(0, MAX_IDS).map((r) => r.order_uuid),
    });
  }
  return NextResponse.json({ count });
}
