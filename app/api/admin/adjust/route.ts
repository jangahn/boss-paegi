import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { parseCreditAdjustmentResult } from "@/lib/admin-credit-adjust";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rpcFailure(error: { message?: string } | null) {
  const code = adminRpcErrorCode(error);
  if (code === "idempotency_conflict" || code === "request_aborted") {
    return NextResponse.json({ error: code }, { status: 409 });
  }
  if (code === "account_deleted") {
    return NextResponse.json({ error: code }, { status: 409 });
  }
  if (
    code === "member_not_found" ||
    code === "account_not_found" ||
    code === "reason_invalid" ||
    code === "delta_invalid" ||
    code === "request_id_invalid"
  ) {
    return NextResponse.json({ error: code }, { status: 400 });
  }
  return NextResponse.json(
    { error: "adjustment_unavailable" },
    { status: 503 },
  );
}

// CS 크레딧 조정 — 관리자만. 요청 UUID 영수증으로 응답 유실·재시도까지 exactly-once.
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    action?: "apply" | "recover";
    requestId?: string;
    targetUserId?: string;
    delta?: number;
    reason?: string;
  } | null;
  const refresh = legacyAdminClientRefresh("adjust", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  if (!body?.requestId || !UUID_RE.test(body.requestId)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (body.action === "recover") {
    if (!body.targetUserId || !UUID_RE.test(body.targetUserId)) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    const { data, error } = await admin.rpc("get_admin_credit_adjust_receipt", {
      p_admin: gate.user.id,
      p_request_id: body.requestId,
      p_target: body.targetUserId,
    });
    if (error) {
      log.warn("admin.adjust_recover_fail", {
        requestId: body.requestId,
        targetUserId: body.targetUserId,
        adminId: gate.user.id,
        ...errInfo(error),
      });
      return rpcFailure(error);
    }
    if (!data || typeof data !== "object") {
      log.error("admin.adjust_recover_malformed", {
        requestId: body.requestId,
        targetUserId: body.targetUserId,
        adminId: gate.user.id,
      });
      return NextResponse.json(
        { error: "adjustment_unavailable" },
        { status: 503 },
      );
    }
    const payload = data as Record<string, unknown>;
    const result = parseCreditAdjustmentResult(payload.result);
    if (payload.found === true && payload.aborted === false && result) {
      return NextResponse.json({ found: true, aborted: false, result });
    }
    if (payload.found === false && payload.aborted === true) {
      return NextResponse.json({ found: false, aborted: true });
    }
    log.error("admin.adjust_recover_malformed", {
      requestId: body.requestId,
      targetUserId: body.targetUserId,
      adminId: gate.user.id,
    });
    return NextResponse.json(
      { error: "adjustment_unavailable" },
      { status: 503 },
    );
  }

  const reason = body?.reason?.trim() ?? "";
  const reasonLength = Array.from(reason).length;
  if (
    body?.action !== "apply" ||
    !body.targetUserId ||
    !UUID_RE.test(body.targetUserId) ||
    !Number.isInteger(body.delta) ||
    body.delta === undefined ||
    body.delta < -100 ||
    body.delta > 100 ||
    body.delta === 0 ||
    reasonLength < 5 ||
    reasonLength > 500
  ) {
    return NextResponse.json({ error: "invalid_fields" }, { status: 400 });
  }

  const { data, error } = await admin.rpc("admin_adjust_credits", {
    p_admin: gate.user.id,
    p_target: body.targetUserId,
    p_delta: body.delta,
    p_reason: reason,
    p_request_id: body.requestId,
  });
  if (error) {
    log.warn("admin.adjust_fail", {
      targetUserId: body.targetUserId,
      requestId: body.requestId,
      adminId: gate.user.id,
      ...errInfo(error),
    });
    return rpcFailure(error);
  }
  const result = parseCreditAdjustmentResult(data);
  if (!result || result.requested !== body.delta) {
    log.error("admin.adjust_malformed", {
      targetUserId: body.targetUserId,
      requestId: body.requestId,
      adminId: gate.user.id,
    });
    return NextResponse.json(
      { error: "adjustment_unavailable" },
      { status: 503 },
    );
  }
  log.info("admin.adjust_ok", {
    targetUserId: body.targetUserId,
    requestId: body.requestId,
    adminId: gate.user.id,
    delta: body.delta,
    idempotent: result.idempotent,
  });
  return NextResponse.json(result);
}
