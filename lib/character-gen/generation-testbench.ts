import { z } from "zod";
// 상대 .ts 경로 — node --test 에서 별칭 로더 없이 로드(prompt-golden 관례).
import {
  assembleGenerationPrompts,
  generationConfigSchema,
  type GenerationConfig,
} from "../config/domains/generation.ts";
import { FIXED_FLUX } from "./plan.ts";
import type { FluxPulidQueueInput } from "./flux-pulid-input.ts";

// 어드민 생성 config A/B 테스트 벤치 — 세션 내 일회성(저장 없음), 크레딧/ai_generations/
// 유저 파이프라인 절대 무접촉. 서버가 설정을 서버권위로 조립하고(fal-ai/flux-pulid queue),
// **모든 설정에 동일한 seed 쌍**을 재사용해 공정 비교한다(설정당 2장, 총 ≤6장 강제).

export const GENERATION_TEST_MAX_SETTINGS = 3;
export const GENERATION_TEST_IMAGES_PER_SETTING = 2;
export const GENERATION_TEST_MAX_IMAGES =
  GENERATION_TEST_MAX_SETTINGS * GENERATION_TEST_IMAGES_PER_SETTING;
// settings JSON 원문 상한 — config 3벌(FIELD_MAX 상한 감안) 여유. multipart 캡과 별도 강제.
export const GENERATION_TEST_SETTINGS_MAX_BYTES = 256 * 1024;

// ROLE_IDS 런타임 import 회피(node --test) — generation.ts 의 strict roles 관례와 동일.
const testRoleSchema = z.enum(["boss", "exec", "teamlead", "client", "coworker"]);

const generationTestSettingSchema = z
  .object({
    value: generationConfigSchema,
    role: testRoleSchema,
    wearsGlasses: z.boolean(),
  })
  .strict();

export type GenerationTestSetting = z.infer<typeof generationTestSettingSchema>;

export const generationTestSettingsSchema = z
  .array(generationTestSettingSchema)
  .min(1)
  .max(GENERATION_TEST_MAX_SETTINGS);

/** multipart settings 필드(JSON 문자열) → 검증된 설정 배열. 초과/손상/스키마 위반은 null. */
export function parseGenerationTestSettings(
  raw: unknown,
): GenerationTestSetting[] | null {
  if (typeof raw !== "string" || raw.length < 1) return null;
  if (Buffer.byteLength(raw, "utf8") > GENERATION_TEST_SETTINGS_MAX_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = generationTestSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type GenerationTestQueueInput = FluxPulidQueueInput &
  Readonly<{ seed: number }>;

export type GenerationTestSubmission = {
  settingIndex: number;
  imageIndex: number;
  seed: number;
  input: GenerationTestQueueInput;
};

/**
 * 설정별 제출 입력 조립(서버권위) — assembleGenerationPrompts 단일 소스, FIXED_FLUX 상수 재사용.
 * 정장색은 각 설정의 첫 suitColor 로 고정(미리보기와 동일 규약 — seed 와 함께 공정 비교 변인 통제).
 */
export function buildGenerationTestSubmissions(
  settings: readonly GenerationTestSetting[],
  faceImageUrl: string,
  seeds: readonly [number, number],
): GenerationTestSubmission[] {
  if (
    settings.length < 1 ||
    settings.length > GENERATION_TEST_MAX_SETTINGS ||
    settings.length * GENERATION_TEST_IMAGES_PER_SETTING >
      GENERATION_TEST_MAX_IMAGES
  ) {
    throw new Error("generation_test_settings_out_of_bounds");
  }
  if (
    seeds.length !== GENERATION_TEST_IMAGES_PER_SETTING ||
    seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0)
  ) {
    throw new Error("generation_test_seeds_invalid");
  }
  return settings.flatMap((setting, settingIndex) => {
    const config: GenerationConfig = setting.value;
    const suitColor = config.prompt.suitColors[0];
    const { positive, negative } = assembleGenerationPrompts(
      config.prompt,
      setting.role,
      { wearsGlasses: setting.wearsGlasses, suitColor },
    );
    return seeds.map((seed, imageIndex) => ({
      settingIndex,
      imageIndex,
      seed,
      input: {
        prompt: positive,
        reference_image_url: faceImageUrl,
        image_size: config.numbers.imageSize,
        num_inference_steps: config.numbers.numInferenceSteps,
        guidance_scale: config.numbers.guidanceScale,
        negative_prompt: negative,
        true_cfg: config.numbers.trueCfg,
        id_weight: FIXED_FLUX.idWeight,
        enable_safety_checker: FIXED_FLUX.enableSafetyChecker,
        max_sequence_length: FIXED_FLUX.maxSequenceLength,
        seed,
      },
    }));
  });
}

// fal request_id 형태 — flux-pulid-result-contract 의 persisted request_id 검증과 동일 경계.
const TEST_REQUEST_ID_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;

/** status 라우트 body {requestIds[]} → 검증된 id 배열(1~총 이미지 상한, 중복 금지). 위반은 null. */
export function parseGenerationTestStatusRequest(
  value: unknown,
): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const ids = (value as Record<string, unknown>).requestIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > GENERATION_TEST_MAX_IMAGES ||
    ids.some((id) => typeof id !== "string" || !TEST_REQUEST_ID_RE.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    return null;
  }
  return ids as string[];
}
