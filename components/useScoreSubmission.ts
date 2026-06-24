"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { clampForSubmit } from "@/lib/score-limits";
import type { GameplayStats } from "@/lib/stats";
import { log, errInfo } from "@/lib/log";

/**
 * 게임 결과 점수 자동 제출 — 모달이 열리는 순간 1회 등록(중복/0점/0초 가드).
 * 서버 검증과 동일 공식(clampForSubmit)으로 클램프해 한도 초과 저장 실패를 막고,
 * score.submit trace 로 점수/콤보/무기/플레이타임을 Explore 에서 분석 가능하게 한다.
 */
export function useScoreSubmission(opts: {
  open: boolean;
  score: number;
  endedAt: number | null;
  startedAt: number;
  weapon: string;
  dollId: string | null;
  maxCombo: number;
  /** 플레이 해석 리포트용 상세 스탯 (best-effort 저장) */
  gameplayStats: GameplayStats | null;
  /** 종료 사유 — 강제종료 분석용(scores.end_reason). 기본 normal. */
  endReason?: "normal" | "time_limit" | "score_limit";
}): {
  scoreId: string | null;
  submitting: boolean;
  submitError: string | null;
  /** 서버 산정 백분위(전체 상위 N%) — 응답 전 null */
  percentile: number | null;
  /** 이번 제출로 새로 획득한 뱃지 id */
  newBadges: string[];
  /** 누적 수집 뱃지 수 */
  collectedCount: number;
} {
  const {
    open,
    score,
    endedAt,
    startedAt,
    weapon,
    dollId,
    maxCombo,
    gameplayStats,
    endReason = "normal",
  } = opts;
  const [scoreId, setScoreId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [percentile, setPercentile] = useState<number | null>(null);
  const [newBadges, setNewBadges] = useState<string[]>([]);
  const [collectedCount, setCollectedCount] = useState(0);

  // 모달 열리는 순간 점수 자동 등록
  useEffect(() => {
    if (!open || scoreId || submitting || score <= 0) return;
    const durationMs = endedAt && startedAt ? endedAt - startedAt : 0;
    if (durationMs <= 0) return;

    setSubmitting(true);
    // 서버 검증과 동일 공식으로 클램프 — 한도 초과 저장 실패 방지
    const clamped = clampForSubmit(score, durationMs);
    // 점수 제출 trace(score/maxCombo/weapon/durationMs attribute) → Explore 에서 분석.
    void Sentry.startSpan(
      {
        name: "score.submit",
        op: "http.client",
        attributes: {
          score: clamped.score,
          maxCombo,
          weapon,
          durationMs: clamped.durationMs,
          dollId: dollId ?? "default",
        },
      },
      () =>
        fetch("/api/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            score: clamped.score,
            weapon,
            durationMs: clamped.durationMs,
            dollId,
            maxCombo,
            gameplayStats,
            endReason,
          }),
        })
          .then(async (r) => {
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? "submit_failed");
            setScoreId(data.scoreId);
            // 부가 리포트(best-effort) — 없으면 기본값 유지
            if (typeof data.percentile === "number") setPercentile(data.percentile);
            if (Array.isArray(data.newBadges)) setNewBadges(data.newBadges);
            if (typeof data.collectedCount === "number")
              setCollectedCount(data.collectedCount);
          })
          .catch((e) => {
            log.warn("score.client_submit_fail", {
              score: clamped.score,
              ...errInfo(e),
            });
            setSubmitError(e.message);
          })
          .finally(() => setSubmitting(false))
    );
    // gameplayStats 는 제출 1회 가드(scoreId/submitting) 안에서만 쓰이므로 identity 변동 무해.
  }, [open, scoreId, submitting, score, endedAt, startedAt, weapon, dollId, maxCombo, gameplayStats, endReason]);

  return { scoreId, submitting, submitError, percentile, newBadges, collectedCount };
}
