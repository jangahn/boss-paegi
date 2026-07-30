import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isGenericAdminMutationReceiptOperation,
  isOperationRequestId,
  parseAdminMutationReceipt,
} from "@/lib/admin-mutation";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * A recovery request shares the database advisory lock with the mutation. If
 * the mutation never committed it creates an aborted tombstone, preventing a
 * delayed POST with that UUID from applying after the client starts over.
 */
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
  const body = requestBody.value as
    | { requestId?: unknown; operation?: unknown; targetKey?: unknown }
    | null;
  if (
    !body ||
    !isOperationRequestId(body.requestId) ||
    !isGenericAdminMutationReceiptOperation(body.operation) ||
    typeof body.targetKey !== "string" ||
    body.targetKey.length < 1 ||
    body.targetKey.length > 200
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_admin_mutation_receipt", {
    p_admin: gate.user.id,
    p_request_id: body.requestId,
    p_operation: body.operation,
    p_target_key: body.targetKey,
  });
  if (error) {
    const code = adminRpcErrorCode(error);
    log.warn("admin.mutation_receipt_fail", {
      operation: body.operation,
      targetKey: body.targetKey,
      code,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: code },
      { status: code === "action_failed" ? 500 : 409 },
    );
  }
  const receipt = parseAdminMutationReceipt(data);
  if (!receipt) {
    log.error("admin.mutation_receipt_invalid", {
      operation: body.operation,
      targetKey: body.targetKey,
    });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  return NextResponse.json(receipt);
}
