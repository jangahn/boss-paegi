import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  randomUUID,
} from "node:crypto";
import {
  NextRequest,
  NextResponse,
} from "next/server";
import {
  createAdminClient,
} from "@/lib/supabase/admin";
import {
  requireMember,
  memberGateResponse,
} from "@/lib/auth-server";
import {
  prepareInputImage,
} from "@/lib/image-utils";
import {
  selectProvider,
} from "@/lib/character-gen";
import {
  uploadFaceTmp,
  deleteFaceTmp,
  tmpFacePath,
} from "@/lib/character-gen/upload-face";
import {
  runGenerationContinuation,
  type GenerationContinuationResult,
} from "@/lib/character-gen/generation-continuation";
import {
  getGenerationConfigWithMetaStrict,
} from "@/lib/config/getters";
import {
  publicFalWebhookOrigin,
} from "@/lib/character-gen/generation-submit-saga";
import {
  checkFalBalance,
} from "@/lib/fal-balance";
import {
  SERVER_ENV,
} from "@/lib/env.server";
import {
  PUBLIC_ENV,
} from "@/lib/env";
import {
  isRoleId,
} from "@/lib/roles";
import {
  log,
  errInfo,
} from "@/lib/log";
import {
  parseGenerationSubmitHttpResponse,
} from "@/lib/character-gen/http-contract";
import {
  GENERATION_IMAGE_MAX_BYTES,
  generationContentLengthAllowed,
  readGenerationFormData,
} from "@/lib/character-gen/request-boundary";
import {
  parseGenerationPreflightClaim,
  sha256Hex,
} from "@/lib/character-gen/generation-cost-control";
import {
  isUuid,
} from "@/lib/upload-write-safety";
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
    // A claimed reservation has already consumed the credit and holds the
    // in-flight slot. Every pre-submit failure below must hand both back
    // immediately instead of parking them until the expiry sweep.
    const releaseClaim = async (reason: string) => {
      try {
        const { data, error } = await admin.rpc(
          "release_generation_preflight",
          {
            p_user_id: user.id,
            p_request_id: requestId,
            p_worker_id: analysisWorkerId,
            p_reason: reason,
          },
        );
        if (error) throw error;
        log.info("gen.preflight_released", {
          userId: user.id,
          requestId,
          reason,
          outcome: (data as { outcome?: string } | null)?.outcome,
        });
      } catch (error) {
        // The expiry sweep remains the durable backstop.
        log.warn("gen.preflight_release_fail", {
          userId: user.id,
          requestId,
          reason,
          ...errInfo(error),
        });
      }
    };
    const falWebhookOrigin = publicFalWebhookOrigin(PUBLIC_ENV.SITE_URL);
    if (!falWebhookOrigin) {
      log.error("gen.webhook_origin_invalid");
      await releaseClaim("webhook_origin_invalid");
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
      await releaseClaim("config_read_fail");
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
      });
      await releaseClaim("balance_blocked");
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
      await releaseClaim("face_upload_fail");
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

  return continuationHttpResponse(
    await runGenerationContinuation({
      admin,
      provider,
      ownerId: user.id,
      requestId,
      role,
      imageDigest,
      preflight,
      faceSource: { kind: "bytes", prepared },
      startedAt,
    }),
  );
}

/** continuation 결과 → HTTP(종전 응답 코드·본문 그대로). */
function continuationHttpResponse(result: GenerationContinuationResult) {
  switch (result.kind) {
    case "submitted":
      return generationSubmitResponse(result.generationId);
    case "submit_pending":
      return generationSubmitResponse(result.generationId, 202);
    case "preflight_processing":
    case "face_source_missing":
      return generationPreflightProcessingResponse();
    case "no_credits":
      return NextResponse.json({ error: "no_credits" }, { status: 402 });
    case "service_unavailable":
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    case "reconciliation_required":
      return NextResponse.json(
        { error: "reconciliation_required" },
        { status: 503 },
      );
    case "generation_failed":
      return NextResponse.json(
        { error: "generation_failed" },
        { status: result.status },
      );
  }
}
