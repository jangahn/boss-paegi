"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { clampForSubmit } from "@/lib/score-limits";
import type { GameplayStats } from "@/lib/stats";
import { log, errInfo } from "@/lib/log";
import { ensureAuth } from "@/lib/auth-client";
import {
  submitScoreWithOutbox,
  type ScoreOutboxEntry,
  type ScoreSubmissionAck,
} from "@/lib/score-outbox";
import {
  SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS,
  elapsedScoreDurationMs,
  scoreSubmissionIdentityForGame,
  scoreSubmissionRetryDelayMs,
  type ScoreSubmissionIdentity,
} from "@/lib/score-retry";
import {
  firstTouchSourceForConversion,
  shouldSendPlayConversion,
  markPlayConversionSent,
} from "@/lib/acquisition";

export type ScoreSubmissionHookDependencies = {
  resolveOwnerId: () => Promise<string>;
  submit: (entry: ScoreOutboxEntry) => Promise<ScoreSubmissionAck>;
  mintSubmissionId: () => string;
  now: () => number;
};

const DEFAULT_SCORE_SUBMISSION_DEPENDENCIES: ScoreSubmissionHookDependencies = {
  resolveOwnerId: async () => (await ensureAuth()).user.id,
  submit: submitScoreWithOutbox,
  mintSubmissionId: () => crypto.randomUUID(),
  now: Date.now,
};

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
  /** 텔레메트리 세션 링크(scores.telemetry_session_id, additive). 없으면 미전송. */
  telemetrySessionId?: string | null;
}, dependencies: ScoreSubmissionHookDependencies =
  DEFAULT_SCORE_SUBMISSION_DEPENDENCIES): {
  scoreId: string | null;
  submitting: boolean;
  submitError: string | null;
  /** 서버 산정 백분위(전체 상위 N%) — 응답 전 null */
  percentile: number | null;
  /** 이번 제출로 새로 획득한 뱃지 id */
  newBadges: string[];
  /** 누적 수집 뱃지 수 */
  collectedCount: number;
  /** 서버 판정 — registered(정상 반영) | pending | voided. null=응답 전. 어뷰징 의심이면 pending/voided. */
  reviewStatus: string | null;
  /** 자동 재시도 소진 뒤 같은 submissionId로 다시 시도. */
  retrySubmission: () => void;
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
    telemetrySessionId = null,
  } = opts;
  const {
    resolveOwnerId,
    submit,
    mintSubmissionId,
    now,
  } = dependencies;
  const [scoreId, setScoreId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [percentile, setPercentile] = useState<number | null>(null);
  const [newBadges, setNewBadges] = useState<string[]>([]);
  const [collectedCount, setCollectedCount] = useState(0);
  const [reviewStatus, setReviewStatus] = useState<string | null>(null);
  const submissionRef = useRef<ScoreSubmissionIdentity | null>(null);
  const wasOpenRef = useRef(false);
  const mountedRef = useRef(false);
  const inFlightSubmissionIdRef = useRef<string | null>(null);
  const attemptsRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const retrySubmission = useCallback(() => {
    if (!mountedRef.current) return;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    attemptsRef.current = 0;
    setSubmitError(null);
    setRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    // StrictMode의 setup→cleanup→setup probe 뒤에도 live 상태를 복원한다.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  // 모달 열리는 순간 점수 자동 등록
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      return;
    }
    if (score <= 0) return;
    const durationMs = elapsedScoreDurationMs(startedAt, endedAt);
    if (durationMs <= 0) return;

    // 모달 open cycle이 판 경계이고 startedAt 변화가 추가 안전망이다. 브라우저의
    // 저정밀 timer가 두 판에 같은 값을 줘도 새 key를 만들며, 같은 open cycle의
    // HTTP/report 재시도는 항상 동일 submissionId를 재사용한다.
    const openedNewResult = !wasOpenRef.current;
    wasOpenRef.current = true;
    const isNewGame =
      openedNewResult || submissionRef.current?.startedAt !== startedAt;
    if (isNewGame) {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      submissionRef.current = scoreSubmissionIdentityForGame(
        submissionRef.current,
        startedAt,
        mintSubmissionId,
        openedNewResult,
      );
      attemptsRef.current = 0;
      inFlightSubmissionIdRef.current = null;
      setScoreId(null);
      setSubmitting(false);
      setSubmitError(null);
      setPercentile(null);
      setNewBadges([]);
      setCollectedCount(0);
      setReviewStatus(null);
    }
    const identity = submissionRef.current;
    if (!identity) return;
    const submissionId = identity.submissionId;
    if (
      (!isNewGame && scoreId) ||
      inFlightSubmissionIdRef.current === submissionId ||
      attemptsRef.current >= SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS
    ) {
      return;
    }
    const attempt = attemptsRef.current + 1;
    attemptsRef.current = attempt;
    inFlightSubmissionIdRef.current = submissionId;
    setSubmitting(true);
    setSubmitError(null);
    // 서버 검증과 동일 공식으로 클램프 — 한도 초과 저장 실패 방지
    const clamped = clampForSubmit(score, durationMs);
    // 방문→플레이 전환(분석) — first-touch 당 1회. source 동봉(SSR·봇 게이트면 null → 서버 미적재, 방문 비콘과 대칭).
    const sendPlayConv = shouldSendPlayConversion();
    const acqSource = sendPlayConv ? firstTouchSourceForConversion() : null;
    const trackFirstTouchPlay = sendPlayConv && !!acqSource;
    const requestBody = {
      score: clamped.score,
      weapon,
      durationMs: clamped.durationMs,
      dollId,
      maxCombo,
      gameplayStats,
      endReason,
      telemetrySessionId,
      submissionId,
      trackFirstTouchPlay,
      acqSource,
    };
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
        resolveOwnerId()
          .then((ownerId) =>
            submit({
              ownerId,
              startedAt,
              submissionId,
              createdAt: now(),
              body: requestBody,
            }),
          )
          .then((data) => {
            if (submissionRef.current?.submissionId !== submissionId) return;
            // 서버가 first-touch를 반영했다면 언마운트 여부와 무관하게 로컬 중복
            // 방지 표식을 남긴다. React state만 mounted lifecycle로 차단한다.
            if (trackFirstTouchPlay) markPlayConversionSent();
            if (!mountedRef.current) return;
            setScoreId(data.scoreId);
            if (typeof data.reviewStatus === "string") setReviewStatus(data.reviewStatus);
            // 부가 리포트(best-effort) — 없으면 기본값 유지
            if (typeof data.percentile === "number") setPercentile(data.percentile);
            if (Array.isArray(data.newBadges)) setNewBadges(data.newBadges);
            if (typeof data.collectedCount === "number")
              setCollectedCount(data.collectedCount);
          })
          .catch((e) => {
            if (
              submissionRef.current?.submissionId !== submissionId ||
              !mountedRef.current
            ) {
              return;
            }
            log.warn("score.client_submit_fail", {
              score: clamped.score,
              attempt,
              ...errInfo(e),
            });
            setSubmitError(e.message);
            const delay = scoreSubmissionRetryDelayMs(attempt);
            if (delay !== null) {
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                if (
                  mountedRef.current &&
                  submissionRef.current?.submissionId === submissionId
                ) {
                  setRetryToken((token) => token + 1);
                }
              }, delay);
            }
          })
          .finally(() => {
            if (inFlightSubmissionIdRef.current === submissionId) {
              inFlightSubmissionIdRef.current = null;
              if (
                mountedRef.current &&
                submissionRef.current?.submissionId === submissionId
              ) {
                setSubmitting(false);
              }
            }
          })
    );
  }, [
    open,
    scoreId,
    score,
    endedAt,
    startedAt,
    weapon,
    dollId,
    maxCombo,
    gameplayStats,
    endReason,
    telemetrySessionId,
    retryToken,
    resolveOwnerId,
    submit,
    mintSubmissionId,
    now,
  ]);

  return {
    scoreId,
    submitting,
    submitError,
    percentile,
    newBadges,
    collectedCount,
    reviewStatus,
    retrySubmission,
  };
}
