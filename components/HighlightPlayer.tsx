"use client";

import { useState } from "react";
import { log, errInfo } from "@/lib/log";

/**
 * /share 의 하이라이트 영상 블록 (client) — 네이티브 컨트롤 video + 캡션 +
 * 뷰어 저장/재공유. 모달 프리뷰(무컨트롤)와 의도적 비대칭(목적: 보러 오는 destination).
 */
export function HighlightPlayer({
  clipUrl,
  posterUrl,
  shareUrl,
  delta,
}: {
  clipUrl: string;
  posterUrl: string;
  shareUrl: string;
  delta: number | null;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 파일 공유 실패/미지원 시 링크 재공유 폴백(멘트 없이 — OG 미리보기가 맥락 제공).
  const linkShare = async () => {
    try {
      if (typeof navigator !== "undefined" && "share" in navigator) {
        await navigator.share({ url: shareUrl });
        log.info("highlight.share_url_success", {});
        return;
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMsg("링크 복사됨");
    } catch {
      setMsg("공유 실패");
    }
  };

  // 영상 파일 공유·저장 — 저장 탭 시에만 fetch(egress 절감). **멘트 없이 영상만** 공유.
  // gesture 만료/CORS/미지원 → 링크 재공유 폴백.
  const onShareSave = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      if (typeof navigator !== "undefined" && navigator.canShare) {
        try {
          const res = await fetch(clipUrl);
          const blob = await res.blob();
          const file = new File([blob], "boss-paegi-highlight.mp4", {
            type: blob.type || "video/mp4",
          });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] }); // 영상만(멘트 X)
            log.info("highlight.share_url_success", { withFile: true });
            return;
          }
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") return; // 사용자 취소
          log.warn("highlight.file_share_failed", { ...errInfo(e) });
          // gesture 만료/CORS/미지원 → 아래 링크 재공유로 폴백
        }
      }
      await linkShare();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-5">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
        <video
          src={clipUrl}
          controls
          autoPlay
          loop
          muted
          playsInline
          poster={posterUrl}
          onError={() => log.warn("highlight.clip_play_unsupported", {})}
          className="mx-auto aspect-[9/16] max-h-64 w-full object-contain"
        />
        <p className="bg-black/70 py-1.5 text-center text-xs font-medium text-white/80">
          🔥 점수 급상승 하이라이트
          {delta ? ` · +${delta.toLocaleString()}점` : ""}
        </p>
      </div>
      <div className="mt-3 flex flex-col items-center gap-2">
        <button
          onClick={onShareSave}
          disabled={busy}
          className="w-full max-w-[420px] rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
        >
          🔥 영상 공유·저장
        </button>
        {msg && <p className="text-xs text-zinc-400">{msg}</p>}
      </div>
    </div>
  );
}
