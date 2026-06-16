"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { shareGameResult } from "@/lib/share";
import { bossReaction, gradeFor, reportNo } from "@/lib/report";
import { getMyProfile } from "@/lib/profile";
import { useScoreSubmission } from "./useScoreSubmission";
import { ScoreReport } from "./ScoreReport";

type Props = {
  open: boolean;
  onRestart: () => void;
  weapon: string;
  dollId: string | null;
  /** 보고서에 표시할 인형 이미지 (커스텀 or 기본 부장님) */
  dollImageUrl?: string;
};

export function GameOverModal({
  open,
  onRestart,
  weapon,
  dollId,
  dollImageUrl,
}: Props) {
  const router = useRouter();
  const score = useGameStore((s) => s.score);
  const maxCombo = useGameStore((s) => s.maxCombo);
  const hitCount = useGameStore((s) => s.hitCount);
  const weaponCounts = useGameStore((s) => s.weaponCounts);
  const startedAt = useGameStore((s) => s.startedAt);
  const endedAt = useGameStore((s) => s.endedAt);

  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>("");

  // 점수 자동 제출(중복/0점 가드·클램프·trace 는 hook 내부)
  const { scoreId, submitting, submitError } = useScoreSubmission({
    open,
    score,
    endedAt,
    startedAt,
    weapon,
    dollId,
    maxCombo,
  });

  useEffect(() => {
    if (!open) return;
    getMyProfile()
      .then((p) => p && setNickname(p.display_name))
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const durationMs = endedAt && startedAt ? endedAt - startedAt : 0;
  const grade = gradeFor(score);
  const mainWeapon = topWeapon(weaponCounts) ?? weapon;
  const reaction = bossReaction(score, scoreId ?? String(score));
  const docNo = scoreId ? reportNo(scoreId, new Date()) : "결재 대기";

  const handleShare = async () => {
    if (!scoreId) return;
    setShareMsg(null);
    const result = await shareGameResult(scoreId, score);
    if (result === "shared") setShareMsg("공유했어요!");
    else if (result === "copied") setShareMsg("링크 복사됨");
    else if (result === "failed") setShareMsg("공유 실패");
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-sm">
        {/* ── 보고서 (종이) ───────────────────────────────── */}
        <ScoreReport
          docNo={docNo}
          score={score}
          maxCombo={maxCombo}
          hitCount={hitCount}
          mainWeapon={mainWeapon}
          durationMs={durationMs}
          grade={grade}
          reaction={reaction}
          nickname={nickname}
          dollImageUrl={dollImageUrl}
          submitting={submitting}
          submitError={submitError}
        />

        {/* ── CTA ────────────────────────────────────────── */}
        <div className="mt-4 flex flex-col gap-2.5">
          <button
            onClick={handleShare}
            disabled={!scoreId}
            className="rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90 disabled:opacity-40"
          >
            보고서 공유하기
          </button>
          <button
            onClick={onRestart}
            className="rounded-full border border-white/25 py-3 font-medium text-white transition hover:bg-white/10"
          >
            다시 패기
          </button>
          <div className="flex justify-center gap-5 pt-1 text-sm text-zinc-300">
            <button
              onClick={() => router.push("/leaderboard")}
              className="underline-offset-4 hover:underline"
            >
              랭킹 보기
            </button>
            <Link href="/gallery" className="underline-offset-4 hover:underline">
              갤러리
            </Link>
            <Link href="/" className="underline-offset-4 hover:underline">
              홈으로
            </Link>
          </div>
          {shareMsg && (
            <p className="text-center text-xs text-zinc-400">{shareMsg}</p>
          )}
        </div>
      </div>
    </div>
  );
}
