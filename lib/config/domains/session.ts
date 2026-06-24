import { z } from "zod";
import type { DomainEntry } from "../registry";
import { MAX_DURATION_MS, MAX_SCORE_HARD } from "@/lib/score-limits";

// 세션 한도 도메인 — 강제 종료 트리거(최대 플레이 시간/점수). 마케터가 수치만, 메커니즘은 코드.
// Zod 상한 = 제출 clamp 상수(MAX_DURATION_MS/MAX_SCORE_HARD) → 강제종료 제출이 clamp 에서 거부되지 않음(보강#4).
export const MAX_PLAY_SECONDS = Math.floor(MAX_DURATION_MS / 1000); // 1800 (30분)

export const sessionLimitsSchema = z.object({
  maxPlaySeconds: z.number().int().min(5).max(MAX_PLAY_SECONDS),
  maxScore: z.number().int().min(100).max(MAX_SCORE_HARD),
});

export type SessionLimits = z.infer<typeof sessionLimitsSchema>;

// 기본값 = hard cap → 마케터가 낮추기 전엔 강제종료가 사실상 트리거 안 됨(현행 동작 무변경).
export const SESSION_LIMITS_DEFAULT: SessionLimits = {
  maxPlaySeconds: MAX_PLAY_SECONDS,
  maxScore: MAX_SCORE_HARD,
};

// 게임(클라)이 시작 시 읽어 ref 로 동결 → 라이브 주입(루트 레이아웃). 공개 API 미노출.
export const sessionEntry: DomainEntry<SessionLimits> = {
  schema: sessionLimitsSchema,
  codeDefault: SESSION_LIMITS_DEFAULT,
};
