import "server-only";
import * as Sentry from "@sentry/nextjs";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import {
  uploadFaceTmp,
  deleteFaceTmp,
  tmpFacePath,
} from "@/lib/character-gen/upload-face";
import { getGenerationConfigWithMetaStrict } from "@/lib/config/getters";
import { buildGenerationPlan, FIXED_FLUX } from "@/lib/character-gen/plan";
import { failGeneration } from "@/lib/generation-recovery";
import { PROVENANCE_SCHEMA_VERSION } from "@/lib/character-gen/provenance";
import {
  createGenerationSubmitIntents,
  deriveGenerationCallbackToken,
  generationSubmitIntentRpcPayload,
  isPreparedSubmitSagaResult,
  parseGenerationSubmitPreparation,
  parseGenerationSubmitWork,
  parseSubmitRecordResult,
  publicFalWebhookOrigin,
} from "@/lib/character-gen/generation-submit-saga";
import { checkFalBalance } from "@/lib/fal-balance";
import { SERVER_ENV } from "@/lib/env.server";
import { PUBLIC_ENV } from "@/lib/env";
import { isRoleId } from "@/lib/roles";
import { log, errInfo } from "@/lib/log";
import { parseGenerationSubmitHttpResponse } from "@/lib/character-gen/http-contract";
import {
  GENERATION_IMAGE_MAX_BYTES,
  generationContentLengthAllowed,
  readGenerationFormData,
} from "@/lib/character-gen/request-boundary";
import {
  parseGenerationPreflightClaim,
  parseGenerationPreflightCommit,
  parseGenerationContinuationClaim,
  sha256Hex,
  validGenerationContinuationComplete,
} from "@/lib/character-gen/generation-cost-control";
import { isUuid } from "@/lib/upload-write-safety";
import {
  FACE_CHECK_KEYS,
  buildFaceAnalysis,
} from "@/lib/character-gen/face-analysis";
import {
  createFaceCheckSubmitIntents,
  faceCheckIntentRpcPayload,
  parseFaceCheckWorkClaim,
  parseReadyFaceCheckOutputs,
  submitFaceCheckOnce,
} from "@/lib/character-gen/face-check-submit";
import {
  buildFalCallbackUrl,
  hashFalCallbackToken,
} from "@/lib/character-gen/fal-submit-once";

export const runtime = "nodejs";
// 비동기 제출 — fal 에 등록만 하고 즉시 반환(업로드+검출+제출 ~6s)이라 짧게 충분.
export const maxDuration = 30;

function generationSubmitResponse(generationId: string, status = 200) {
  const body = parseGenerationSubmitHttpResponse({
    generationId,
    status: "generating",
  });
  if (!body) {
    log.error("gen.response_invalid", { generationId });
    return NextResponse.json(
      { error: "generation_response_invalid" },
      { status: 500 },
    );
  }
  return NextResponse.json(body, { status });
}

