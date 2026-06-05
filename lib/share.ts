import { PUBLIC_ENV } from "@/lib/env";

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

export async function shareGameResult(
  scoreId: string,
  score: number
): Promise<ShareResult> {
  const url = `${PUBLIC_ENV.SITE_URL}/share/${scoreId}`;
  const text = `부장님 ${score.toLocaleString()}점 패고 옴 🥊`;
  const title = "부장님 패기";

  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await navigator.share({ url, text, title });
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // share() 실패 → clipboard fallback 시도
    }
  }

  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    return "copied";
  } catch {
    return "failed";
  }
}
