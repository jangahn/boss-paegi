import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/**
 * 강한 캐릭터화 프롬프트. 실제 얼굴과 닮음을 최소화하면서도
 * "부장님" 분위기를 살리기 위한 키워드 조합. CLAUDE.md 정책 준수.
 */
const CHARACTERIZATION_PROMPT = [
  "3D claymation caricature character",
  "of a Korean office boss in a business suit and tie",
  "exaggerated chibi cute style, big rounded head, simple cartoon features",
  "frowning serious expression, slightly grumpy",
  "soft studio lighting, plain neutral cream background",
  "toy-like figure, soft pastel colors",
  "heavily stylized cartoon doll, NOT photorealistic",
  // 화면 다 가리는 close-up 방지 — small figure with empty space
  "small full body figure centered in frame with plenty of empty space around it",
  "wide shot, NOT close-up, NOT face zoom",
].join(", ");

export type GeneratedImage = {
  url: string;
  width: number;
  height: number;
};

export type GenerateOptions = {
  /** data URI 형식의 입력 이미지 — 호출 후 보관하지 않음. */
  imageDataUri: string;
  numImages?: number;
};

type FluxResponse = {
  images: Array<{ url: string; width: number; height: number; content_type?: string }>;
  seed?: number;
  has_nsfw_concepts?: boolean[];
};

export async function generateBossDoll(
  opts: GenerateOptions
): Promise<GeneratedImage[]> {
  const result = await fal.subscribe("fal-ai/flux/dev/image-to-image", {
    input: {
      image_url: opts.imageDataUri,
      prompt: CHARACTERIZATION_PROMPT,
      // 0.65 — 원본 얼굴 특징(머리스타일/안경/얼굴형) 은 유지하되,
      // 정책상 photorealistic 식별 가능성 줄이는 균형점.
      // 너무 낮추면 비방 리스크, 너무 높이면 "내 부장님" 인식 실패.
      strength: 0.65,
      num_images: opts.numImages ?? 3,
      guidance_scale: 7,
      num_inference_steps: 28,
      enable_safety_checker: true,
    },
    pollInterval: 1500,
  });

  const data = result.data as FluxResponse;
  return data.images.map((img) => ({
    url: img.url,
    width: img.width,
    height: img.height,
  }));
}

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
