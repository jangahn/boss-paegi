"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { shareGameResult, uploadHighlightClip, saveCardHighlight } from "@/lib/share";
import { bossReaction, gradeFor, reportNo } from "@/lib/report";
import { buildGameplayStats } from "@/lib/stats";
import { matchPersona } from "@/lib/persona";
import { evaluateBadges } from "@/lib/badges";
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
  /** 클립 없을 때 카드용 급상승 메타 (timeline 기반) */
  getCardHighlight?: () => { delta: number; windowMs: number } | null;
  /** 플레이 중 들른 배경 key 목록 (해석 리포트용 — store 밖이라 page 가 전달) */
  bgVisits?: string[];
};

export function GameOverModal({
  open,
  onRestart,
  weapon,
  dollId,
  dollImageUrl,
  highlightClip,
  getCardHighlight,
  bgVisits,
}: Props) {
  const router = useRouter();
  const score = useGameStore((s) => s.score);
  const maxCombo = useGameStore((s) => s.maxCombo);
  const hitCount = useGameStore((s) => s.hitCount);
  const weaponCounts = useGameStore((s) => s.weaponCounts);
  const weaponScores = useGameStore((s) => s.weaponScores);
  const ultScore = useGameStore((s) => s.ultScore);
  const ultimateCount = useGameStore((s) => s.ultimateCount);
  const firstHitMs = useGameStore((s) => s.firstHitMs);
  const startedAt = useGameStore((s) => s.startedAt);
  const endedAt = useGameStore((s) => s.endedAt);

  // 플레이 해석 스탯 + 페르소나 — 룰베이스 즉시 계산(서버 대기 0). 저장도 같은 객체 제출.
  const gameplayStats = useMemo(
    () =>
      buildGameplayStats({
        hitCount,
        maxCombo,
        durationMs: endedAt && startedAt ? endedAt - startedAt : 0,
        weaponCounts,
        weaponScores,
        ultScore,
        ultimateCount,
        firstHitMs,
        bgVisits: bgVisits ?? [],
      }),
    [
      hitCount,
      maxCombo,
      endedAt,
      startedAt,
      weaponCounts,
      weaponScores,
      ultScore,
      ultimateCount,
      firstHitMs,
      bgVisits,
    ]
  );
  const persona = useMemo(() => matchPersona(gameplayStats), [gameplayStats]);
  // 이번 판 달성 뱃지 — 클라 즉시(서버 응답이 NEW/수집수를 채움)
  const earnedBadges = useMemo(
    () => evaluateBadges(gameplayStats, score),
    [gameplayStats, score]
  );

  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>("");

  // 점수 자동 제출(중복/0점 가드·클램프·trace 는 hook 내부)
  const { scoreId, submitting, submitError, percentile, newBadges, collectedCount } =
    useScoreSubmission({
      open,
      score,
      endedAt,
      startedAt,
      weapon,
      dollId,
      maxCombo,
      gameplayStats,
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

  // gesture 안에서 URL 즉시 공유(친구는 보통 수 초+ 뒤 열어 그때면 attach 완료).
  // 클립 업로드/카드 저장은 같은 탭의 백그라운드 — 실패해도 링크 공유는 이미 됨(불변 원칙).
  const handleShare = () => {
    if (!scoreId) return;
    const sid = scoreId;
    setShareMsg(null);
    void (async () => {
      if (clip) {
        const r = await uploadHighlightClip(sid, clip);
        if (r === "failed") {
          const h = getCardHighlight?.();
          if (h) await saveCardHighlight(sid, h);
        }
      } else {
        const h = getCardHighlight?.();
        if (h) await saveCardHighlight(sid, h);
      }
    })();
    void shareGameResult(sid, score).then((result) => {
      if (result === "shared") setShareMsg("공유했어요!");
      else if (result === "copied") setShareMsg("링크 복사됨");
      else if (result === "failed") setShareMsg("공유 실패");
    });
  };

  return (
    // 스크롤-센터: 짧으면 가운데, 길면(클립 프리뷰로 키 큼) 위→아래 전체 스크롤 도달(상단 안 잘림).
    <div className="absolute inset-0 z-20 overflow-y-auto bg-black/70 backdrop-blur-sm">
      <div className="flex min-h-full items-center justify-center px-4 py-6">
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
          persona={persona}
          percentile={percentile}
          badges={earnedBadges}
          newBadges={newBadges}
          collectedCount={collectedCount}
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
    </div>
  );
}
