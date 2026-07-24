import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { portoneConfigured, getPortonePaymentSnapshot } from "@/lib/portone";
import { handleObservedCancellation, sweepOpenPgAttempts } from "@/lib/refund-saga";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 오래된 결제요청 대사 — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * 결제 시도 후 2시간+ pending 을 포트원 단건 조회로 **실제 대사**한다(페이앱 시절 '탐지+경고만'에서 승격):
 *  - PAID + 금액 일치 → 멱등 지급(mark_paid_and_grant — 웹훅과 동일 RPC, 중복 안전)
 *  - CANCELLED/PARTIAL_CANCELLED → 이벤트 영속 + 대사 RPC(handleObservedCancellation — 직접 종단 금지 §13)
 *  - FAILED → mark_order_failed(pending 한정 전이는 RPC 소관)
 *  - READY 등 진행형이 24h+ 경과(결제창 이탈 좀비) → failed 시효 종단 — oldest-first 배치가 불멸
 *    row 에 점유돼 뒤의 PAID 건이 굶는 기아를 차단(리뷰 확정 결함). failed 는 준종단(0058)이라
 *    이후 같은 paymentId 로 결제가 성공해도 웹훅/폴링의 PAID 재검증이 부활 지급한다.
 *  - 그 외/조회 실패 → 미해결로 남기고 경고(운영 확인)
 * 지급 대사 후 refund-sweep 확장(B.8.6): open PG attempt 순회(항목별 독립·완전 멱등).
 * 처리량은 호출당 20건(오래된 순) — Vercel 함수 타임아웃 안에서 외부 API 직렬 호출을 감당하는 상한.
 * drain 경로 — Phase-A 게이트(assertWriteAllowed) 미적용(closed 에서도 기시작 건 종결).
 */
const STALE_MS = 2 * 60 * 60 * 1000;
const EXPIRE_MS = 24 * 60 * 60 * 1000; // 진행형(READY 등) pending 의 시효 종단 기준
const BATCH = 20;
const MAX_IDS = 10;

/** 채널 모드 대사(백스톱) — paymentModeMismatch 와 동일 판정을 snapshot.channelType 으로 수행. */
function channelModeMismatch(
  channelType: "LIVE" | "TEST" | null,
  orderIsTest: boolean
): "block" | "warn" | null {
  if (channelType === "TEST" && !orderIsTest) return "block";
  if (channelType === "LIVE" && orderIsTest) return "warn";
  return null;
}

/** cron 심박 기록(§29) — rpc 실패는 경고만(cron 자체를 죽이지 않음). */
async function heartbeat(
  admin: ReturnType<typeof createAdminClient>,
  phase: "start" | "success" | "failure",
  errorCode?: string
) {
  const { error } = await admin.rpc("ops_cron_heartbeat", {
    p_job: "reconcile",
    p_phase: phase,
    p_error_code: errorCode ?? null,
  });
  if (error) {
    log.warn("pay.reconcile_heartbeat_fail", { phase, ...errInfo(error) });
  }
}

