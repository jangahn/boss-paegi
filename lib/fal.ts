import "server-only";
import { fal } from "@fal-ai/client";
import { SERVER_ENV } from "@/lib/env.server";

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
  "centered composition, upper body visible",
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
      strength: 0.85, // 높을수록 원본에서 멀어짐 — 정책상 식별성 낮춤
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
