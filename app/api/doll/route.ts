import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import {
  DOLLS_BUCKET as BUCKET,
  candidatePrefix,
} from "@/lib/generation";
import { processStorageObjectCleanupJob } from "@/lib/storage-cleanup-jobs";
import { isUuid } from "@/lib/upload-write-safety";
import { log, errInfo } from "@/lib/log";
import { isRoleId } from "@/lib/roles";
import { requireSupabaseRows } from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  cleanupJobToRun,
  parseDollDeleteAck,
  parseDollRoleUpdateAck,
} from "@/lib/storage-mutation-result";
import { parseDollPickHttpResponse } from "@/lib/character-gen/http-contract";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import {
  GENERATION_COST_FROZEN_BODY,
  GENERATION_COST_ROLLOUT_HEADER,
  generationCostPathEnabled,
} from "@/lib/generation-cost-rollout";
import { paymentRolloutIdentityHeaders } from "@/lib/pay/checkout-rollout";
import {
  createDollPickSubmitIntent,
  dollPickSubmitIntentRpcPayload,
  parseDollPickClaim,
  parseDollPickSubmitRecord,
  submitDollPickOnce,
  validDollPickPrepare,
} from "@/lib/character-gen/doll-pick-submit";
import { materializeGenerationPick } from "@/lib/character-gen/doll-pick-materialize";
import { publicFalWebhookOrigin } from "@/lib/character-gen/generation-submit-saga";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { readGenerationProviderAcceptance } from "@/lib/generation-provider-acceptance";

export const runtime = "nodejs";
// 누끼(birefnet ~2s) + fetch/normalize/upload/insert. 30s 면 충분.
// 명시 안 하면 플랫폼 기본값(Hobby 10s)에 묶여 느린 누끼가 잘릴 수 있음.
export const maxDuration = 30;

function dollPickResponse(doll: unknown, generationId: string) {
  const body = parseDollPickHttpResponse(
    { doll, generationId },
    generationId,
  );
  if (!body) {
    log.error("doll.response_invalid", { generationId });
    return NextResponse.json({ error: "save_response_invalid" }, { status: 500 });
  }
  return NextResponse.json(body);
}

function dollPickProcessingResponse() {
  return NextResponse.json(
    {
      status: "processing",
      pollUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
    {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "2",
      },
    },
  );
}

/**
 * 후보 선택(pick) — **서버 권위**. 클라 계약 = {generationId, candidateIndex}.
 *   서버가 소유 generation 을 조회해 status(done/선택가능)·candidateIndex(0~2)·해당 canonical 경로가
 *   candidate_urls 에 실존하는지 검증하고, 검증된 경로를 **내부 서명**해 birefnet 에 넘긴다.
 *   클라 imageUrl/styleMeta/role 은 비권위(과도기 imageUrl 은 index 파싱에만, 경로는 서버 재구성).
 *   멱등(이미 picked 면 기존 doll)·동시성(done→picked 조건부 1승·패자 보상삭제)·pick 후 provenance 갱신.
 */
