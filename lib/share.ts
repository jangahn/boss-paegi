import { PUBLIC_ENV } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { log, errInfo } from "@/lib/log";
import { SERVICE_NAME } from "@/lib/policy";
import { isMobileOS } from "@/lib/device";
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

/** 클립보드 복사 — writeText → 실패 시 textarea+execCommand 폴백. 공유 최후 수단. */
async function copyToClipboard(text: string): Promise<ShareResult> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok ? "copied" : "failed";
    } catch {
      return "failed";
    }
  }
}

/**
 * 통일 공유 규약 — 모든 공유(점수·캐릭터·하이라이트)의 단일 진입점.
 * - `url` 을 text 마지막 줄에 **1개만** 합성한다(분리 url 필드 미사용). macOS 네이티브
 *   공유시트 Copy 가 {url,text} 분리필드를 무구분 직렬화하는 문제를 원천 제거.
 * - 미디어 첨부는 **모바일 OS([[isMobileOS]]) + canShare(files)** 일 때만. 데스크톱은 문구+링크.
 * - 파일 공유 실패는 **파일 빼고 텍스트 공유 → 클립보드** 로 자동 강등(첨부 실패가 전체
 *   실패로 이어지지 않음). `AbortError`(사용자 취소)만 즉시 "cancelled" 로 중단.
 * - `brandText` 엔 url 을 넣지 않는다(여기서 1줄 부착 — config 저장 단계에서 raw URL 차단).
 */
export async function runShare({
  brandText,
  url,
  title,
  file,
}: {
  brandText: string;
  url: string;
  title: string;
  file?: File | null;
}): Promise<ShareResult> {
  const text = `${brandText.trim()}\n${url}`;
  const canNativeShare = typeof navigator !== "undefined" && "share" in navigator;

  // 1) 미디어 첨부 시도 — 모바일 OS + canShare files 일 때만
  if (
    canNativeShare &&
    file &&
    isMobileOS() &&
    navigator.canShare?.({ files: [file] })
  ) {
    try {
      await navigator.share({ title, text, files: [file] });
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // 첨부 공유 실패(NotAllowedError/TypeError/activation 상실 등) → 파일 빼고 재시도
    }
  }

  // 2) 텍스트(+url) 공유
  if (canNativeShare) {
    try {
      await navigator.share({ title, text });
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // share 실패 → 클립보드 폴백
    }
  }

  // 3) 클립보드 폴백(문구+링크)
  return copyToClipboard(text);
}

export async function shareGameResult(
  scoreId: string,
  score: number,
  opts?: { text?: string; file?: File | null }
): Promise<ShareResult> {
  const url = `${PUBLIC_ENV.SITE_URL}/share/${scoreId}`;
  const brandText = opts?.text ?? `부장님 ${score.toLocaleString()}점 패고 옴 🥊`;
  return runShare({ brandText, url, title: SERVICE_NAME, file: opts?.file });
}
