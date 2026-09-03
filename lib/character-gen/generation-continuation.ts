import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  randomUUID,
} from "node:crypto";
import {
  deleteFaceTmp,
  tmpFacePath,
  uploadFaceTmp,
} from "@/lib/character-gen/upload-face";
import {
  buildGenerationPlan,
  FIXED_FLUX,
} from "@/lib/character-gen/plan";
import {
  failGeneration,
} from "@/lib/generation-recovery";
import {
  PROVENANCE_SCHEMA_VERSION,
} from "@/lib/character-gen/provenance";
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
import {
  SERVER_ENV,
} from "@/lib/env.server";
import {
  PUBLIC_ENV,
} from "@/lib/env";
import {
  log,
  errInfo,
} from "@/lib/log";
import {
  parseGenerationPreflightCommit,
  parseGenerationContinuationClaim,
  validGenerationContinuationComplete,
} from "@/lib/character-gen/generation-cost-control";
import {
  buildFalCallbackUrl,
  hashFalCallbackToken,
} from "@/lib/character-gen/fal-submit-once";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CharacterProvider } from "@/lib/character-gen";
import { isRoleId, type RoleId } from "@/lib/roles";
import {
  parseGenerationPreflightClaim,
  type GenerationPreflightClaim,
} from "@/lib/character-gen/generation-cost-control";
import {
  FaceSourceMissingError,
  copyFaceTmp,
} from "@/lib/character-gen/upload-face";
import { validateAdminRows } from "@/lib/admin-read-contract";

/**
 * 생성 continuation(얼굴검사 accepted → 크레딧 commit → fal 3장 제출 → 완료 기록) —
 * v1.20 에서 app/api/fal/route.ts 의 요청 후반부를 그대로 옮긴 것(로직·순서·RPC 불변).
 *
 * 호출자 세 곳이 같은 함수를 쓴다:
 *   ① 클라이언트 재요청 `POST /api/fal`(faceSource=bytes — 종전 경로 그대로)
 *   ② 마지막 얼굴검사 웹훅(faceSource=retained — 보존된 tmp/face/{requestId} 를 genId 경로로 복사)
 *   ③ gen-recover 스윕 백스톱(②와 동일)
 * DB lease(commit_generation_preflight / claim_generation_preflight_continuation 의 2분 lease)가
 * 동시 실행을 한 명으로 줄이므로 세 경로가 겹쳐도 제출은 한 번이다.
 *
 * 2026-09-03 실관측 배경: 얼굴검사가 서버에서 끝나도 제출은 클라이언트 재요청에만 의존해,
 * 카메라 앱 전환으로 fetch 가 끊긴 사용자의 예약이 accepted/pending 으로 영구 방치됐다.
 */

export type GenerationFaceSource =
  | { kind: "bytes"; prepared: Buffer }
  | { kind: "retained" };

export type GenerationContinuationResult =
  | { kind: "submitted"; generationId: string }
  | { kind: "submit_pending"; generationId: string }
  | { kind: "preflight_processing" }
  | { kind: "no_credits" }
  | { kind: "service_unavailable" }
  | { kind: "reconciliation_required" }
  | { kind: "face_source_missing"; generationId: string | null }
  | { kind: "generation_failed"; status: 500 | 502 };

export type GenerationContinuationArgs = {
  admin: SupabaseClient;
  provider: CharacterProvider;
  ownerId: string;
  requestId: string;
  role: RoleId;
  imageDigest: string;
  preflight: Extract<GenerationPreflightClaim, { kind: "accepted" | "committed" }>;
  faceSource: GenerationFaceSource;
  startedAt: number;
};

/** 최종 얼굴(genId 경로) 확보 — bytes 는 업로드, retained 는 보존본 복사. */
function materializeFinalFace(args: {
  ownerId: string;
  requestId: string;
  genId: string;
  faceSource: GenerationFaceSource;
}): Promise<{ url: string; path: string }> {
  if (args.faceSource.kind === "bytes") {
    return uploadFaceTmp(args.ownerId, args.genId, args.faceSource.prepared);
  }
  return copyFaceTmp(args.ownerId, args.requestId, args.genId);
}

