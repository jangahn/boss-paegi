import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import { buildMultiRefPrompt } from "@/lib/character-gen/prompts";
import {
  CharacterGenInput,
  CharacterGenResult,
  CharacterProvider,
} from "@/lib/character-gen/types";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

type FluxEditResponse = {
  images: Array<{
    url: string;
    width: number;
    height: number;
    content_type?: string;
  }>;
};

// 1024×1024 출력 기준 가격 ($0.03/MP × 1MP × N장)
const COST_CENTS_PER_IMAGE = 3;

export class Flux2ProEditProvider implements CharacterProvider {
  readonly name = "flux2-pro-edit";
  readonly supportsTemplate = true;

  async generate(input: CharacterGenInput): Promise<CharacterGenResult> {
    const t0 = Date.now();
    const num = input.numImages ?? 3;
    const prompt = buildMultiRefPrompt({
      promptHints: input.promptHints,
    });

    // flux-2-pro/edit 는 한 번 호출당 이미지 1장 — N번 병렬 호출로 후보 N장.
    // 각 호출은 다른 seed → 다양한 결과.
    // identity 보존 강화 옵션 — fal-ai client typed input 에 노출 안 된 파라미터들.
    // fal 가 받으면 적용, 모르는 옵션이면 silently ignore (확인은 실제 결과 비교로).
    const extendedInput = {
      prompt,
      image_urls: [input.templateImageUrl, input.faceImageUrl],
      image_size: "square_hd",
      guidance_scale: 12, // 7 → 12: "@image2 face 그대로" 지시 강화
      num_inference_steps: 40, // 28 → 40: face detail 정밀화
      enable_safety_checker: true,
    };

    const calls = await Promise.all(
      Array.from({ length: num }, () =>
        fal.subscribe("fal-ai/flux-2-pro/edit", {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: extendedInput as any,
          pollInterval: 1500,
        })
      )
    );

    const images = calls.flatMap((r) => {
      const data = r.data as FluxEditResponse;
      return data.images.map((i) => ({
        url: i.url,
        width: i.width,
        height: i.height,
      }));
    });

    return {
      images,
      provider: this.name,
      costCents: COST_CENTS_PER_IMAGE * num,
      durationMs: Date.now() - t0,
    };
  }
}
