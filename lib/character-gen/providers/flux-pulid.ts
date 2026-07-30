import "server-only";
import { SERVER_ENV } from "@/lib/env.server";
import {
  CharacterProvider,
  SubmitPlanInput,
  SubmitResult,
} from "@/lib/character-gen/types";
import { submitFalQueueOnce } from "@/lib/character-gen/fal-submit-once";
import { log, errInfo } from "@/lib/log";

/**
 * FLUX PuLID: face identity 보존 전용 모델.
 * - reference 는 face image 1장 (호출당 1장 → 후보 수만큼 제출)
 * - 프롬프트·수치는 generation_config(어드민) 소유 — route 가 buildGenerationPlan 으로 계획을 만들어 넘긴다.
 *
 * DB single-attempt claim을 받은 후보만 raw queue POST 1회. SDK queue.submit의
 * transport 자동 재시도는 수락-응답유실 때 중복 유료 작업을 만들 수 있어 쓰지 않는다.
 * 불확실한 응답은 signed webhook으로 request_id를 복구하고, 결과는 recovery가 회수한다.
 */
export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false;

  async submitPlan(input: SubmitPlanInput): Promise<SubmitResult[]> {
    return Promise.all(
      input.submitCandidates.map(async (candidate): Promise<SubmitResult> => {
        try {
          const outcome = await submitFalQueueOnce({
            endpoint: "fal-ai/flux-pulid",
            input: candidate.input,
            webhookUrl: candidate.webhookUrl,
            credentials: SERVER_ENV.FAL_KEY,
          });
          if (outcome.kind === "acknowledged") {
            return {
              index: candidate.index,
              requestId: outcome.requestId,
              status: "submitted",
              httpStatus: outcome.httpStatus,
            };
          }
          if (outcome.kind === "uncertain") {
            log.warn("gen.submit_candidate_uncertain", {
              index: candidate.index,
              httpStatus: outcome.httpStatus,
            });
            return {
              index: candidate.index,
              requestId: null,
              status: "uncertain",
              httpStatus: outcome.httpStatus,
            };
          }
          log.warn("gen.submit_candidate_rejected", {
            index: candidate.index,
            httpStatus: outcome.httpStatus,
          });
          return {
            index: candidate.index,
            requestId: null,
            status: "failed",
            httpStatus: outcome.httpStatus,
          };
        } catch (error) {
          // submitFalQueueOnce throws only before fetch (invalid local config);
          // no paid request can exist for this candidate.
          log.warn("gen.submit_candidate_preflight_fail", {
            index: candidate.index,
            ...errInfo(error),
          });
          return {
            index: candidate.index,
            requestId: null,
            status: "failed",
            httpStatus: null,
          };
        }
      }),
    );
  }
}
