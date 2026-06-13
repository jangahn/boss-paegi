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

// flux-pulid 는 호출당 1장(num_images 무시) → 후보 수만큼 병렬 호출.
// 실측(2026-06): 단일 ~15s, 3장 병렬 ~29s(계정 동시성에 throttle), 혼잡 시 더 김.
// Vercel maxDuration=60 강제 종료 전에 깔끔히 실패하도록 abort 가드를 둔다.
// 48s 에서 끊으면 이후 후보 복사·응답까지 60s 안에 끝낼 여유(~12s) 가 남는다.
const GENERATE_TIMEOUT_MS = 48_000;

export class FluxPulidProvider implements CharacterProvider {
  readonly name = "flux-pulid";
  readonly supportsTemplate = false;

  async generate(input: CharacterGenInput): Promise<CharacterGenResult> {
    const t0 = Date.now();
    const num = input.numImages ?? 3;
    const prompt = `${CHARACTER_PROMPT} ${IDENTITY_INSTRUCTION}${
      input.promptHints ? ` Additional: ${input.promptHints}.` : ""
    }`;

    // 병렬 호출 전체에 공유 타임아웃 — 하나라도 48s 넘기면 그 호출만 abort.
    const abortSignal = AbortSignal.timeout(GENERATE_TIMEOUT_MS);

    // allSettled: 1개가 abort/실패해도 나머지 완성본은 살린다.
    // (Promise.all 은 1개 reject 시 전체를 버려 — 큐 혼잡 시 멀쩡한 후보까지 손실)
    const settled = await Promise.allSettled(
      Array.from({ length: num }, () =>
        fal.subscribe("fal-ai/flux-pulid", {
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
            // flux-pulid 전용 필드(true_cfg/id_weight)는 SDK 입력 타입에 없어 캐스팅
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          pollInterval: 1500,
          abortSignal,
          // 큐 등록 즉시 request_id 보고 → 라우트가 row 에 저장(복구용)
          onEnqueue: (requestId) => input.onEnqueue?.(requestId),
        })
      )
    );

    const images = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => {
        const data = (r as PromiseFulfilledResult<{ data: PulidResponse }>)
          .value.data;
        return (data.images ?? []).map((i) => ({
          url: i.url,
          width: i.width ?? 1024,
          height: i.height ?? 1024,
        }));
      });

    if (images.length === 0) {
      // 전부 실패 — abort(timeout) 였는지 보존해 라우트가 분류·안내하게 한다.
      const reasons = settled.flatMap((r) =>
        r.status === "rejected" ? [r.reason] : []
      );
      const timedOut = reasons.some(
        (e) => e?.name === "TimeoutError" || e?.name === "AbortError"
      );
      const err = new Error(
        timedOut
          ? "generation timed out"
          : reasons[0]?.message ?? "all generations failed"
      );
      if (timedOut) err.name = "TimeoutError";
      throw err;
    }

    return {
      images,
      provider: this.name,
      // 실제 완성된 장수만 과금 (부분 성공 시 적게)
      costCents: COST_CENTS_PER_IMAGE * images.length,
      durationMs: Date.now() - t0,
    };
  }
}
