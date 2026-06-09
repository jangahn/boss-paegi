import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import {
  CharacterGenInput,
  CharacterGenResult,
  CharacterProvider,
} from "@/lib/character-gen/types";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/**
 * FLUX PuLID: face identity 보존 전용 모델.
 *  - reference 는 face image 1장만 (template image 분리 입력 불가)
 *  - template 스타일은 prompt 묘사로만 통제
 *  - face fidelity 가 FLUX-2 Pro Edit 보다 일반적으로 강함
 *
 * 우리 multi-template 모델과 호환되도록, templateImageUrl 은 받지만 무시하고
 * 그 styleHint (lib/character-gen/templates.ts) 를 prompt 에 자세히 박음.
 */

const TEMPLATE_DESCRIPTION = [
  "full body chibi character of a Korean office boss, standing front-facing pose,",
  "round large head with chibi proportions, short body and limbs,",
  "wearing dark navy blue business suit jacket with white dress shirt and dark blue necktie,",
  "dark trousers with belt, black dress shoes,",
  "slightly grumpy or stern facial expression, rosy cheeks,",
  "plush soft fabric doll material texture (felt-like),",
  "square 1:1 aspect ratio, plain pure white background, no scene, no shadows on background,",
  "soft studio lighting, no harsh shadows,",
].join(" ");

const IDENTITY_INSTRUCTION = [
  "Use the reference face with HIGH identity fidelity:",
  "preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle,",
  "nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence,",
  "face roundness, skin tone, ethnicity, age appearance.",
  "The character must be clearly recognizable as the reference person, but reinterpreted",
  "in the plush chibi office boss template style described above.",
].join(" ");

type PulidResponse = {
  images?: Array<{ url: string; width?: number; height?: number; content_type?: string }>;
};

const COST_CENTS_PER_IMAGE = 4; // ~$0.033/MP × 1MP

export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false; // template URL 무시, prompt 만 사용

  async generate(input: CharacterGenInput): Promise<CharacterGenResult> {
    const t0 = Date.now();
    const num = input.numImages ?? 3;
    const prompt = `${TEMPLATE_DESCRIPTION} ${IDENTITY_INSTRUCTION}${
      input.promptHints ? ` Additional: ${input.promptHints}.` : ""
    }`;

    // pulid 도 한 호출당 이미지 1장 — N번 병렬
    const calls = await Promise.all(
      Array.from({ length: num }, () =>
        fal.subscribe("fal-ai/flux-pulid", {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: {
            prompt,
            reference_image_url: input.faceImageUrl,
            image_size: "square_hd",
            num_inference_steps: 28,
            guidance_scale: 4,
            negative_prompt:
              "photorealistic photograph of the reference, identical clothing as reference, identical background as reference",
            true_cfg: 1,
            id_weight: 1,
          } as any,
          pollInterval: 1500,
        })
      )
    );

    const images = calls.flatMap((r) => {
      const data = r.data as PulidResponse;
      return (data.images ?? []).map((i) => ({
        url: i.url,
        width: i.width ?? 1024,
        height: i.height ?? 1024,
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