export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "reconcile_disabled" }, { status: 503 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  await heartbeat(admin, "start");

  try {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const { data, error } = await admin
      .from("orders")
      .select("order_uuid, payment_id, amount, user_id, created_at, paid_at, is_test")
      .eq("status", "pending")
      .eq("provider", "portone")
      .not("payment_id", "is", null)
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(BATCH);

    if (error) {
      log.error("pay.reconcile_query_fail", errInfo(error));
      await heartbeat(admin, "failure", "query_failed");
      return NextResponse.json({ error: "query_failed" }, { status: 500 });
    }

    const rows = data ?? [];
    let granted = 0;
    let canceled = 0;
    let failed = 0;
    const unresolved: string[] = [];

    if (rows.length > 0 && !portoneConfigured()) {
      log.warn("pay.reconcile_unconfigured", { count: rows.length });
      await heartbeat(admin, "failure", "pg_unconfigured");
      return NextResponse.json({ count: rows.length, error: "pg_unconfigured" }, { status: 503 });
    }

    for (const row of rows) {
      const got = await getPortonePaymentSnapshot(row.payment_id!);
      if (!got.ok) {
        if (got.kind === "not_found") {
          // 결제 시도 자체가 없던 이탈 pending — 실패 종단 처리(잔존 방지, 전이는 RPC 소관).
          const { error: fErr } = await admin.rpc("mark_order_failed", {
            p_order_uuid: row.order_uuid,
            p_pg_status: null,
            p_error_message: "reconcile_no_payment",
          });
          if (!fErr) failed += 1;
          else unresolved.push(row.order_uuid);
        } else {
          unresolved.push(row.order_uuid);
        }
        continue;
      }
      const snapshot = got.snapshot;
      // 채널 모드 대사(백스톱) — 웹훅/폴링과 동일 규칙(테스트 채널 → 실주문 지급 차단).
      const mismatch =
        snapshot.status === "PAID"
          ? channelModeMismatch(snapshot.channelType, row.is_test === true)
          : null;
      if (mismatch === "block") {
        log.error("pay.reconcile_test_channel_on_live_order", { orderUuid: row.order_uuid });
        await admin
          .from("orders")
          .update({ error_message: "test_channel_on_live_order" })
          .eq("order_uuid", row.order_uuid);
        unresolved.push(row.order_uuid);
      } else if (snapshot.status === "PAID" && snapshot.totalAmount === row.amount) {
        if (mismatch === "warn") log.warn("pay.reconcile_live_channel_on_test_order", { orderUuid: row.order_uuid });
        // paid_at 명시 전달 필수(§12.4) — 부재면 grant 시도 자체를 실패 로깅 후 미해결로 보존.
        const paidAt = typeof snapshot.raw.paidAt === "string" ? snapshot.raw.paidAt : null;
        if (!paidAt) {
          log.error("pay.paid_at_missing", { orderUuid: row.order_uuid, paymentId: row.payment_id });
          unresolved.push(row.order_uuid);
          continue;
        }
        const { data: ok, error: gErr } = await admin.rpc("mark_paid_and_grant", {
          p_order_uuid: row.order_uuid,
          p_pg_tx_id:
            typeof snapshot.raw.transactionId === "string" ? snapshot.raw.transactionId : null,
          p_price: snapshot.totalAmount,
          p_raw: snapshot.raw,
          p_paid_at: paidAt,
          p_receipt_url:
            typeof snapshot.raw.receiptUrl === "string" ? snapshot.raw.receiptUrl : null,
        });
        if (gErr || ok === false) {
          // false = 중복·금액 불일치 멱등 skip(late_paid/intent/탈퇴자는 RPC 가 true 로 흡수, §40).
          log.error("pay.reconcile_grant_fail", { orderUuid: row.order_uuid, ...errInfo(gErr) });
          unresolved.push(row.order_uuid);
        } else {
          granted += 1;
          log.warn("pay.reconcile_granted", {
            message: "웹훅 유실 감지 — 대사에서 지급 처리(웹훅 설정 점검 필요)",
            orderUuid: row.order_uuid,
          });
        }
      } else if (snapshot.status === "CANCELLED" || snapshot.status === "PARTIAL_CANCELLED") {
        // 직접 canceled UPDATE 제거(§13) — 이벤트 영속 + 대사 RPC. 부분취소는 영속만(1급 관측),
        // 경제 해소는 resolver/운영자 — 미해결로 보고해 운영 확인 흐름 유지.
        const res = await handleObservedCancellation(
          admin,
          { order_uuid: row.order_uuid, paid_at: row.paid_at },
          snapshot
        );
        if (res.outcome === "canceled_unpaid" || res.outcome === "resolved_full") canceled += 1;
        else unresolved.push(row.order_uuid);
      } else if (snapshot.status === "FAILED") {
        const { error: fErr } = await admin.rpc("mark_order_failed", {
          p_order_uuid: row.order_uuid,
          p_pg_status: snapshot.status,
          p_error_message: "pg_failed",
          p_raw: snapshot.raw,
        });
        if (!fErr) failed += 1;
        else unresolved.push(row.order_uuid);
      } else if (Date.now() - new Date(row.created_at).getTime() > EXPIRE_MS) {
        // READY 등 진행형이 24h+ — 결제창 이탈 좀비. failed 시효 종단(준종단 — 늦은 성공은 부활 지급).
        const { error: eErr } = await admin.rpc("mark_order_failed", {
          p_order_uuid: row.order_uuid,
          p_pg_status: snapshot.status,
          p_error_message: "reconcile_expired",
        });
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

    // refund-sweep 확장(B.8.6) — open PG attempt(pg_requested/pg_pending/pg_succeeded) 순회.
    // 항목별 독립 처리·완전 멱등(processAttemptAuto) — 지급 대사 실패와 무관하게 항상 수행.
    const sweep = await sweepOpenPgAttempts(admin, 20);

    await heartbeat(admin, "success");
    return NextResponse.json({
      count: rows.length,
      granted,
      canceled,
      failed,
      unresolved: unresolved.length,
      attemptsChecked: sweep.attemptsChecked,
      transitions: sweep.transitions,
      issuesOpened: sweep.issuesOpened,
    });
  } catch (e) {
    log.error("pay.reconcile_exception", errInfo(e));
    await heartbeat(admin, "failure", "exception");
    return NextResponse.json({ error: "exception" }, { status: 500 });
  }
}
