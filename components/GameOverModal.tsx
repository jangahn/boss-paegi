"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { shareGameResult } from "@/lib/share";
import { clampForSubmit } from "@/lib/score-limits";
import {
  bossReaction,
  formatDuration,
  gradeFor,
  reportNo,
  weaponLabel,
} from "@/lib/report";
import { getMyProfile } from "@/lib/profile";
import { Spinner } from "@/components/Spinner";

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

  const [scoreId, setScoreId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    getMyProfile()
      .then((p) => p && setNickname(p.display_name))
      .catch(() => {});
  }, [open]);

  // 모달 열리는 순간 점수 자동 등록
  useEffect(() => {
    if (!open || scoreId || submitting || score <= 0) return;
    const durationMs = endedAt && startedAt ? endedAt - startedAt : 0;
    if (durationMs <= 0) return;

    setSubmitting(true);
    // 서버 검증과 동일 공식으로 클램프 — 한도 초과 저장 실패 방지
    const clamped = clampForSubmit(score, durationMs);
    fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        score: clamped.score,
        weapon,
        durationMs: clamped.durationMs,
        dollId,
        maxCombo,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "submit_failed");
        setScoreId(data.scoreId);
      })
      .catch((e) => setSubmitError(e.message))
      .finally(() => setSubmitting(false));
  }, [open, scoreId, submitting, score, endedAt, startedAt, weapon, dollId, maxCombo]);

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
        <div className="rounded-lg bg-[#fbfaf6] p-5 text-zinc-900 shadow-2xl">
          {/* 헤더 */}
          <div className="border-b-2 border-zinc-800 pb-3 text-center">
            <p className="text-[10px] tracking-[0.3em] text-zinc-500">
              {docNo}
            </p>
            <h2 className="mt-1 text-xl font-extrabold tracking-tight">
              스트레스 해소 결과 보고서
            </h2>
          </div>

          {/* 인형 + 결재란 */}
          <div className="mt-3 flex items-start justify-between gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={dollImageUrl ?? "/sprites/boss-default.png"}
              alt="맞은 부장님"
              className="aspect-square w-20 rounded-xl border border-zinc-300 bg-zinc-100 object-contain"
            />
            <table className="border-collapse text-center text-[10px]">
              <tbody>
                <tr>
                  <td className="w-16 border border-zinc-400 bg-zinc-100 py-0.5">
                    작성자
                  </td>
                  <td className="w-16 border border-zinc-400 py-0.5">결재</td>
                </tr>
                <tr>
                  <td className="border border-zinc-400 px-1 py-2 text-[11px] font-medium">
                    {nickname || "—"}
                  </td>
                  <td className="relative border border-zinc-400 py-2">
                    <span className="inline-block -rotate-12 rounded-full border-2 border-red-500 px-1.5 py-1 text-[9px] font-bold text-red-500">
                      해소완료
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 본문 항목 */}
          <dl className="mt-3 space-y-1.5 text-sm">
            <ReportRow label="총 정산 점수">
              <span className="text-2xl font-extrabold tabular-nums">
                {score.toLocaleString()}
              </span>
              <span className="ml-1 text-xs text-zinc-500">점</span>
            </ReportRow>
            <ReportRow label="최대 콤보">x{maxCombo}</ReportRow>
            <ReportRow label="총 타격">{hitCount.toLocaleString()}회</ReportRow>
            <ReportRow label="주력 무기">{weaponLabel(mainWeapon)}</ReportRow>
            <ReportRow label="소요 시간">{formatDuration(durationMs)}</ReportRow>
            <ReportRow label="판정 등급">
              <span className="font-bold">{grade.label}</span>
              <span className="ml-1.5 text-xs text-zinc-500">
                {grade.comment}
              </span>
            </ReportRow>
          </dl>

          {/* 부장님 피드백 */}
          <div className="mt-4 rounded-md border border-dashed border-zinc-400 bg-zinc-50 p-3">
            <p className="text-[10px] font-semibold text-zinc-500">
              피격자 의견
            </p>
            <p className="mt-0.5 text-sm font-medium">
              &ldquo;{reaction}&rdquo;
            </p>
          </div>

          {submitting && (
            <p className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-500">
              <Spinner className="h-3.5 w-3.5" /> 랭킹 등록 중...
            </p>
          )}
          {submitError && (
            <p className="mt-3 rounded-md bg-red-500/10 p-2 text-xs text-red-500">
              점수 등록 실패: {submitError}
            </p>
          )}
        </div>

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

function ReportRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-200 pb-1.5">
      <dt className="shrink-0 text-xs font-semibold text-zinc-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
