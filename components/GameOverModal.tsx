"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useGameStore } from "@/store/gameStore";
import { shareGameResult } from "@/lib/share";
import { clampForSubmit } from "@/lib/score-limits";

type Props = {
  open: boolean;
  onRestart: () => void;
  weapon: string;
  dollId: string | null;
};

export function GameOverModal({ open, onRestart, weapon, dollId }: Props) {
  const router = useRouter();
  const score = useGameStore((s) => s.score);
  const maxCombo = useGameStore((s) => s.maxCombo);
  const startedAt = useGameStore((s) => s.startedAt);
  const endedAt = useGameStore((s) => s.endedAt);

  const [scoreId, setScoreId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 모달 열리는 순간 점수 자동 등록
  useEffect(() => {
    if (!open || scoreId || submitting || score <= 0) return;
    const durationMs = endedAt && startedAt ? endedAt - startedAt : 0;
    if (durationMs <= 0) return;

    setSubmitting(true);
    // 서버 검증과 동일 공식으로 클램프 — 열심히 팼는데 한도 초과로
    // score_out_of_range 저장 실패가 나는 일 방지.
    const clamped = clampForSubmit(score, durationMs);
    fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        score: clamped.score,
        weapon,
        durationMs: clamped.durationMs,
        dollId,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "submit_failed");
        setScoreId(data.scoreId);
      })
      .catch((e) => setSubmitError(e.message))
      .finally(() => setSubmitting(false));
  }, [open, scoreId, submitting, score, endedAt, startedAt, weapon, dollId]);

  if (!open) return null;

  const handleShare = async () => {
    if (!scoreId) return;
    setShareMsg(null);
    const result = await shareGameResult(scoreId, score);
    if (result === "shared") setShareMsg("공유했어요!");
    else if (result === "copied") setShareMsg("링크 복사됨");
    else if (result === "failed") setShareMsg("공유 실패");
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-3xl bg-zinc-900 p-8 text-center text-white shadow-2xl">
        <h2 className="text-3xl font-extrabold">시원하시죠?</h2>
        <p className="mt-2 text-sm text-zinc-400">오늘의 부장님 패기 결과</p>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="rounded-2xl bg-zinc-800 p-4">
            <div className="text-xs uppercase text-zinc-500">점수</div>
            <div className="mt-1 text-3xl font-extrabold tabular-nums">
              {score.toLocaleString()}
            </div>
          </div>
          <div className="rounded-2xl bg-zinc-800 p-4">
            <div className="text-xs uppercase text-zinc-500">최대 콤보</div>
            <div className="mt-1 text-3xl font-extrabold tabular-nums">
              x{maxCombo}
            </div>
          </div>
        </div>

        {submitError && (
          <p className="mt-4 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">
            점수 등록 실패: {submitError}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-3">
          <button
            onClick={onRestart}
            className="rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90"
          >
            다시 패기
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleShare}
              disabled={!scoreId}
              className="flex-1 rounded-full border border-white/15 py-3 font-medium transition hover:bg-white/5 disabled:opacity-30"
            >
              공유하기
            </button>
            <button
              onClick={() => router.push("/leaderboard")}
              disabled={!scoreId}
              className="flex-1 rounded-full border border-white/15 py-3 font-medium transition hover:bg-white/5 disabled:opacity-30"
            >
              랭킹 보기
            </button>
          </div>
          {shareMsg && (
            <p className="text-xs text-zinc-400">{shareMsg}</p>
          )}
          <Link
            href="/"
            className="mt-2 text-sm text-zinc-500 underline-offset-4 hover:text-white hover:underline"
          >
            홈으로
          </Link>
        </div>
      </div>
    </div>
  );
}
