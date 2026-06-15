import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import {
  CharacterGenInput,
  CharacterProvider,
} from "@/lib/character-gen/types";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/**
 * FLUX PuLID: face identity 보존 전용 모델.
 * - reference 는 face image 1장 (template image 분리 입력 불가)
 * - 캐릭터 스타일은 prompt 묘사로 통제
 * - 호출당 1장(num_images 무시) → 후보 수만큼 제출.
 *
 * 비동기: 여기서는 fal 큐에 제출만 하고 request_id 들을 반환한다(결과 대기 X).
 * 결과 회수/후보 저장은 generation-recovery 가 queue.status/result 로 담당 →
 * 생성이 82초·2분 걸려도 서버리스 함수를 붙잡지 않음.
 */

// 캐릭터 묘사 — 의류 줄을 기준으로 head/tail 분리. 정장 "색"은 고정하지 않고
// 후보마다 팔레트에서 주입(buildPrompt) → 색 베리에이션 확보. 의류 타입·컨셉은 고정.
const CHARACTER_PROMPT_HEAD = [
  "A full body chibi character of a Korean office boss,",
  "standing front-facing pose, full body visible from head to feet,",
  "round large head with chibi super-deformed proportions, short body and limbs,",
].join(" ");

const CHARACTER_PROMPT_TAIL = [
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

// 오피스 톤 정장 색 팔레트(garish 회피). 생성마다 셔플 → 후보 수만큼 distinct.
const SUIT_COLORS = [
  "charcoal grey",
  "navy blue",
  "dark brown",
  "slate blue",
  "burgundy",
  "forest green",
  "tan beige",
  "light grey",
  "black",
];
function pickSuitColors(n: number): string[] {
  return [...SUIT_COLORS].sort(() => Math.random() - 0.5).slice(0, n);
}

// 사용자 face 의 identity 만 추출 강조 — 보존할 attribute 명시.
const IDENTITY_INSTRUCTION = [
  "Use the reference face with HIGH identity fidelity:",
  "preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle,",
  "nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence,",
  "face roundness, skin tone, ethnicity, age appearance.",
  "The character face must be strongly and clearly recognizable as the SAME specific reference person,",
  "keeping their distinctive unique facial features and proportions intact,",
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

export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false;

  async submitGeneration(input: CharacterGenInput): Promise<string[]> {
    const num = input.numImages ?? 3;

    // 안경은 입력에 있을 때만 반영(PuLID 가 액세서리를 떨궈서 누락되므로 조건부 주입).
    const eyewear = input.wearsGlasses ? " wearing eyeglasses," : "";
    const idEyewear = input.wearsGlasses
      ? " Preserve the eyeglasses of the reference person."
      : "";

    // 후보마다 다른 정장색 주입 → 색 베리에이션. 의류 타입·컨셉·identity 지시는 공통.
    const buildPrompt = (suitColor: string) =>
      `${CHARACTER_PROMPT_HEAD} wearing a ${suitColor} business suit jacket, ` +
      `dress shirt, necktie, dress trousers with belt, dress shoes,${eyewear} ` +
      `${CHARACTER_PROMPT_TAIL} ${IDENTITY_INSTRUCTION}${idEyewear}` +
      `${input.promptHints ? ` Additional: ${input.promptHints}.` : ""}`;

    // fal 큐에 num 건 제출(결과 대기 X) → request_id 들 반환.
    const submitted = await Promise.all(
      pickSuitColors(num).map((suitColor) =>
        fal.queue.submit("fal-ai/flux-pulid", {
          input: {
            prompt: buildPrompt(suitColor),
            reference_image_url: input.faceImageUrl,
            image_size: "square_hd",
            // 닮음도 ↑ — fal 은 id_weight 를 ≤1 로 제한(이미 최대)이라 못 올림.
            // true_cfg 2(스타일화 씬 identity 융합 + negative_prompt 실효화), guidance 4(기본).
            num_inference_steps: 28,
            guidance_scale: 4,
            negative_prompt: NEGATIVE_PROMPT,
            true_cfg: 2,
            id_weight: 1,
            // flux-pulid 전용 필드(true_cfg/id_weight)는 SDK 입력 타입에 없어 캐스팅
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      )
    );

    return submitted.map((s) => s.request_id);
  }
}
