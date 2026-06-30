"use client";

import { useState } from "react";
import { shareGameResult } from "@/lib/share";
import { isMobileOS } from "@/lib/device";
import { scoreTier } from "@/lib/report";
import { trackShare } from "@/lib/acquisition";

/**
 * 결과 보고서 공유 버튼 — 이전 게임 상세(history)에서 사용. 라벨·문구는 어드민 발행 config.
 * Web Share(문구+링크) → 미지원/실패 시 clipboard 폴백. 수신자는 /share/[scoreId] 로 랜딩.
 * 하이라이트 영상(clipUrl)이 있으면 **모바일에서만** 영상을 lazy fetch 해 함께 공유한다.
 * fetch 가 길어 user activation 이 끊겨 share 가 막히면 runShare 가 문구+링크로 자동 강등.
 */
export function ShareReportButton({
  scoreId,
  score,
  text,
  label,
  highlight = false,
  clipUrl = null,
}: {
  scoreId: string;
  score: number;
  /** 공유 시 함께 보낼 문구 (없으면 lib/share 기본 문구) */
  text?: string;
  /** 버튼 라벨(어드민 발행 config 에서 해소된 값) */
  label: string;
  /** 살아있는 하이라이트가 있으면 라벨/영상첨부 분기 */
  highlight?: boolean;
  /** attached 클립의 public URL — 있으면 모바일에서 영상 첨부 시도 */
  clipUrl?: string | null;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    // 공유 시도(분석) — 이전기록 상세. (surface×target×session) 3초 디바운스.
    trackShare({ surface: "history", target: "score", scoreTier: scoreTier(score) });

    // 모바일 + 하이라이트 영상 있을 때만 영상 첨부(데스크톱은 문구+링크).
    let file: File | null = null;
    if (highlight && clipUrl && isMobileOS()) {
      setMsg("영상 준비 중…");
      try {
        const res = await fetch(clipUrl);
        const blob = await res.blob();
        const ext = blob.type.includes("webm") ? "webm" : "mp4";
        file = new File([blob], `boss-paegi-highlight.${ext}`, {
          type: blob.type || "video/mp4",
        });
      } catch {
        file = null; // 영상 fetch 실패 → 문구+링크로 진행
      }
    }

    // file 첨부 실패(activation 상실 등)는 runShare 가 문구+링크→클립보드로 자동 강등.
    const result = await shareGameResult(scoreId, score, { text, file });
    setBusy(false);
    if (result === "copied") setMsg("공유 링크가 복사됐어요");
    else if (result === "failed") setMsg("공유에 실패했어요. 다시 시도해주세요.");
    else setMsg(null); // "shared" / "cancelled" → 메시지 없음("영상 준비 중…" 정리)
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="w-full rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-50"
      >
        {label}
      </button>
      {msg && <p className="mt-2 text-center text-xs text-zinc-400">{msg}</p>}
    </div>
  );
}
