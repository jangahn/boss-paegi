import { PUBLIC_ENV } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { log, errInfo } from "@/lib/log";
import type { HighlightClip } from "@/lib/highlight";

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

const HIGHLIGHT_BUCKET = "highlights";

/**
 * 하이라이트 클립을 백그라운드 업로드 (공유 버튼 탭 시 fire-and-forget).
 * gesture 와 무관 — 클립 바이트는 서명 URL 로 Supabase 에 직접(Vercel 미경유).
 * 실패해도 조용히 폐기(카드 공유로 강등) — 기본 링크 공유를 절대 막지 않음.
 * @returns "attached" 면 /share 에 영상 attach, "failed" 면 호출부가 카드로 폴백.
 */
export async function uploadHighlightClip(
  scoreId: string,
  clip: HighlightClip
): Promise<"attached" | "failed"> {
  try {
    const r = await fetch("/api/highlight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scoreId, mime: clip.mime }),
    });
    if (!r.ok) {
      if (r.status === 413 || r.status === 400)
        log.warn("highlight.upload_rejected_size", { scoreId, status: r.status });
      return "failed";
    }
    const { uploadId, ext, path, token } = (await r.json()) as {
      uploadId: string;
      ext: string;
      path: string;
      token: string;
    };
    const sb = createClient();
    const { error } = await sb.storage
      .from(HIGHLIGHT_BUCKET)
      .uploadToSignedUrl(path, token, clip.blob, { contentType: clip.mime });
    if (error) {
      log.warn("highlight.upload_fail", { scoreId, ...errInfo(error) });
      return "failed";
    }
    const patch = await fetch("/api/highlight", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scoreId,
        mode: "clip",
        uploadId,
        ext,
        delta: clip.delta,
        windowMs: clip.windowMs,
      }),
    });
    return patch.ok ? "attached" : "failed";
  } catch (e) {
    log.warn("highlight.upload_fail", { scoreId, ...errInfo(e) });
    return "failed";
  }
}

/**
 * 클립 없이(녹화 미지원/실패) 카드용 하이라이트 메타만 저장 — /share·OG 에 `+N점` 표시.
 * 업로드 없음(PATCH mode:'card'). 실패해도 기본 링크 공유는 안 막힘.
 */
export async function saveCardHighlight(
  scoreId: string,
  h: { delta: number; windowMs: number }
): Promise<"card" | "failed"> {
  try {
    const r = await fetch("/api/highlight", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scoreId,
        mode: "card",
        delta: h.delta,
        windowMs: h.windowMs,
      }),
    });
    return r.ok ? "card" : "failed";
  } catch (e) {
    log.warn("highlight.card_save_fail", { scoreId, ...errInfo(e) });
    return "failed";
  }
}

export async function shareGameResult(
  scoreId: string,
  score: number,
  opts?: { text?: string }
): Promise<ShareResult> {
  const url = `${PUBLIC_ENV.SITE_URL}/share/${scoreId}`;
  const text = opts?.text ?? `부장님 ${score.toLocaleString()}점 패고 옴 🥊`;
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
