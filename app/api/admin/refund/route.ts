import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { paycancelOrder, payappCancelConfigured } from "@/lib/payapp";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 정상결제 환불 — 페이앱 자동취소 + 크레딧 롤백. 관리자만.
 *
 * 두 진입 모드:
 *  - FRESH/RECOVERY (status='paid'): 선검사(신규만 회수부족 엄격차단) → CAS → paycancel → payapp_done → RPC(p_payapp_done=true).
 *      커밋실패 시 payapp_done 유지 → '환불 재시도'(paycancel 멱등 → already_canceled) 복구.
 *  - RECONCILE (status='canceled' + paid_at + cancel_refund ledger 없음): 페이앱 취소 웹훅이 먼저 도착해
 *      status 만 canceled 되고 크레딧 미회수인 경우. paycancel 생략(웹훅=인증된 취소 확정) → CAS → RPC 화해(p_payapp_done=true) 회수.
 *
 * 회수는 RPC 가 보장(FOR UPDATE·payapp_done 시 clamp+shortfall·ledger 부분유니크로 중복 회수 차단). auto-retry 금지.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { orderUuid?: string; reason?: string }
    | null;
  if (!body?.orderUuid || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const orderUuid = body.orderUuid;
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 1) 주문 로드
  const { data: order, error: loadErr } = await admin
    .from("payapp_orders")
    .select("order_uuid, status, mul_no, credits, user_id, refund_state, paid_at")
    .eq("order_uuid", orderUuid)
    .maybeSingle();
  if (loadErr) {
    log.warn("admin.refund_load_fail", { orderUuid, ...errInfo(loadErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });

  // 2) 이미 환불 ledger 있으면 멈춤(멱등 — 중복 회수 방지)
  const { count: ledgerCount } = await admin
    .from("admin_actions_ledger")
    .select("id", { count: "exact", head: true })
    .eq("order_uuid", orderUuid)
    .eq("action_type", "cancel_refund");
  if ((ledgerCount ?? 0) > 0) {
    return NextResponse.json({ error: "already_processed" }, { status: 400 });
  }

  // 3) 모드 판정
  const priorState = (order.refund_state as string | null) ?? null;
  const isPaid = order.status === "paid";
  const isCanceled = order.status === "canceled";
  if (!isPaid && !isCanceled) {
    return NextResponse.json({ error: "not_cancelable" }, { status: 400 }); // pending/failed
  }
  if (isCanceled && !order.paid_at) {
    // 미결제 상태로 취소(지급된 크레딧 없음) → 회수할 것 없음.
    return NextResponse.json({ error: "already_processed" }, { status: 400 });
  }

  const doPaycancel = isPaid; // canceled = 웹훅이 이미 취소 확정 → paycancel 생략(화해)
  const strictBlock = isPaid && priorState === null; // 신규 paid 만 페이앱 호출 전 엄격 차단

  if (doPaycancel) {
    if (!order.mul_no) return NextResponse.json({ error: "no_mul_no" }, { status: 400 });
    if (!payappCancelConfigured()) {
      return NextResponse.json({ error: "cancel_unavailable" }, { status: 503 });
    }
  }

  // 4) 회수부족 선검사(신규 paid 만, 페이앱 호출 전 엄격 차단). 복구/화해는 이미 외부 취소됨 → clamp.
  if (strictBlock) {
    const { data: member } = await admin
      .from("member_accounts")
      .select("gen_credits")
      .eq("user_id", order.user_id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "member_not_found" }, { status: 404 });
    if (order.credits > member.gen_credits) {
      return NextResponse.json(
        { error: "insufficient_credits", credits: order.credits, balance: member.gen_credits },
        { status: 400 }
      );
    }
  }

  // 5) CAS 단일플라이트: in_progress 획득. status 는 paid|canceled 허용(위 가드가 비대상 제거 완료).
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: acquired, error: casErr } = await admin
    .from("payapp_orders")
    .update({ refund_state: "in_progress", updated_at: new Date().toISOString() })
    .eq("order_uuid", orderUuid)
    .in("status", ["paid", "canceled"])
    .or(
      `refund_state.is.null,refund_state.eq.payapp_done,and(refund_state.eq.in_progress,updated_at.lt.${staleCutoff})`
    )
    .select("order_uuid");
  if (casErr) {
    log.warn("admin.refund_cas_fail", { orderUuid, ...errInfo(casErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  if (!acquired || acquired.length === 0) {
    return NextResponse.json({ error: "already_processed" }, { status: 409 });
  }

  const reset = (state: string | null) =>
    admin
      .from("payapp_orders")
      .update({ refund_state: state, updated_at: new Date().toISOString() })
      .eq("order_uuid", orderUuid);

  // 6) 페이앱 취소(신규/복구 paid 만; 화해는 웹훅이 이미 확정)
  if (doPaycancel) {
    const pc = await paycancelOrder({ mulNo: order.mul_no!, cancelMemo: reason });
    if (!pc.ok) {
      await reset(priorState); // 신규→null, 복구→payapp_done (재시도 가능)
      if (pc.kind === "settled") {
        return NextResponse.json(
          {
            manual: true,
            error: "manual_required",
            message: "정산 마감(D+5) 등으로 자동 취소 불가 — 페이앱 관리자에서 수동 처리 후 확인하세요.",
          },
          { status: 200 }
        );
      }
      if (pc.kind === "unknown") {
        return NextResponse.json(
          { error: "unknown_cancel_state", message: "페이앱 취소 응답 확인 필요 — 운영 확인 후 재시도하세요." },
          { status: 502 }
        );
      }
      return NextResponse.json(
        { error: "payapp_unreachable", message: "페이앱 연결 실패 — 잠시 후 재시도하세요." },
        { status: 502 }
      );
    }
  }

  // 7) 외부 취소 확정 → payapp_done 마킹. 이 마킹 실패도 커밋실패로 처리(가장 위험 상태 정확 분류).
  const { error: markErr } = await reset("payapp_done");
  if (markErr) {
    log.error("payapp.refund_commit_fail", { orderUuid, adminId: gate.user.id, stage: "mark", ...errInfo(markErr) });
    return NextResponse.json(
      { error: "refund_commit_fail", message: "페이앱 환불 성공·로컬 반영 실패 — '환불 재시도'로 재처리하세요." },
      { status: 500 }
    );
  }

  // 8) 원자적 로컬 커밋(회수 + ledger). 실패 시 payapp_done 유지 → 복구 가능.
  const { data: rpc, error: rpcErr } = await admin.rpc("admin_cancel_order", {
    p_admin: gate.user.id,
    p_order_uuid: orderUuid,
    p_clawback: true,
    p_reason: reason,
    p_payapp_done: true,
  });
  if (rpcErr) {
    log.error("payapp.refund_commit_fail", {
      orderUuid,
      adminId: gate.user.id,
      reconcile: isCanceled,
      ...errInfo(rpcErr),
    });
    return NextResponse.json(
      {
        error: "refund_commit_fail",
        code: adminRpcErrorCode(rpcErr),
        message: "페이앱 환불은 성공했으나 로컬 반영 실패 — '환불 재시도'로 재처리하세요.",
      },
      { status: 500 }
    );
  }
  log.info("admin.refund_ok", { orderUuid, adminId: gate.user.id, reconcile: isCanceled });
  return NextResponse.json(rpc ?? { ok: true });
}
