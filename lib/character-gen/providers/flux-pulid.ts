import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import {
  CharacterProvider,
  SubmitPlanInput,
  SubmitResult,
} from "@/lib/character-gen/types";
import { log, errInfo } from "@/lib/log";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/**
 * FLUX PuLID: face identity 보존 전용 모델.
 * - reference 는 face image 1장 (호출당 1장 → 후보 수만큼 제출)
 * - 프롬프트·수치는 generation_config(어드민) 소유 — route 가 buildGenerationPlan 으로 계획을 만들어 넘긴다.
 *
 * allSettled 제출: 후보 일부 실패해도 접수된 request_id 를 유실하지 않는다(부분 성공 허용).
 * 결과 대기 X → generation-recovery 가 queue.status/result 로 회수.
 */
export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false;

  async submitPlan(input: SubmitPlanInput): Promise<SubmitResult[]> {
    const { faceImageUrl, plan } = input;
    const req = plan.request;

    const settled = await Promise.allSettled(
      plan.candidates.map((c) =>
        fal.queue
          .submit("fal-ai/flux-pulid", {
            input: {
              prompt: c.positivePrompt,
              reference_image_url: faceImageUrl,
              image_size: req.imageSize,
              num_inference_steps: req.numInferenceSteps,
              guidance_scale: req.guidanceScale,
              negative_prompt: plan.negative,
              true_cfg: req.trueCfg,
              id_weight: req.idWeight,
              // 고정 default 명시 제출(drift 제거). SDK 타입 밖 필드 캐스팅.
              enable_safety_checker: req.enableSafetyChecker,
              max_sequence_length: req.maxSequenceLength,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          })
          .then((s) => ({ index: c.index, requestId: s.request_id as string }))
      )
    );

    return plan.candidates.map((c, i): SubmitResult => {
      const r = settled[i];
      if (r.status === "fulfilled" && r.value.requestId) {
        return { index: c.index, requestId: r.value.requestId, status: "submitted" };
      }
      if (r.status === "rejected") {
        log.warn("gen.submit_candidate_fail", { index: c.index, ...errInfo(r.reason) });
      }
      return { index: c.index, requestId: null, status: "failed" };
    });
  }
}
