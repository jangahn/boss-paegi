"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { clampForSubmit } from "@/lib/score-limits";
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
}): { scoreId: string | null; submitting: boolean; submitError: string | null } {
  const { open, score, endedAt, startedAt, weapon, dollId, maxCombo } = opts;
  const [scoreId, setScoreId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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
          }),
        })
          .then(async (r) => {
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? "submit_failed");
            setScoreId(data.scoreId);
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
  }, [open, scoreId, submitting, score, endedAt, startedAt, weapon, dollId, maxCombo]);

  return { scoreId, submitting, submitError };
}