function generationPreflightProcessingResponse() {
  return NextResponse.json(
    {
      error: "generation_preflight_processing",
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

export async function POST(req: NextRequest) {
  // Reject a declared oversize before any dependency work, but do not consume
  // a chunked body until the caller passes auth.
  if (
    !generationContentLengthAllowed(req.headers.get("content-length"))
  ) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }

  // 회원 전용 게이트 (비회원/무세션/멤버화 미완 → 401/403)
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  // Base 14+/terms/privacy are enforced by requireMember. The provider
  // acceptance ledger (008905) stays recordable but is not an enforcement
  // gate: the product owner restored the pre-freeze generation flow on
  // 2026-07-31, where the in-page photo consent dialog is the only prompt.
  const admin = createAdminClient();

  // multipart/form-data() otherwise buffers the complete body. Read the raw
  // stream with an exact cap before config/provider calls; this second check
  // also covers missing or dishonest Content-Length.
  const formRead = await readGenerationFormData(req);
  if (!formRead.ok) {
    return NextResponse.json(
      { error: formRead.error },
      { status: formRead.error === "body_too_large" ? 413 : 400 },
    );
  }
  const form = formRead.form;

  log.info("gen.request", { userId: user.id });

  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "image_required" }, { status: 400 });
  }
  if (file.size > GENERATION_IMAGE_MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", maxMB: 10 },
      { status: 400 }
    );
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "not_an_image" }, { status: 400 });
  }

  // 생성 시 선택한 롤 — 복장·표정 프롬프트 + doll.role 에 반영. 미전송이면 boss, 미지값은 400.
  const roleRaw = form.get("role")?.toString() ?? "boss";
  if (!isRoleId(roleRaw)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const role = roleRaw;
  const requestId = form.get("requestId")?.toString();
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: "requestId_required" }, { status: 400 });
  }

  const provider = selectProvider(null);

  // 입력 정규화 (768×1024 3:4 cover) — 원본은 메모리 안에서만
  const rawBuf = await file.arrayBuffer();
  let prepared: Buffer;
  try {
    prepared = await Sentry.startSpan(
      { name: "gen.prepare_input", op: "image.process", attributes: { userId: user.id } },
      () => prepareInputImage(rawBuf)
    );
  } catch (e) {
    log.error("gen.input_prep_fail", {
      userId: user.id,
      fileSize: file.size,
      fileType: file.type,
      ...errInfo(e),
    });
    return NextResponse.json({ error: "input_prep_failed" }, { status: 400 });
  }

  const cleanupPreflightFace = async (): Promise<boolean> => {
    try {
      await deleteFaceTmp(tmpFacePath(user.id, requestId));
      return true;
    } catch (error) {
      log.warn("gen.preflight_face_cleanup_unavailable", {
        userId: user.id,
        requestId,
        ...errInfo(error),
      });
      return false;
    }
  };
  const startedAt = Date.now();
  // Operation identity is bound to the original bytes, not a normalizer
  // implementation that may change between deployments.
  const imageDigest = sha256Hex(new Uint8Array(rawBuf));
  const analysisWorkerId = randomUUID();

  const { data: preflightData, error: preflightError } = await admin.rpc(
    "claim_generation_preflight",
    {
      p_user_id: user.id,
      p_request_id: requestId,
      p_role: role,
      p_image_digest: imageDigest,
      p_requires_credit: true,
      p_worker_id: analysisWorkerId,
    },
  );
  if (preflightError) {
    const conflict = preflightError.message.includes(
      "preflight_idempotency_conflict",
    );
    log.warn("gen.preflight_claim_fail", {
      userId: user.id,
      requestId,
      conflict,
      ...errInfo(preflightError),
    });
    return NextResponse.json(
      { error: conflict ? "request_conflict" : "service_unavailable" },
      { status: conflict ? 409 : 503 },
    );
  }
  const preflight = parseGenerationPreflightClaim(preflightData);
  if (preflight.kind === "invalid") {
    log.error("gen.preflight_claim_invalid", { userId: user.id, requestId });
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }
  if (preflight.kind === "processing") {
    return generationPreflightProcessingResponse();
  }
  if (preflight.kind === "rejected") {
    if (!(await cleanupPreflightFace())) {
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: preflight.reason }, { status: 400 });
  }
  if (preflight.kind === "blocked") {
    if (!(await cleanupPreflightFace())) {
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    const status =
      preflight.outcome === "no_credits"
        ? 402
        : preflight.outcome.endsWith("_quota")
          ? 429
          : preflight.outcome === "failed"
            ? 503
            : 409;
    return NextResponse.json(
      {
        error:
          preflight.outcome === "no_credits"
            ? "no_credits"
            : preflight.outcome.endsWith("_quota")
              ? "generation_quota_exceeded"
              : "generation_preflight_terminal",
      },
      { status },
    );
  }

  if (preflight.kind === "claimed") {
    const falWebhookOrigin = publicFalWebhookOrigin(PUBLIC_ENV.SITE_URL);
    if (!falWebhookOrigin) {
      log.error("gen.webhook_origin_invalid");
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    let cfg: Awaited<ReturnType<typeof getGenerationConfigWithMetaStrict>>;
    try {
      cfg = await getGenerationConfigWithMetaStrict();
    } catch (error) {
      log.error("gen.config_read_fail", {
        userId: user.id,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    const balance = await checkFalBalance();
    if (!balance.ok) {
      log.warn("gen.balance_blocked", {
        userId: user.id,
        balance: balance.balance,
        reason: balance.reason,
      });
      return NextResponse.json({ error: "service_paused" }, { status: 503 });
    }

    let uploaded;
    try {
      uploaded = await uploadFaceTmp(user.id, requestId, prepared);
    } catch (error) {
      log.warn("gen.preflight_face_upload_fail", {
        userId: user.id,
        requestId,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    const intents = createFaceCheckSubmitIntents({
      siteOrigin: falWebhookOrigin,
      reservationId: requestId,
      imageUrl: uploaded.url,
      credentials: SERVER_ENV.FAL_KEY,
    });
    const { data: preparedChecks, error: prepareChecksError } =
      await admin.rpc("prepare_generation_face_checks", {
        p_user_id: user.id,
        p_request_id: requestId,
        p_worker_id: analysisWorkerId,
        p_generation_config: cfg.value,
        p_config_source: cfg.source,
        p_config_version: cfg.version,
        p_config_invalid: !!cfg.invalid,
        p_intents: faceCheckIntentRpcPayload(intents),
      });
    if (prepareChecksError) {
      log.warn("gen.face_checks_prepare_fail", {
        userId: user.id,
        requestId,
        ...errInfo(prepareChecksError),
      });
      return generationPreflightProcessingResponse();
    }
    const ready = parseReadyFaceCheckOutputs(preparedChecks);
    if (ready) {
      let finalized = false;
      try {
        const analysis = buildFaceAnalysis(ready);
        const failureReason = !analysis.faceVisible
          ? "no_face"
          : !analysis.singlePerson
            ? "multiple_people"
            : !analysis.faceClear
              ? "face_obstructed"
              : null;
        const { data: finalizeData, error: finalizeError } = await admin.rpc(
          "finalize_generation_face_checks",
          {
            p_request_id: requestId,
            p_analysis: analysis,
            p_failure_reason: failureReason,
          },
        );
        const result =
          finalizeData &&
          typeof finalizeData === "object" &&
          !Array.isArray(finalizeData)
            ? (finalizeData as Record<string, unknown>)
            : null;
        finalized =
          !finalizeError &&
          result?.ok === true &&
          (failureReason === null
            ? result.outcome === "accepted"
            : result.outcome === "rejected");
      } catch (error) {
        const { data: finalizeData, error: finalizeError } = await admin.rpc(
          "finalize_generation_face_checks",
          {
            p_request_id: requestId,
            p_analysis: null,
            p_failure_reason:
              error instanceof Error &&
              /^[a-z0-9_]{1,100}$/.test(error.message)
                ? error.message
                : "face_analysis_invalid",
          },
        );
        const result =
          finalizeData &&
          typeof finalizeData === "object" &&
          !Array.isArray(finalizeData)
            ? (finalizeData as Record<string, unknown>)
            : null;
        finalized =
          !finalizeError &&
          result?.ok === true &&
          (result.outcome === "rejected" || result.outcome === "failed");
      }
      if (!finalized || !(await cleanupPreflightFace())) {
        log.warn("gen.face_checks_finalize_or_cleanup_deferred", {
          userId: user.id,
          requestId,
          finalized,
        });
        return NextResponse.json(
          { error: "service_unavailable" },
          { status: 503 },
        );
      }
      return generationPreflightProcessingResponse();
    }

    const claimedChecks: Extract<
      ReturnType<typeof parseFaceCheckWorkClaim>,
      { kind: "claimed" }
    >[] = [];
    for (const checkKey of FACE_CHECK_KEYS) {
      const { data: workData, error: workError } = await admin.rpc(
        "claim_generation_face_check",
        {
          p_user_id: user.id,
          p_request_id: requestId,
          p_worker_id: analysisWorkerId,
          p_check_key: checkKey,
        },
      );
      if (workError) {
        log.warn("gen.face_check_claim_fail", {
          check: checkKey,
          requestId,
          ...errInfo(workError),
        });
        continue;
      }
      const work = parseFaceCheckWorkClaim(workData);
      if (work.kind !== "claimed") {
        continue;
      }
      claimedChecks.push(work);
    }
    const submittedChecks = await Promise.all(
      claimedChecks.map(async (work) => ({
        work,
        outcome: await submitFaceCheckOnce({
          siteOrigin: falWebhookOrigin,
          reservationId: requestId,
          claim: work,
          credentials: SERVER_ENV.FAL_KEY,
        }),
      })),
    );
    const recordedChecks = await Promise.all(
      submittedChecks.map(async ({ work, outcome }) => {
        const durableOutcome =
          outcome.kind === "acknowledged"
            ? "acknowledged"
            : outcome.kind === "uncertain"
              ? "uncertain"
              : "rejected";
        const { data: recordData, error: recordError } = await admin.rpc(
          "record_generation_face_check_submit",
          {
            p_request_id: requestId,
            p_check_key: work.checkKey,
            p_payload_hash: work.payloadHash,
            p_callback_token_hash: work.callbackTokenHash,
            p_outcome: durableOutcome,
            p_external_request_id:
              outcome.kind === "acknowledged" ? outcome.requestId : null,
            p_http_status: outcome.httpStatus,
          },
        );
        const record =
          recordData &&
          typeof recordData === "object" &&
          !Array.isArray(recordData)
            ? (recordData as Record<string, unknown>)
            : null;
        if (recordError || record?.ok !== true) {
          log.warn("gen.face_check_record_fail", {
            check: work.checkKey,
            requestId,
            ...errInfo(recordError),
          });
          return false;
        }
        return record.outcome === "rejected";
      }),
    );
    if (recordedChecks.some(Boolean) && !(await cleanupPreflightFace())) {
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    return generationPreflightProcessingResponse();
  }

  const tmpFaceId = requestId;
  const continuationWorkerId = randomUUID();
  let analysis =
    preflight.kind === "accepted" ? preflight.analysis : null;
  let cfg =
    preflight.kind === "accepted" ? preflight.config : null;
  let plan =
    preflight.kind === "accepted"
      ? buildGenerationPlan(preflight.config.value, {
          role,
          wearsGlasses: preflight.analysis.wearsGlasses,
          numImages: 3,
          seed: requestId,
        })
      : null;
  let genId: string | null =
    preflight.kind === "committed" ? preflight.generationId : null;

  if (preflight.kind === "committed") {
    const { data, error } = await admin.rpc(
      "claim_generation_preflight_continuation",
      {
        p_user_id: user.id,
        p_request_id: requestId,
        p_worker_id: continuationWorkerId,
      },
    );
    if (error) {
      log.warn("gen.continuation_claim_fail", {
        userId: user.id,
        requestId,
        ...errInfo(error),
      });
      return generationSubmitResponse(preflight.generationId, 202);
    }
    const continuation = parseGenerationContinuationClaim(data);
    if (continuation.kind === "submitted") {
      return generationSubmitResponse(continuation.generationId, 202);
    }
    if (continuation.kind === "processing") {
      return generationSubmitResponse(continuation.generationId, 202);
    }
    if (continuation.kind === "invalid") {
      log.error("gen.continuation_claim_invalid", {
        userId: user.id,
        requestId,
      });
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
    genId = continuation.generationId;
    analysis = continuation.analysis;
    cfg = continuation.config;
    plan = continuation.plan;
  } else {
    const { data: commitData, error: commitError } = await admin.rpc(
      "commit_generation_preflight",
      {
        p_user_id: user.id,
        p_request_id: requestId,
        p_role: role,
        p_image_digest: imageDigest,
        p_worker_id: continuationWorkerId,
        p_generation_plan: plan,
      },
    );
    if (commitError) {
      const noCredits = commitError.message.includes("insufficient_credits");
      log.warn("gen.preflight_commit_fail", {
        userId: user.id,
        requestId,
        noCredits,
        ...errInfo(commitError),
      });
      if (noCredits) {
        return NextResponse.json(
          { error: "no_credits" },
          { status: 402 },
        );
      }
      return generationPreflightProcessingResponse();
    }
    const committed = parseGenerationPreflightCommit(commitData);
    if (!committed.ok) {
      log.error("gen.preflight_commit_invalid", {
        userId: user.id,
        requestId,
      });
      return generationPreflightProcessingResponse();
    }
    genId = committed.generationId;
    analysis = committed.analysis;
    cfg = committed.config;
    plan = committed.plan;
    log.info("gen.credit_receipt_committed", {
      userId: user.id,
      genId,
      remaining: committed.remaining,
    });
  }

  if (!genId || !analysis || !cfg || !plan) {
    return generationPreflightProcessingResponse();
  }

  let facePath: string | null = null;
  // 임시 얼굴 정리(베스트에포트) — 실패는 원본이 남는 정책 #1 리스크라 반드시 가시화.
  const cleanupFace = (path: string): Promise<void> =>
    deleteFaceTmp(path).catch((err) =>
      log.warn("gen.face_cleanup_fail", { genId, tmpFaceId, userId: user.id, ...errInfo(err) })
    );

  try {
    const uploadedFinal = await Sentry.startSpan(
      { name: "gen.face_upload", op: "storage.upload", attributes: { tmpFaceId, userId: user.id } },
      () => uploadFaceTmp(user.id, genId, prepared)
    );
    facePath = uploadedFinal.path;
    await cleanupFace(tmpFacePath(user.id, requestId));

    const falWebhookOrigin = publicFalWebhookOrigin(PUBLIC_ENV.SITE_URL);
    if (!falWebhookOrigin) {
      return generationSubmitResponse(genId, 202);
    }
    const { data: preparationData, error: preparationError } =
      await admin.rpc("get_generation_submit_preparation", {
        p_gen_id: genId,
        p_owner_id: user.id,
      });
    if (preparationError) {
      return generationSubmitResponse(genId, 202);
    }
    const preparation = parseGenerationSubmitPreparation(preparationData);
    if (preparation.kind === "invalid") {
      log.error("gen.submit_preparation_invalid", { genId });
      return generationSubmitResponse(genId, 202);
    }

    let submitIntents:
      {
        index: number;
        input: Readonly<Record<string, unknown>>;
        payloadHash: string;
        callbackTokenHash: string;
        callbackToken: string;
        webhookUrl: string;
      }[];
    const freshSubmitIntents = createGenerationSubmitIntents({
      generationId: genId,
      siteOrigin: falWebhookOrigin,
      faceImageUrl: uploadedFinal.url,
      plan,
      credentials: SERVER_ENV.FAL_KEY,
    });
    const freshIntentByIndex = new Map(
      freshSubmitIntents.map((intent) => [intent.index, intent]),
    );
    let plannedRebindIntents: typeof freshSubmitIntents = [];
    if (preparation.kind === "missing") {
      submitIntents = freshSubmitIntents;
    } else {
      submitIntents = preparation.intents.map((intent) => {
        if (intent.state === "planned") {
          const fresh = freshIntentByIndex.get(intent.index);
          if (!fresh) {
            throw new Error("generation_fresh_submit_intent_missing");
          }
          return fresh;
        }
        const callbackToken = deriveGenerationCallbackToken({
          credentials: SERVER_ENV.FAL_KEY,
          generationId: genId,
          candidateIndex: intent.index,
          payloadHash: intent.payloadHash,
        });
        if (
          hashFalCallbackToken(callbackToken) !== intent.callbackTokenHash
        ) {
          throw new Error("generation_callback_secret_rotated");
        }
        return {
          ...intent,
          callbackToken,
          webhookUrl: buildFalCallbackUrl({
            siteUrl: falWebhookOrigin,
            generationId: genId,
            candidateIndex: intent.index,
            token: callbackToken,
            payloadHash: intent.payloadHash,
          }),
        };
      });
      const plannedIndexes = new Set(
        preparation.intents
          .filter((intent) => intent.state === "planned")
          .map((intent) => intent.index),
      );
      plannedRebindIntents = freshSubmitIntents.filter((intent) =>
        plannedIndexes.has(intent.index),
      );
    }
    const submitIntentByIndex = new Map(
      submitIntents.map((intent) => [intent.index, intent]),
    );

    // provenance 초기 스냅샷(submitted) — 제출 **전** 저장(부분실패 시 계획 유실 방지).
    const provenance = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      config: {
        key: "generation_config" as const,
        source: cfg.source,
        version: cfg.version,
        invalid: !!cfg.invalid,
      },
      analyze: {
        model: analysis.model,
        status: analysis.status,
        faceVisible: analysis.faceVisible,
        singlePerson: analysis.singlePerson,
        peopleCount: analysis.peopleCount,
        faceClear: analysis.faceClear,
        wearsGlasses: analysis.wearsGlasses,
        checks: analysis.checks,
      },
      generation: {
        provider: FIXED_FLUX.provider,
        model: FIXED_FLUX.model,
        role,
        request: plan.request,
        snapshot: plan.snapshot,
        candidates: plan.candidates.map((c) => ({
          index: c.index,
          suitColor: c.suitColor,
          positivePrompt: c.positivePrompt,
          requestId: null as string | null,
          seed: null as number | null,
          status: "submitted" as "submitted" | "completed" | "failed",
          submitState: "planned" as
            | "planned"
            | "submitting"
            | "uncertain"
            | "acknowledged"
            | "rejected",
          payloadHash:
            submitIntentByIndex.get(c.index)?.payloadHash ?? "",
        })),
      },
      postprocess: null,
      picked: null,
    };

    if (preparation.kind === "missing") {
      const { error: preErr } = await admin
        .from("ai_generations")
        .update({ gen_params: provenance })
        .eq("id", genId);
      if (preErr) {
        log.error("gen.provenance_presave_fail", {
          genId,
          ...errInfo(preErr),
        });
        return generationSubmitResponse(genId, 202);
      }
      const { data: prepareData, error: prepareError } = await admin.rpc(
        "prepare_generation_submit_inputs",
        {
          p_gen_id: genId,
          p_owner_id: user.id,
          p_intents: generationSubmitIntentRpcPayload(submitIntents),
        },
      );
      if (prepareError || !isPreparedSubmitSagaResult(prepareData)) {
        log.error("gen.submit_intent_prepare_fail", {
          genId,
          ...(prepareError
            ? errInfo(prepareError)
            : { detail: "invalid_result" }),
        });
        return generationSubmitResponse(genId, 202);
      }
    } else if (plannedRebindIntents.length > 0) {
      const { data: rebindData, error: rebindError } = await admin.rpc(
        "rebind_generation_submit_inputs",
        {
          p_gen_id: genId,
          p_owner_id: user.id,
          p_intents:
            generationSubmitIntentRpcPayload(plannedRebindIntents),
        },
      );
      if (rebindError || !isPreparedSubmitSagaResult(rebindData)) {
        log.error("gen.submit_intent_rebind_fail", {
          genId,
          ...(rebindError
            ? errInfo(rebindError)
            : { detail: "invalid_result" }),
        });
        return generationSubmitResponse(genId, 202);
      }
    }

    // 후보별 DB claim 성공이 단 한 번의 HTTP 전송 허가증이다. claim 응답 유실은
    // 제출하지 않는 쪽으로 닫혀 비용 중복을 만들지 않는다.
    const claimedCandidates: {
      index: number;
      webhookUrl: string;
      input: Readonly<Record<string, unknown>>;
    }[] = [];
    const recoveredResults: {
      index: number;
      requestId: string;
      status: "submitted";
      httpStatus: null;
    }[] = [];
    let settledBeforeSubmit = 0;
    let definitivelyRejected = 0;
    let claimReadFailed = false;
    let manualReviewRequired = false;
    for (const intent of submitIntents) {
      const { data: claimData, error: claimError } = await admin.rpc(
        "claim_generation_submit_work",
        {
          p_gen_id: genId,
          p_owner_id: user.id,
          p_candidate_index: intent.index,
        },
      );
      if (claimError) {
        log.warn("gen.submit_intent_claim_fail", {
          genId,
          index: intent.index,
          ...errInfo(claimError),
        });
        claimReadFailed = true;
        continue;
      }
      const claim = parseGenerationSubmitWork(claimData);
      if (claim.kind === "claimed") {
        if (
          claim.payloadHash !== intent.payloadHash ||
          claim.callbackTokenHash !== intent.callbackTokenHash
        ) {
          claimReadFailed = true;
          continue;
        }
        claimedCandidates.push({
          index: intent.index,
          webhookUrl: intent.webhookUrl,
          input: claim.input,
        });
      } else if (claim.kind === "acknowledged") {
        settledBeforeSubmit += 1;
        recoveredResults.push({
          index: intent.index,
          requestId: claim.requestId,
          status: "submitted",
          httpStatus: null,
        });
      } else if (claim.kind === "in_flight") {
        settledBeforeSubmit += 1;
      } else if (claim.kind === "rejected") {
        settledBeforeSubmit += 1;
        definitivelyRejected += 1;
      } else if (claim.kind === "manual_review") {
        manualReviewRequired = true;
      } else {
        claimReadFailed = true;
        log.warn("gen.submit_intent_claim_blocked", {
          genId,
          index: intent.index,
          outcome: claim.kind,
        });
      }
    }
    if (manualReviewRequired) {
      log.error("gen.submit_manual_review_required", { genId });
      return NextResponse.json(
        { error: "reconciliation_required" },
        { status: 503 },
      );
    }

    // SDK 자동 POST 재시도를 우회한 raw single-attempt 제출. response loss/5xx/
    // malformed 2xx는 uncertain이며 절대 이 요청 안에서 재제출·환불하지 않는다.
    const freshResults = await Sentry.startSpan(
      {
        name: "gen.fal_submit",
        op: "fal.queue.submit_once",
        attributes: {
          genId,
          userId: user.id,
          numImages: claimedCandidates.length,
          wearsGlasses: analysis.wearsGlasses,
        },
      },
      () =>
        provider.submitPlan({
          faceImageUrl: uploadedFinal.url,
          plan,
          submitCandidates: claimedCandidates,
        }),
    );
    const submitResults = [...recoveredResults, ...freshResults];
    const durableOutcomes = new Map<number, ReturnType<typeof parseSubmitRecordResult>>();
    let freshlySettled = 0;
    for (const result of freshResults) {
      const intent = submitIntentByIndex.get(result.index);
      if (!intent) continue;
      const outcome =
        result.status === "submitted"
          ? "acknowledged"
          : result.status === "uncertain"
            ? "uncertain"
            : "rejected";
      const { data: recordData, error: recordError } = await admin.rpc(
        "record_generation_submit_outcome",
        {
          p_gen_id: genId,
          p_candidate_index: result.index,
          p_payload_hash: intent.payloadHash,
          p_callback_token_hash: intent.callbackTokenHash,
          p_outcome: outcome,
          p_request_id: result.requestId,
          p_http_status: result.httpStatus,
          p_webhook_status: null,
        },
      );
      if (recordError) {
        log.warn("gen.submit_outcome_record_fail", {
          genId,
          index: result.index,
          outcome,
          ...errInfo(recordError),
        });
        continue;
      }
      const durable = parseSubmitRecordResult(recordData);
      durableOutcomes.set(result.index, durable);
      if (
        durable === "acknowledged" ||
        durable === "already_acknowledged" ||
        durable === "uncertain" ||
        durable === "rejected" ||
        durable === "request_id_conflict" ||
        durable === "late_acknowledged"
      ) {
        freshlySettled += 1;
      }
      if (durable === "rejected") {
        definitivelyRejected += 1;
      }
      if (
        durable === "blocked" ||
        durable === "request_id_conflict" ||
        durable === "late_acknowledged"
      ) {
        log.error("gen.submit_outcome_conflict", {
          genId,
          index: result.index,
          outcome,
          durable,
        });
      }
    }

    const allThreeDurablySettled =
      !claimReadFailed &&
      settledBeforeSubmit + freshlySettled === 3;
    if (allThreeDurablySettled && definitivelyRejected === 3) {
      log.error("gen.submit_all_rejected", { genId, userId: user.id });
      await failGeneration(admin, genId, user.id, "submit_rejected");
      await cleanupFace(facePath);
      return NextResponse.json({ error: "generation_failed" }, { status: 502 });
    }
    if (!allThreeDurablySettled) {
      return generationSubmitResponse(genId, 202);
    }
    const { data: completeData, error: completeError } = await admin.rpc(
      "complete_generation_preflight_continuation",
      {
        p_user_id: user.id,
        p_request_id: requestId,
        p_worker_id: continuationWorkerId,
      },
    );
    if (
      completeError ||
      !validGenerationContinuationComplete(completeData)
    ) {
      log.warn("gen.continuation_complete_fail", {
        genId,
        ...errInfo(completeError),
      });
      return generationSubmitResponse(genId, 202);
    }

    log.info("gen.submitted", {
      genId,
      userId: user.id,
      provider: provider.name,
      acknowledgedCount: submitResults.filter(
        (result) => result.status === "submitted",
      ).length,
      uncertainCount: submitResults.filter(
        (result) => result.status === "uncertain",
      ).length,
      wearsGlasses: analysis.wearsGlasses,
      elapsedMs: Date.now() - startedAt,
    });

    // 즉시 반환 — 생성중. 클라는 generationId 로 /api/generations 폴링.
    return generationSubmitResponse(genId);
  } catch (e) {
    // Once committed, only the DB aggregate proving all three provider
    // rejections may refund. Any local exception or unknown claim result is a
    // recovery state, never evidence that no paid request exists.
    log.error("gen.submit_fail", { genId, tmpFaceId, userId: user.id, ...errInfo(e) });
    return genId
      ? generationSubmitResponse(genId, 202)
      : NextResponse.json({ error: "generation_failed" }, { status: 500 });
  }
}
