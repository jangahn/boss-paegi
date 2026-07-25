import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

// 캐릭터 생성(flux-pulid) 은 lib/character-gen/providers/flux-pulid.ts 담당. 프롬프트·수치는
// generation_config(어드민)·assembleGenerationPrompts 소유. 이 파일은 누끼(birefnet)·얼굴분석(moondream)만.

type BirefnetResponse = {
  image: { url: string; width: number; height: number; content_type?: string };
};

/**
 * 누끼 제거 — 캐릭터만 남기고 배경을 투명 PNG 로.
 * 게임 씬에서 캐릭터가 깔끔하게 떠 있도록 (배경 사각형 X).
 */
export async function removeBackground(imageUrl: string): Promise<string> {
  const result = await fal.subscribe("fal-ai/birefnet", {
    input: { image_url: imageUrl },
    pollInterval: 1000,
    // birefnet 은 실측 ~2s. doll 라우트 maxDuration=30 안에서 hang 방지 가드.
    abortSignal: AbortSignal.timeout(20_000),
  });
  const data = result.data as BirefnetResponse;
  return data.image.url;
}

type MoondreamResponse = { output?: string };

const MOONDREAM_MODEL = "fal-ai/moondream3-preview/query";
const MOONDREAM_PROMPT =
  "Answer two questions about this image. Reply EXACTLY in this format with no other text: " +
  "'face=yes/no glasses=yes/no'. " +
  "Question face: Is there a clearly visible human face in the image? " +
  "Question glasses: Is the main person wearing eyeglasses or sunglasses?";
const MOONDREAM_RAW_MAX = 500; // provenance rawOutput 길이 상한(모델이 형식 벗어난 긴 출력 반환 방어).

export type FaceAnalysis = {
  faceVisible: boolean;
  wearsGlasses: boolean;
  /** provenance 기록용 — 분석 모델·프롬프트·정규화된 raw(절단)·상태. rawOutput 은 fail-open 시 null. */
  model: string;
  prompt: string;
  rawOutput: string | null;
  status: "ok" | "fail_open";
};

/**
 * 입력 얼굴 분석 — VLM(Moondream) **1회 호출**로 ① 얼굴이 또렷이 보이는지 ② 안경 착용 여부.
 * - `faceVisible`: false 면 호출부가 *제출·차감 전* 반려. **'face=no' 명시일 때만 false** — 모호·실패는
 *   true(fail-open). `wearsGlasses`: PuLID 가 안경을 떨궈 있을 때만 프롬프트 조건부 반영.
 * - 나머지 필드(model/prompt/rawOutput/status)는 gen_params provenance 기록용(예외 전문·PII 미포함).
 */
export async function analyzeInputFace(imageUrl: string): Promise<FaceAnalysis> {
  try {
    const result = await fal.subscribe(MOONDREAM_MODEL, {
      input: { image_url: imageUrl, prompt: MOONDREAM_PROMPT },
      abortSignal: AbortSignal.timeout(8000),
    });
    const raw = (result.data as MoondreamResponse).output ?? "";
    const ans = raw.toLowerCase();
    return {
      faceVisible: !/face\s*=\s*no\b/.test(ans), // 명시적 no 일 때만 반려, 그 외 통과(fail-open)
      wearsGlasses: /glasses\s*=\s*yes\b/.test(ans),
      model: MOONDREAM_MODEL,
      prompt: MOONDREAM_PROMPT,
      rawOutput: raw.slice(0, MOONDREAM_RAW_MAX),
      status: "ok",
    };
  } catch (e) {
    log.warn("gen.face_analyze_fail", errInfo(e));
    // fail-open — 검출 실패로 생성을 막지 않음. 예외 전문은 기록하지 않음(정규화 결과만).
    return {
      faceVisible: true,
      wearsGlasses: false,
      model: MOONDREAM_MODEL,
      prompt: MOONDREAM_PROMPT,
      rawOutput: null,
      status: "fail_open",
    };
  }
}
