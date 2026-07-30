"use client";

import { useEffect, useRef, useState } from "react";
import { log, errInfo } from "@/lib/log";
import { trackShare } from "@/lib/acquisition";
import { isCurrentClientEpoch } from "@/lib/client-lifecycle";
import {
  fetchMediaBlob,
  HIGHLIGHT_DOWNLOAD_MAX_BYTES,
} from "@/lib/media-download";

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
  // 클립 재생 실패(검은/미지원 영상 등) → 영상 대신 카드 배지로 강등(공유 페이지 일관)
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(false);
  const operationEpochRef = useRef(0);
  const busyRef = useRef(false);
  const activeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationEpochRef.current += 1;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Soft navigation can reuse this client component with a newly signed URL.
    // Cancel the old download and make every old share completion stale.
    operationEpochRef.current += 1;
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    busyRef.current = false;
    /* eslint-disable react-hooks/set-state-in-effect */
    setBusy(false);
    setMsg(null);
    setFailed(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [clipUrl, shareUrl]);

  // 파일 공유 실패/미지원 시 링크 재공유 폴백(멘트 없이 — OG 미리보기가 맥락 제공).
  const linkShare = async (operationEpoch: number) => {
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
      if (
        isCurrentClientEpoch(
          operationEpoch,
          operationEpochRef.current,
          mountedRef.current,
        )
      ) {
        setMsg("링크 복사됨");
      }
    } catch {
      if (
        isCurrentClientEpoch(
          operationEpoch,
          operationEpochRef.current,
          mountedRef.current,
        )
      ) {
        setMsg("공유 실패");
      }
    }
  };

  // 영상 파일 공유·저장 — 저장 탭 시에만 fetch(egress 절감). **멘트 없이 영상만** 공유.
  // gesture 만료/CORS/미지원 → 링크 재공유 폴백.
  const onShareSave = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const operationEpoch = operationEpochRef.current + 1;
    operationEpochRef.current = operationEpoch;
    const abort = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = abort;
    setBusy(true);
    setMsg(null);
    // 공유 시도(분석) — 하이라이트 뷰어(/share). (surface×target×session) 3초 디바운스.
    trackShare({ surface: "highlight_viewer", target: "highlight" });
    try {
      if (typeof navigator !== "undefined" && navigator.canShare) {
        try {
          const media = await fetchMediaBlob(clipUrl, {
            kind: "video",
            maxBytes: HIGHLIGHT_DOWNLOAD_MAX_BYTES,
            signal: abort.signal,
          });
          if (
            !isCurrentClientEpoch(
              operationEpoch,
              operationEpochRef.current,
              mountedRef.current,
            )
          ) {
            return;
          }
          const file = new File(
            [media.blob],
            `boss-paegi-highlight.${media.extension}`,
            {
              type: media.type,
            },
          );
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
      if (
        isCurrentClientEpoch(
          operationEpoch,
          operationEpochRef.current,
          mountedRef.current,
        )
      ) {
        await linkShare(operationEpoch);
      }
    } finally {
      if (
        isCurrentClientEpoch(
          operationEpoch,
          operationEpochRef.current,
          mountedRef.current,
        )
      ) {
        if (activeAbortRef.current === abort) activeAbortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  if (failed) {
    // 영상 재생 실패(미지원/검은영상/**signed URL 만료** 등) → 카드 배지로 폴백(delta 만으로 렌더).
    //   signed URL 은 TTL(15분) 후 만료 — 오래 열어둔 페이지면 새로고침 시 재서명됨.
    return (
      <div className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm font-semibold text-red-300">
        🔥 점수 급상승 하이라이트{delta ? ` · +${delta.toLocaleString()}점` : ""}
        <span className="mt-1 block text-xs font-normal text-red-300/70">
          영상을 불러오지 못했어요 · 새로고침 후 다시 시도
        </span>
      </div>
    );
  }
  return (
    <div className="mb-5">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
        <video
          src={clipUrl}
          aria-label="점수 급상승 하이라이트 영상"
          controls
          autoPlay
          loop
          muted
          playsInline
          poster={posterUrl}
          onError={() => {
            log.warn("highlight.clip_play_unsupported", {});
            setFailed(true);
          }}
          className="mx-auto aspect-[9/16] max-h-64 w-full object-contain"
        />
        <p className="bg-black/70 py-1.5 text-center text-xs font-medium text-white/80">
          🔥 점수 급상승 하이라이트
          {delta ? ` · +${delta.toLocaleString()}점` : ""}
        </p>
      </div>
      <div className="mt-3 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onShareSave}
          disabled={busy}
          className="w-full max-w-[420px] rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "영상 준비 중…" : "🔥 영상 공유·저장"}
        </button>
        {msg && (
          <p role="status" aria-live="polite" className="text-xs text-zinc-400">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