export async function POST(req: NextRequest) {
  // Only POST can start paid birefnet work. Keep this before auth/body/DB so a
  // rolling old deployment has an externally provable, exact freeze boundary;
  // GET/DELETE remain available while the generation cost ledger is deployed.
  if (!generationCostPathEnabled()) {
    return NextResponse.json(GENERATION_COST_FROZEN_BODY, {
      status: 503,
      headers: {
        [GENERATION_COST_ROLLOUT_HEADER]: "frozen",
        ...paymentRolloutIdentityHeaders(),
      },
    });
  }

  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  const admin = createAdminClient();
  try {
    const acceptance = await readGenerationProviderAcceptance(admin, user.id);
    if (!acceptance.eligible) {
      return NextResponse.json(
        { error: "generation_provider_acceptance_required" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch (error) {
    log.error("doll.provider_acceptance_read_fail", {
      userId: user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    generationId?: string;
    candidateIndex?: number;
    requestId?: string;
  };
  const genId = body.generationId;
  const candidateIndex = body.candidateIndex;
  const requestId = body.requestId;
  if (!isUuid(genId) || !isUuid(requestId)) {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400 },
    );
  }
  if (
    !Number.isInteger(candidateIndex) ||
    (candidateIndex as number) < 0 ||
    (candidateIndex as number) > 2
  ) {
    return NextResponse.json(
      { error: "invalid_candidate_index" },
      { status: 400 },
    );
  }

  const { data: claimData, error: claimError } = await admin.rpc(
    "claim_generation_pick",
    {
      p_user_id: user.id,
      p_generation_id: genId,
      p_candidate_index: candidateIndex,
      p_attempt_id: requestId,
    },
  );
  if (claimError) {
    log.warn("doll.pick_claim_unavailable", {
      userId: user.id,
      genId,
      ...errInfo(claimError),
    });
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }
  const claim = parseDollPickClaim(claimData);
  if (claim.kind === "invalid") {
    log.error("doll.pick_claim_invalid", { userId: user.id, genId });
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }

  const existingDollResponse = async (dollId: string) => {
    const { data: doll, error } = await admin
      .from("dolls")
      .select("*")
      .eq("id", dollId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (error || !doll) {
      log.error("doll.picked_lookup_fail", {
        userId: user.id,
        genId,
        dollId,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: "lookup_failed" },
        { status: 503 },
      );
    }
    return dollPickResponse(doll, genId);
  };

  if (claim.kind === "already_picked") {
    return existingDollResponse(claim.dollId);
  }
  if (claim.kind === "blocked") {
    if (claim.outcome === "manual_review") {
      return NextResponse.json(
        { error: "reconciliation_required" },
        { status: 503 },
      );
    }
    const status =
      claim.outcome === "not_found" ||
      claim.outcome === "candidate_not_found"
        ? 404
        : claim.outcome === "account_deleted"
          ? 403
          : claim.outcome.endsWith("_quota")
            ? 429
            : 409;
    return NextResponse.json(
      { error: claim.outcome },
      { status },
    );
  }
  if (claim.kind === "processing" || claim.kind === "resume") {
    return dollPickProcessingResponse();
  }

  if (claim.kind === "provider_done") {
    try {
      const result = await materializeGenerationPick({
        admin,
        userId: user.id,
        generationId: genId,
        workerId: requestId,
      });
      if (result.kind === "committed") {
        return dollPickResponse(result.doll, genId);
      }
      return dollPickProcessingResponse();
    } catch (error) {
      log.warn("doll.pick_materialization_deferred", {
        userId: user.id,
        genId,
        ...errInfo(error),
      });
      return dollPickProcessingResponse();
    }
  }

  const canonicalPath =
    `${candidatePrefix(user.id, genId)}/${candidateIndex}.jpg`;
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(canonicalPath, 20 * 60);
  if (signError || !signed?.signedUrl) {
    log.warn("doll.pick_candidate_sign_deferred", {
      userId: user.id,
      genId,
      ...errInfo(signError),
    });
    return dollPickProcessingResponse();
  }
  const webhookOrigin = publicFalWebhookOrigin(PUBLIC_ENV.SITE_URL);
  if (!webhookOrigin) {
    log.error("doll.pick_webhook_origin_invalid", { genId });
    return dollPickProcessingResponse();
  }

  let submitIntent;
  try {
    submitIntent = createDollPickSubmitIntent({
      siteOrigin: webhookOrigin,
      generationId: genId,
      attemptId: claim.attemptId,
      imageUrl: signed.signedUrl,
      credentials: SERVER_ENV.FAL_KEY,
    });
  } catch (error) {
    log.error("doll.pick_submit_intent_invalid", {
      genId,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }

  const { data: prepareData, error: prepareError } = await admin.rpc(
    "prepare_generation_pick_submit",
    {
      p_user_id: user.id,
      p_generation_id: genId,
      p_attempt_id: claim.attemptId,
      ...dollPickSubmitIntentRpcPayload(submitIntent),
    },
  );
  if (prepareError) {
    log.warn("doll.pick_prepare_unavailable", {
      userId: user.id,
      genId,
      ...errInfo(prepareError),
    });
    return dollPickProcessingResponse();
  }
  if (!validDollPickPrepare(prepareData)) {
    const row =
      prepareData &&
      typeof prepareData === "object" &&
      !Array.isArray(prepareData)
        ? (prepareData as Record<string, unknown>)
        : null;
    const quota =
      row?.outcome === "user_day_quota" ||
      row?.outcome === "global_day_quota";
    return NextResponse.json(
      { error: quota ? "generation_quota_exceeded" : "service_unavailable" },
      { status: quota ? 429 : 503 },
    );
  }

  const outcome = await submitDollPickOnce({
    intent: submitIntent,
    credentials: SERVER_ENV.FAL_KEY,
  });
  const durableOutcome =
    outcome.kind === "acknowledged"
      ? "acknowledged"
      : outcome.kind === "uncertain"
        ? "uncertain"
        : "rejected";
  const { data: recordData, error: recordError } = await admin.rpc(
    "record_generation_pick_submit_outcome",
    {
      p_generation_id: genId,
      p_attempt_id: claim.attemptId,
      p_payload_hash: submitIntent.payloadHash,
      p_callback_token_hash: submitIntent.callbackTokenHash,
      p_outcome: durableOutcome,
      p_request_id:
        outcome.kind === "acknowledged" ? outcome.requestId : null,
      p_http_status: outcome.httpStatus,
      p_webhook_status: null,
    },
  );
  const recorded = recordError
    ? "blocked"
    : parseDollPickSubmitRecord(recordData);
  if (recorded === "blocked") {
    log.error("doll.pick_submit_record_unconfirmed", {
      userId: user.id,
      genId,
      ...errInfo(recordError),
    });
  }
  if (recorded === "rejected") {
    return NextResponse.json(
      { error: "provider_rejected" },
      { status: 502 },
    );
  }
  return dollPickProcessingResponse();
}

export async function GET() {
  // 회원 전용 + 동의 완료 게이트(lazy 모델: 미동의 로그인 차단). 익명/무세션/미동의 → 401/403.
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const supabase = await createClient();

  try {
    const data = await requireSupabaseRows(
      "doll.list",
      () =>
        supabase
          .from("dolls")
          .select("id, image_url, created_at, role")
          .order("created_at", { ascending: false })
          .limit(50),
    );
    const dolls = validateAdminRows("doll.list", data, {
      id: "uuid",
      image_url: "string",
      created_at: "timestamp",
      role: "string",
    });
    if (
      dolls.some(
        (doll) =>
          !isRoleId((doll as { role?: unknown }).role),
      )
    ) {
      throw new Error("invalid_doll_role");
    }
    return NextResponse.json({ dolls });
  } catch (error) {
    log.error("doll.list_fail", {
      userId: gate.user.id,
      ...errInfo(error),
    });
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  // 회원 전용 + 동의 완료 게이트(lazy 모델: 미동의 로그인 차단). 익명/무세션/미동의 → 401/403.
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: id ? "invalid_id" : "id_required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("request_doll_delete", {
    p_user_id: user.id,
    p_doll_id: id,
  });
  if (error) {
    const message = error.message ?? "";
    const code = message.includes("doll_not_found")
      ? "not_found"
      : message.includes("forbidden")
        ? "forbidden"
        : message.includes("account_deleted")
          ? "account_deleted"
          : message.includes("doll_unavailable")
            ? "not_found"
            : "delete_failed";
    log.warn("doll.delete_request_fail", {
      userId: user.id,
      dollId: id,
      code,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "not_found"
            ? 404
            : code === "forbidden" || code === "account_deleted"
              ? 403
              : 500,
      },
    );
  }

  const started = parseDollDeleteAck(data);
  if (!started) {
    log.error("doll.delete_request_invalid", { userId: user.id, dollId: id });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  const { data: remaining, error: verifyError } = await admin
    .from("dolls")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (verifyError || remaining !== null) {
    log.error("doll.delete_postcondition_fail", {
      userId: user.id,
      dollId: id,
      ...errInfo(verifyError ?? new Error("doll_row_still_present")),
    });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  const cleanupJobId = cleanupJobToRun(started);
  if (cleanupJobId) {
    try {
      const outcome = await processStorageObjectCleanupJob(
        admin,
        cleanupJobId,
      );
      if (outcome.kind !== "completed") {
        log.warn("doll.delete_cleanup_pending", {
          userId: user.id,
          dollId: id,
          jobId: cleanupJobId,
          outcome,
        });
        return NextResponse.json(
          { accepted: true, cleanup: "pending" },
          { status: 202 },
        );
      }
    } catch (cleanupError) {
      log.warn("doll.delete_cleanup_claim_fail", {
        userId: user.id,
        dollId: id,
        jobId: cleanupJobId,
        ...errInfo(cleanupError),
      });
      return NextResponse.json(
        { accepted: true, cleanup: "pending" },
        { status: 202 },
      );
    }
  }

  log.info("doll.delete", {
    userId: user.id,
    dollId: id,
    alreadyDeleted: started.alreadyDeleted,
  });
  return NextResponse.json({ ok: true, cleanup: "completed" });
}

/** 캐릭터 롤 변경 (갤러리 점세개 메뉴). 쓰기 API라 unknown role 은 400(렌더의 boss 폴백과 달리 엄격). */
export async function PATCH(req: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    id?: string;
    role?: string;
  };
  if (!isUuid(body?.id)) {
    return NextResponse.json(
      { error: body?.id ? "invalid_id" : "id_required" },
      { status: 400 },
    );
  }
  if (!isRoleId(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: updateAck, error: updErr } = await admin.rpc(
    "request_doll_role_update",
    {
    p_user_id: user.id,
    p_doll_id: body.id,
    p_role: body.role,
    },
  );
  if (updErr) {
    const message = updErr.message ?? "";
    const code = message.includes("doll_not_found")
      ? "not_found"
      : message.includes("doll_unavailable")
        ? "not_found"
        : message.includes("forbidden")
          ? "forbidden"
          : message.includes("account_deleted")
            ? "account_deleted"
            : "update_failed";
    log.error("doll.role_update_fail", {
      userId: user.id,
      dollId: body.id,
      role: body.role,
      ...errInfo(updErr),
    });
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "not_found"
            ? 404
            : code === "forbidden" || code === "account_deleted"
              ? 403
              : 500,
      },
    );
  }

  if (!parseDollRoleUpdateAck(updateAck, body.role)) {
    log.error("doll.role_update_invalid", {
      userId: user.id,
      dollId: body.id,
      role: body.role,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  const { data: updated, error: verifyError } = await admin
    .from("dolls")
    .select("id, owner_id, role, deleted_at")
    .eq("id", body.id)
    .maybeSingle();
  if (
    verifyError ||
    !updated ||
    updated.id !== body.id ||
    updated.owner_id !== user.id ||
    updated.role !== body.role ||
    updated.deleted_at !== null
  ) {
    log.error("doll.role_update_postcondition_fail", {
      userId: user.id,
      dollId: body.id,
      role: body.role,
      ...errInfo(verifyError ?? new Error("doll_role_postcondition_failed")),
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  log.info("doll.role_change", { userId: user.id, dollId: body.id, role: body.role });
  return NextResponse.json({ ok: true, role: body.role });
}
