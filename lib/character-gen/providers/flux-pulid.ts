import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import {
  CharacterGenInput,
  CharacterProvider,
} from "@/lib/character-gen/types";
import { assembleGenerationPrompts } from "@/lib/config/domains/generation";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/**
 * FLUX PuLID: face identity 보존 전용 모델.
 * - reference 는 face image 1장 (template image 분리 입력 불가)
 * - 캐릭터 스타일은 prompt 묘사로 통제 — **프롬프트·수치는 generation_config(어드민)** 소유.
 *   최종 positive/negative 조립은 assembleGenerationPrompts 단일 소스(에디터 미리보기·golden 공용).
 * - 호출당 1장(num_images 무시) → 후보 수만큼 제출.
 *
 * 비동기: 여기서는 fal 큐에 제출만 하고 request_id 들을 반환한다(결과 대기 X).
 * 결과 회수/후보 저장은 generation-recovery 가 queue.status/result 로 담당 →
 * 생성이 82초·2분 걸려도 서버리스 함수를 붙잡지 않음.
 */

// 후보마다 다른 정장색 주입 → 색 베리에이션. 팔레트는 config(generation_config.prompt.suitColors).
function pickSuitColors(palette: string[], n: number): string[] {
  return [...palette].sort(() => Math.random() - 0.5).slice(0, n);
}

export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false;

  async submitGeneration(input: CharacterGenInput): Promise<string[]> {
    const cfg = input.genConfig;
    const num = input.numImages ?? 3;
    const role = input.role ?? "boss";
    const wearsGlasses = !!input.wearsGlasses;

    // fal 큐에 num 건 제출(결과 대기 X) → request_id 들 반환. 후보마다 다른 정장색.
    const submitted = await Promise.all(
      pickSuitColors(cfg.prompt.suitColors, num).map((suitColor) => {
        const { positive, negative } = assembleGenerationPrompts(cfg.prompt, role, {
          wearsGlasses,
          suitColor,
        });
        return fal.queue.submit("fal-ai/flux-pulid", {
          input: {
            prompt: positive,
            reference_image_url: input.faceImageUrl,
            image_size: cfg.numbers.imageSize,
            num_inference_steps: cfg.numbers.numInferenceSteps,
            guidance_scale: cfg.numbers.guidanceScale,
            negative_prompt: negative,
            true_cfg: cfg.numbers.trueCfg,
            // 닮음도 최대 — fal 은 id_weight 를 ≤1 로 제한(이미 최대)이라 config 노출 안 함(고정 1).
            id_weight: 1,
            // flux-pulid 전용 필드(true_cfg/id_weight)는 SDK 입력 타입에 없어 캐스팅
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        });
      })
    );

    return submitted.map((s) => s.request_id);
  }
}
