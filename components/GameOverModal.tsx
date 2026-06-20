"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { shareGameResult, uploadHighlightClip } from "@/lib/share";
import { bossReaction, gradeFor, reportNo } from "@/lib/report";
import { getMyProfile } from "@/lib/profile";
import type { HighlightClip } from "@/lib/highlight";
import { useScoreSubmission } from "./useScoreSubmission";
import { ScoreReport } from "./ScoreReport";

type Props = {
  open: boolean;
  onRestart: () => void;
  weapon: string;
  dollId: string | null;
  /** 보고서에 표시할 인형 이미지 (커스텀 or 기본 부장님) */
  dollImageUrl?: string;
  /** 하이라이트 녹화분 (없으면 카드만 공유) */
  highlightClip?: HighlightClip | null;
};

export function GameOverModal({
  open,
  onRestart,
  weapon,
  dollId,
  dollImageUrl,
  highlightClip,
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

  // 로컬 프리뷰 objectURL — clip 값 기반 memo, 언마운트/변경 시 revoke (set-state 회피).
  const clip = open ? highlightClip ?? null : null;
  const clipUrl = useMemo(
    () => (clip ? URL.createObjectURL(clip.blob) : null),
    [clip]
  );
  useEffect(() => {
    return () => {
      if (clipUrl) URL.revokeObjectURL(clipUrl);
    };
  }, [clipUrl]);

  if (!open) return null;

  const durationMs = endedAt && startedAt ? endedAt - startedAt : 0;
  const grade = gradeFor(score);
  const mainWeapon = topWeapon(weaponCounts) ?? weapon;
  const reaction = bossReaction(score, scoreId ?? String(score));
  const docNo = scoreId ? reportNo(scoreId, new Date()) : "결재 대기";

  // gesture 안에서 URL 즉시 공유, 클립 업로드는 백그라운드(fire-and-forget).
  const handleShare = () => {
    if (!scoreId) return;
    setShareMsg(null);
    if (clip) void uploadHighlightClip(scoreId, clip);
    void shareGameResult(scoreId, score).then((result) => {
      if (result === "shared") setShareMsg("공유했어요!");
      else if (result === "copied") setShareMsg("링크 복사됨");
      else if (result === "failed") setShareMsg("공유 실패");
    });
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

        {/* ── 하이라이트 클립 프리뷰 (녹화 성공 시) ───────── */}
        {clipUrl && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-white/15 bg-black">
            <video
              src={clipUrl}
              autoPlay
              loop
              muted
              playsInline
              className="aspect-[9/16] max-h-64 w-full object-contain"
            />
            <p className="bg-black/60 py-1 text-center text-[11px] text-white/70">
              🔥 점수 급상승 하이라이트
            </p>
          </div>
        )}

        {/* ── CTA ────────────────────────────────────────── */}
        <div className="mt-4 flex flex-col gap-2.5">
          <button
            onClick={handleShare}
            disabled={!scoreId}
            className="rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90 disabled:opacity-40"
          >
            {clipUrl ? "🔥 하이라이트 공유하기" : "보고서 공유하기"}
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
