import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { portoneConfigured, getPortonePayment, paymentModeMismatch } from "@/lib/portone";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 오래된 결제요청 대사 — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * 결제 시도 후 2시간+ pending 을 포트원 단건 조회로 **실제 대사**한다(페이앱 시절 '탐지+경고만'에서 승격):
 *  - PAID + 금액 일치 → 멱등 지급(mark_paid_and_grant — 웹훅과 동일 RPC, 중복 안전)
 *  - CANCELLED/FAILED → 종단 상태 반영. PARTIAL_CANCELLED 는 미해결(자동 화해 금지 — 전량 회수 위험)
 *  - READY 등 진행형이 24h+ 경과(결제창 이탈 좀비) → failed 시효 종단 — oldest-first 배치가 불멸
 *    row 에 점유돼 뒤의 PAID 건이 굶는 기아를 차단(리뷰 확정 결함). failed 는 준종단(0058)이라
 *    이후 같은 paymentId 로 결제가 성공해도 웹훅/폴링의 PAID 재검증이 부활 지급한다.
 *  - 그 외/조회 실패 → 미해결로 남기고 경고(운영 확인)
 * 처리량은 호출당 20건(오래된 순) — Vercel 함수 타임아웃 안에서 외부 API 직렬 호출을 감당하는 상한.
 */
const STALE_MS = 2 * 60 * 60 * 1000;
const EXPIRE_MS = 24 * 60 * 60 * 1000; // 진행형(READY 등) pending 의 시효 종단 기준
const BATCH = 20;
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
    .from("orders")
    .select("order_uuid, payment_id, amount, user_id, created_at, canceled_at, is_test")
    .eq("status", "pending")
    .eq("provider", "portone")
    .not("payment_id", "is", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    log.error("pay.reconcile_query_fail", errInfo(error));
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const rows = data ?? [];
  let granted = 0;
  let canceled = 0;
  let failed = 0;
  const unresolved: string[] = [];

  if (rows.length > 0 && !portoneConfigured()) {
    log.warn("pay.reconcile_unconfigured", { count: rows.length });
    return NextResponse.json({ count: rows.length, error: "pg_unconfigured" }, { status: 503 });
  }

  for (const row of rows) {
    const got = await getPortonePayment(row.payment_id!);
    if (!got.ok) {
      if (got.kind === "not_found") {
        // 결제 시도 자체가 없던 이탈 pending — 실패 종단 처리(잔존 방지).
        const { error: fErr } = await admin
          .from("orders")
          .update({ status: "failed", error_message: "reconcile_no_payment" })
          .eq("order_uuid", row.order_uuid)
          .eq("status", "pending");
        if (!fErr) failed += 1;
        else unresolved.push(row.order_uuid);
      } else {
        unresolved.push(row.order_uuid);
      }
      continue;
    }
    const p = got.payment;
    // 채널 모드 대사(백스톱) — 웹훅/폴링과 동일 규칙(테스트 채널 → 실주문 지급 차단).
    const mismatch = p.status === "PAID" ? paymentModeMismatch(p, row.is_test === true) : null;
    if (mismatch === "block") {
      log.error("pay.reconcile_test_channel_on_live_order", { orderUuid: row.order_uuid });
      await admin
        .from("orders")
        .update({ error_message: "test_channel_on_live_order" })
        .eq("order_uuid", row.order_uuid);
      unresolved.push(row.order_uuid);
    } else if (p.status === "PAID" && (p.amount?.total ?? -1) === row.amount) {
      if (mismatch === "warn") log.warn("pay.reconcile_live_channel_on_test_order", { orderUuid: row.order_uuid });
      const { data: ok, error: gErr } = await admin.rpc("mark_paid_and_grant", {
        p_order_uuid: row.order_uuid,
        p_pg_tx_id: p.transactionId || null,
        p_price: p.amount!.total,
        p_raw: { source: "reconcile", verified_status: p.status },
      });
      if (gErr || ok === false) {
        log.error("pay.reconcile_grant_fail", { orderUuid: row.order_uuid, ...errInfo(gErr) });
        unresolved.push(row.order_uuid);
      } else {
        granted += 1;
        log.warn("pay.reconcile_granted", {
          message: "웹훅 유실 감지 — 대사에서 지급 처리(웹훅 설정 점검 필요)",
          orderUuid: row.order_uuid,
        });
      }
    } else if (p.status === "CANCELLED") {
      const { error: cErr } = await admin
        .from("orders")
        .update({
          status: "canceled",
          pg_status: p.status,
          canceled_at: row.canceled_at ?? new Date().toISOString(),
        })
        .eq("order_uuid", row.order_uuid)
        .eq("status", "pending");
      if (!cErr) canceled += 1;
      else unresolved.push(row.order_uuid);
    } else if (p.status === "FAILED") {
      const { error: fErr } = await admin
        .from("orders")
        .update({ status: "failed", pg_status: p.status, error_message: "pg_failed" })
        .eq("order_uuid", row.order_uuid)
        .eq("status", "pending");
      if (!fErr) failed += 1;
      else unresolved.push(row.order_uuid);
    } else if (p.status === "PARTIAL_CANCELLED") {
      // 부분취소 = 콘솔 수동 개입 신호 — 자동 종단·화해 금지(전량 회수 위험). 경고만.
      log.warn("pay.reconcile_partial_cancelled", { orderUuid: row.order_uuid });
      unresolved.push(row.order_uuid);
    } else if (Date.now() - new Date(row.created_at).getTime() > EXPIRE_MS) {
      // READY 등 진행형이 24h+ — 결제창 이탈 좀비. failed 시효 종단(준종단 — 늦은 성공은 부활 지급).
      const { error: eErr } = await admin
        .from("orders")
        .update({ status: "failed", pg_status: p.status, error_message: "reconcile_expired" })
        .eq("order_uuid", row.order_uuid)
        .eq("status", "pending");
      if (!eErr) failed += 1;
      else unresolved.push(row.order_uuid);
    } else {
      // READY/PENDING 등 24h 미만 — 아직 진행 중일 수 있어 보존, 미해결로 보고.
      unresolved.push(row.order_uuid);
    }
  }

  if (unresolved.length > 0) {
    // 확인 필요 경고(미지급 단정 아님). orderIds 는 최대 10개만 동봉.
    log.warn("pay.stale_payment_request", {
      message: "오래된 결제요청 — 자동 대사로 해소되지 않아 운영 확인 필요",
      count: unresolved.length,
      orderIds: unresolved.slice(0, MAX_IDS),
    });
  }
  return NextResponse.json({ count: rows.length, granted, canceled, failed, unresolved: unresolved.length });
}