export async function runGenerationContinuation(
  args: GenerationContinuationArgs,
): Promise<GenerationContinuationResult> {
  const {
    admin,
    provider,
    ownerId,
    requestId,
    role,
    imageDigest,
    preflight,
    faceSource,
    startedAt,
  } = args;
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
        p_user_id: ownerId,
        p_request_id: requestId,
        p_worker_id: continuationWorkerId,
      },
    );
    if (error) {
      log.warn("gen.continuation_claim_fail", {
        userId: ownerId,
        requestId,
        ...errInfo(error),
      });
      return { kind: "submit_pending", generationId: preflight.generationId };
    }
    const continuation = parseGenerationContinuationClaim(data);
    if (continuation.kind === "submitted") {
      return { kind: "submit_pending", generationId: continuation.generationId };
    }
    if (continuation.kind === "processing") {
      return { kind: "submit_pending", generationId: continuation.generationId };
    }
    if (continuation.kind === "invalid") {
      log.error("gen.continuation_claim_invalid", {
        userId: ownerId,
        requestId,
      });
      return { kind: "service_unavailable" };
    }
    genId = continuation.generationId;
    analysis = continuation.analysis;
    cfg = continuation.config;
    plan = continuation.plan;
  } else {
    const { data: commitData, error: commitError } = await admin.rpc(
      "commit_generation_preflight",
      {
        p_user_id: ownerId,
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
        userId: ownerId,
        requestId,
        noCredits,
        ...errInfo(commitError),
      });
      if (noCredits) {
        return { kind: "no_credits" };
      }
      return { kind: "preflight_processing" };
    }
    const committed = parseGenerationPreflightCommit(commitData);
    if (!committed.ok) {
      log.error("gen.preflight_commit_invalid", {
        userId: ownerId,
        requestId,
      });
      return { kind: "preflight_processing" };
    }
    genId = committed.generationId;
    analysis = committed.analysis;
    cfg = committed.config;
    plan = committed.plan;
    log.info("gen.credit_receipt_committed", {
      userId: ownerId,
      genId,
      remaining: committed.remaining,
    });
  }

  if (!genId || !analysis || !cfg || !plan) {
    return { kind: "preflight_processing" };
  }

  let facePath: string | null = null;
  // 임시 얼굴 정리(베스트에포트) — 실패는 원본이 남는 정책 #1 리스크라 반드시 가시화.
  const cleanupFace = (path: string): Promise<void> =>
    deleteFaceTmp(path).catch((err) =>
      log.warn("gen.face_cleanup_fail", { genId, tmpFaceId, userId: ownerId, ...errInfo(err) })
    );

  try {
    const uploadedFinal = await Sentry.startSpan(
      { name: "gen.face_upload", op: "storage.upload", attributes: { tmpFaceId, userId: ownerId } },
      () => materializeFinalFace({ ownerId, requestId, genId, faceSource })
    );
    facePath = uploadedFinal.path;
    await cleanupFace(tmpFacePath(ownerId, requestId));

    const falWebhookOrigin = publicFalWebhookOrigin(PUBLIC_ENV.SITE_URL);
    if (!falWebhookOrigin) {
      return { kind: "submit_pending", generationId: genId };
    }
    const { data: preparationData, error: preparationError } =
      await admin.rpc("get_generation_submit_preparation", {
        p_gen_id: genId,
        p_owner_id: ownerId,
      });
    if (preparationError) {
      return { kind: "submit_pending", generationId: genId };
    }
    const preparation = parseGenerationSubmitPreparation(preparationData);
    if (preparation.kind === "invalid") {
      log.error("gen.submit_preparation_invalid", { genId });
      return { kind: "submit_pending", generationId: genId };
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
        return { kind: "submit_pending", generationId: genId };
      }
      const { data: prepareData, error: prepareError } = await admin.rpc(
        "prepare_generation_submit_inputs",
        {
          p_gen_id: genId,
          p_owner_id: ownerId,
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
        return { kind: "submit_pending", generationId: genId };
      }
    } else if (plannedRebindIntents.length > 0) {
      const { data: rebindData, error: rebindError } = await admin.rpc(
        "rebind_generation_submit_inputs",
        {
          p_gen_id: genId,
          p_owner_id: ownerId,
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
        return { kind: "submit_pending", generationId: genId };
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
          p_owner_id: ownerId,
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
      return { kind: "reconciliation_required" };
    }

    // SDK 자동 POST 재시도를 우회한 raw single-attempt 제출. response loss/5xx/
    // malformed 2xx는 uncertain이며 절대 이 요청 안에서 재제출·환불하지 않는다.
    const freshResults = await Sentry.startSpan(
      {
        name: "gen.fal_submit",
        op: "fal.queue.submit_once",
        attributes: {
          genId,
          userId: ownerId,
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
      log.error("gen.submit_all_rejected", { genId, userId: ownerId });
      await failGeneration(admin, genId, ownerId, "submit_rejected");
      await cleanupFace(facePath);
      return { kind: "generation_failed", status: 502 };
    }
    if (!allThreeDurablySettled) {
      return { kind: "submit_pending", generationId: genId };
    }
    const { data: completeData, error: completeError } = await admin.rpc(
      "complete_generation_preflight_continuation",
      {
        p_user_id: ownerId,
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
      return { kind: "submit_pending", generationId: genId };
    }

    log.info("gen.submitted", {
      genId,
      userId: ownerId,
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
    return { kind: "submitted", generationId: genId };
  } catch (e) {
    if (e instanceof FaceSourceMissingError) {
      // 서버 주도 continuation 인데 보존된 원본이 이미 없다(고아 sweep·정리 뒤). 클라이언트가
      // 같은 사진으로 재요청하면 bytes 경로로 완료되고, 아니면 30분 stuck 백스톱이 환불한다.
      log.warn("gen.continuation_face_missing", {
        genId,
        tmpFaceId,
        userId: ownerId,
        ...errInfo(e),
      });
      return { kind: "face_source_missing", generationId: genId };
    }
    // Once committed, only the DB aggregate proving all three provider
    // rejections may refund. Any local exception or unknown claim result is a
    // recovery state, never evidence that no paid request exists.
    log.error("gen.submit_fail", { genId, tmpFaceId, userId: ownerId, ...errInfo(e) });
    return genId
      ? { kind: "submit_pending", generationId: genId }
      : { kind: "generation_failed", status: 500 };
  }
}

export type ServerContinuationOutcome =
  | { kind: "missing" }
  | { kind: "not_continuable"; state: string }
  | { kind: "claim_fail" }
  | { kind: "continued"; result: GenerationContinuationResult };

type ReservationRow = {
  id: string;
  owner_id: string;
  role: string;
  image_digest: string;
  state: string;
  continuation_state: string;
};

/**
 * 서버 주도 continuation 진입점(웹훅·스윕): 예약 행에서 소유자·롤·이미지 digest 를 읽어
 * 클라이언트 재요청과 똑같이 `claim_generation_preflight` 로 상태를 확인한 뒤 이어간다.
 * accepted/committed 가 아니면 아무것도 바꾸지 않는다.
 */
export async function continueReservationServerSide(args: {
  admin: SupabaseClient;
  provider: CharacterProvider;
  requestId: string;
  trigger: "face_webhook" | "sweep";
}): Promise<ServerContinuationOutcome> {
  const { admin, provider, requestId, trigger } = args;
  const { data: rawRow, error: rowError } = await admin
    .from("generation_preflight_reservations")
    .select("id, owner_id, role, image_digest, state, continuation_state")
    .eq("id", requestId)
    .maybeSingle();
  if (rowError) {
    log.warn("gen.continuation_reservation_read_fail", {
      requestId,
      trigger,
      ...errInfo(rowError),
    });
    return { kind: "claim_fail" };
  }
  if (!rawRow) return { kind: "missing" };
  let row: ReservationRow;
  try {
    row = validateAdminRows<ReservationRow>(
      "gen.continuation_reservation",
      [rawRow],
      {
        id: "uuid",
        owner_id: "uuid",
        role: "string",
        image_digest: "string",
        state: "string",
        continuation_state: "string",
      },
    )[0];
  } catch (error) {
    log.warn("gen.continuation_reservation_invalid", {
      requestId,
      trigger,
      ...errInfo(error),
    });
    return { kind: "claim_fail" };
  }
  if (
    (row.state !== "accepted" && row.state !== "committed") ||
    row.continuation_state === "submitted" ||
    !isRoleId(row.role)
  ) {
    return { kind: "not_continuable", state: row.state };
  }
  const { data: claimData, error: claimError } = await admin.rpc(
    "claim_generation_preflight",
    {
      p_user_id: row.owner_id,
      p_request_id: requestId,
      p_role: row.role,
      p_image_digest: row.image_digest,
      p_requires_credit: true,
      p_worker_id: randomUUID(),
    },
  );
  if (claimError) {
    log.warn("gen.continuation_claim_read_fail", {
      requestId,
      trigger,
      ...errInfo(claimError),
    });
    return { kind: "claim_fail" };
  }
  const preflight = parseGenerationPreflightClaim(claimData);
  if (preflight.kind !== "accepted" && preflight.kind !== "committed") {
    return { kind: "not_continuable", state: preflight.kind };
  }
  const result = await runGenerationContinuation({
    admin,
    provider,
    ownerId: row.owner_id,
    requestId,
    role: row.role,
    imageDigest: row.image_digest,
    preflight,
    faceSource: { kind: "retained" },
    startedAt: Date.now(),
  });
  log.info("gen.continuation_server", {
    requestId,
    trigger,
    outcome: result.kind,
    genId: "generationId" in result ? result.generationId : undefined,
  });
  return { kind: "continued", result };
}
