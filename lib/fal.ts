import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";
import {
  FACE_CHECK_KEYS,
  FACE_CHECK_PROMPTS,
  MOONDREAM_MODEL,
  MOONDREAM_RAW_MAX,
  interpretFaceChecks,
  type FaceAnalysis,
  type FaceCheck,
  type FaceCheckKey,
} from "@/lib/character-gen/face-analysis";

export type { FaceAnalysis } from "@/lib/character-gen/face-analysis";

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

/** moondream/query 단일질문 1회. 실패는 상위에서 allSettled 로 흡수(fail-open). */
async function askMoondream(imageUrl: string, prompt: string): Promise<string> {
  const result = await fal.subscribe(MOONDREAM_MODEL, {
    input: { image_url: imageUrl, prompt },
    abortSignal: AbortSignal.timeout(8000),
  });
  return (result.data as MoondreamResponse).output ?? "";
}

/**
 * 입력 얼굴 분석 — 체크별 단일질문을 **병렬 호출**(compound 프롬프트 무력화 회피, 상세는 face-analysis.ts).
 * ① 얼굴 유무 ② 인원 수(여러 명) ③ 얼굴 가림(손/물건) ④ 안경. 불량 입력(브이·여러 명)이 PuLID 낭비·
 * 아티팩트를 유발하므로 **제출·차감 전** 게이트한다(정수리 잘림은 신뢰성 미달로 제외 — 생성 프롬프트가 담당).
 * - 각 판정은 **명시적 위반일 때만** 차단(fail-open) — 일부/전부 콜 실패도 통과시켜 정상 사진 과반려 방지.
 * - checks(프롬프트·raw)·model·status 는 gen_params provenance 기록용(예외 전문·PII 미포함).
 */
export async function analyzeInputFace(imageUrl: string): Promise<FaceAnalysis> {
  const settled = await Promise.allSettled(
    FACE_CHECK_KEYS.map((k) => askMoondream(imageUrl, FACE_CHECK_PROMPTS[k]))
  );
  const raw = {} as Record<FaceCheckKey, string | null>;
  let anyFail = false;
  FACE_CHECK_KEYS.forEach((k, i) => {
    const s = settled[i];
    if (s.status === "fulfilled") {
      raw[k] = s.value.slice(0, MOONDREAM_RAW_MAX);
    } else {
      raw[k] = null;
      anyFail = true;
      log.warn("gen.face_analyze_fail", { check: k, ...errInfo(s.reason) });
    }
  });
  const interp = interpretFaceChecks(raw);
  const checks: FaceCheck[] = FACE_CHECK_KEYS.map((k) => ({
    key: k,
    prompt: FACE_CHECK_PROMPTS[k],
    rawOutput: raw[k],
  }));
  return { ...interp, model: MOONDREAM_MODEL, checks, status: anyFail ? "fail_open" : "ok" };
}
