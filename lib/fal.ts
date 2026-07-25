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

/**
 * 입력 얼굴 분석 — VLM(Moondream) **1회 호출**로 ① 얼굴이 또렷이 보이는지 ② 안경 착용 여부.
 * - `faceVisible`: false 면 호출부가 *제출·차감 전* 반려해 no-face(fal facexlib 400)로 30~60초
 *   낭비+실패하던 것을 막는다. **단 'face=no' 가 명시적으로 잡힐 때만 false** — 모호·파싱실패·예외는
 *   true(fail-open)로 두어 정상 사진 과반려를 막는다(PR-1 의 no-face 즉시실패+환불이 안전망).
 * - `wearsGlasses`: PuLID 가 액세서리(안경)를 떨궈 누락하므로 있을 때만 프롬프트에 조건부 반영.
 */
export async function analyzeInputFace(
  imageUrl: string
): Promise<{ faceVisible: boolean; wearsGlasses: boolean }> {
  try {
    const result = await fal.subscribe("fal-ai/moondream3-preview/query", {
      input: {
        image_url: imageUrl,
        prompt:
          "Answer two questions about this image. Reply EXACTLY in this format with no other text: " +
          "'face=yes/no glasses=yes/no'. " +
          "Question face: Is there a clearly visible human face in the image? " +
          "Question glasses: Is the main person wearing eyeglasses or sunglasses?",
      },
      abortSignal: AbortSignal.timeout(8000),
    });
    const ans = ((result.data as MoondreamResponse).output ?? "").toLowerCase();
    return {
      faceVisible: !/face\s*=\s*no\b/.test(ans), // 명시적 no 일 때만 반려, 그 외 통과(fail-open)
      wearsGlasses: /glasses\s*=\s*yes\b/.test(ans),
    };
  } catch (e) {
    log.warn("gen.face_analyze_fail", errInfo(e));
    return { faceVisible: true, wearsGlasses: false }; // fail-open — 검출 실패로 생성을 막지 않음
  }
}
