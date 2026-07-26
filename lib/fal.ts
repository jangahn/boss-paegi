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
  "Answer strictly in this exact format and nothing else: " +
  "'face=yes/no single=yes/no complete=yes/no clear=yes/no glasses=yes/no'. " +
  "face: Is there a clearly visible human face? " +
  "single: Is there exactly ONE person in the photo (answer no if two or more people are visible)? " +
  "complete: Is the entire head fully inside the photo — the very top of the hair/crown AND the whole face all visible, none cut off by any edge? " +
  "clear: Is the face completely unobstructed — NO hand, fingers, object, or gesture covering or touching any part of the face? " +
  "glasses: Is the main person wearing eyeglasses or sunglasses?";
const MOONDREAM_RAW_MAX = 500; // provenance rawOutput 길이 상한(모델이 형식 벗어난 긴 출력 반환 방어).

export type FaceAnalysis = {
  /** 또렷한 얼굴 존재. false = 제출·차감 전 반려(no_face). */
  faceVisible: boolean;
  /** 사진에 사람이 정확히 1명. false = 반려(여러 명). */
  singlePerson: boolean;
  /** 정수리~얼굴 전체가 프레임 안에 온전(잘림 없음). false = 반려(머리 전체 나오게). */
  headComplete: boolean;
  /** 손·물건·제스처가 얼굴을 가리지 않음. false = 반려(가림 제거). */
  faceClear: boolean;
  wearsGlasses: boolean;
  /** provenance 기록용 — 분석 모델·프롬프트·정규화된 raw(절단)·상태. rawOutput 은 fail-open 시 null. */
  model: string;
  prompt: string;
  rawOutput: string | null;
  status: "ok" | "fail_open";
};

/**
 * 입력 얼굴 분석 — VLM(Moondream) **1회 호출**로 ① 얼굴 유무 ② 머리 전체 온전(정수리~얼굴 잘림 없음)
 * ③ 얼굴 가림(손/물건/제스처) 여부 ④ 안경. 얼굴 옆 손(브이)·정수리 잘린 입력이 PuLID 에서 살색 blob·
 * 윗머리 잘림 아티팩트를 유발하므로 **제출·차감 전** 게이트한다.
 * - 각 판정은 **명시적 부정(no/가림)일 때만** false — 모호·파싱실패·예외는 통과(fail-open, 정상 사진
 *   과반려 방지). `wearsGlasses`: PuLID 가 안경을 떨궈 있을 때만 프롬프트 조건부 반영.
 * - model/prompt/rawOutput/status 는 gen_params provenance 기록용(예외 전문·PII 미포함).
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
      // 명시적 no 일 때만 반려, 그 외 통과(fail-open).
      faceVisible: !/face\s*=\s*no\b/.test(ans),
      singlePerson: !/single\s*=\s*no\b/.test(ans),
      headComplete: !/complete\s*=\s*no\b/.test(ans),
      faceClear: !/clear\s*=\s*no\b/.test(ans),
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
      singlePerson: true,
      headComplete: true,
      faceClear: true,
      wearsGlasses: false,
      model: MOONDREAM_MODEL,
      prompt: MOONDREAM_PROMPT,
      rawOutput: null,
      status: "fail_open",
    };
  }
}
