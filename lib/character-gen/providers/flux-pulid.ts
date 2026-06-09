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
 * - reference 는 face image 1장 (template image 분리 입력 불가)
 * - 캐릭터 스타일은 prompt 묘사로 통제
 * - 우리 부장님 캐릭터 컨셉을 prompt 에 박아둠
 */

// 캐릭터 묘사 — chibi 부장님 컨셉을 매번 동일하게 강제하기 위한 자세한 prompt.
const CHARACTER_PROMPT = [
  "A full body chibi character of a Korean office boss,",
  "standing front-facing pose, full body visible from head to feet,",
  "round large head with chibi super-deformed proportions, short body and limbs,",
  "wearing dark navy blue business suit jacket, white dress shirt, dark blue necktie,",
  "dark trousers with belt, black dress shoes,",
  "slightly grumpy stern facial expression, rosy cheeks,",
  "soft plush fabric doll material texture, felt-like surface,",
  "plain pure white background, no scene, no objects, no shadows on background,",
  // 화질 + focus 강제 — 균일한 sharpness, photoreal depth-of-field 효과 배제
  "sharp focus, all-in-focus, even soft studio lighting from front,",
  "high detail, crisp clean lines, no motion blur,",
  "no depth of field, no bokeh, no shallow focus, no blur effect,",
  "professional product photography of a toy character,",
  "1:1 square aspect ratio, centered composition.",
].join(" ");

// 사용자 face 의 identity 만 추출 강조 — 보존할 attribute 명시.
const IDENTITY_INSTRUCTION = [
  "Use the reference face with HIGH identity fidelity:",
  "preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle,",
  "nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence,",
  "face roundness, skin tone, ethnicity, age appearance.",
  "The character face must be clearly recognizable as the reference person,",
  "reinterpreted in the plush chibi office boss style described above.",
].join(" ");

// negative — 일반적인 화질 저하 + 이상한 focus 효과 명시 배제
const NEGATIVE_PROMPT = [
  "blurry, out of focus, soft focus, depth of field, bokeh, motion blur, lens blur,",
  "shallow focus, defocused background, hazy, foggy,",
  "low quality, jpeg artifacts, noise, grain, pixelated, oversharpened, oversaturated,",
  "photorealistic photograph of the reference person,",
  "identical clothing as the reference, identical background as the reference,",
  "multiple characters, group, crowd, two people,",
  "scene, environment, props, furniture, plants,",
  "text, watermark, signature, logo, frame, border",
].join(", ");

type PulidResponse = {
  images?: Array<{ url: string; width?: number; height?: number; content_type?: string }>;
};

const COST_CENTS_PER_IMAGE = 4; // ~$0.033/MP × 1MP

export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false;

  async generate(input: CharacterGenInput): Promise<CharacterGenResult> {
    const t0 = Date.now();
    const num = input.numImages ?? 3;
    const prompt = `${CHARACTER_PROMPT} ${IDENTITY_INSTRUCTION}${
      input.promptHints ? ` Additional: ${input.promptHints}.` : ""
    }`;

    const calls = await Promise.all(
      Array.from({ length: num }, () =>
        fal.subscribe("fal-ai/flux-pulid", {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: {
            prompt,
            reference_image_url: input.faceImageUrl,
            image_size: "square_hd",
            // 화질 ↑ — steps 28 → 35, guidance 4 → 6 으로 prompt 더 엄격히 따름
            num_inference_steps: 35,
            guidance_scale: 6,
            negative_prompt: NEGATIVE_PROMPT,
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
