"use client";

import { useState } from "react";
import { shareGameResult } from "@/lib/share";

/**
 * 결과 보고서 공유 버튼 — 게임 직후 화면과 이전 게임 상세에서 공용.
 * Web Share API(URL primary) → 미지원/실패 시 clipboard 폴백. 수신자는 /share/[scoreId] 로 랜딩.
 * 하이라이트가 있으면 라벨만 바뀌고(공유 링크는 동일), /share 페이지가 클립을 보여준다.
 */
export function ShareReportButton({
  scoreId,
  score,
  text,
  highlight = false,
}: {
  scoreId: string;
  score: number;
  /** 공유 시 함께 보낼 문구 (없으면 lib/share 기본 문구) */
  text?: string;
  /** 살아있는 하이라이트가 있으면 라벨을 "하이라이트 공유"로 */
  highlight?: boolean;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const result = await shareGameResult(scoreId, score, text ? { text } : undefined);
    setBusy(false);
    if (result === "copied") setMsg("공유 링크가 복사됐어요");
    else if (result === "failed") setMsg("공유에 실패했어요. 다시 시도해주세요.");
    // "shared" / "cancelled" → 별도 메시지 없음
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="w-full rounded-full bg-foreground py-3 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
      >
        {highlight ? "🔥 하이라이트 공유" : "결과 보고서 공유"}
      </button>
      {msg && <p className="mt-2 text-center text-xs text-zinc-400">{msg}</p>}
    </div>
  );
}
