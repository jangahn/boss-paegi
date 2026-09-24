import { z } from "zod";
import type { DomainEntry } from "../registry";
import { MAX_DURATION_MS, MAX_SCORE_HARD } from "@/lib/score-limits";
import {
  BASE_SECONDS_MAX,
  BASE_SECONDS_MIN,
  MAX_PLAY_SECONDS_MAX,
  TIME_LIMIT_SECONDS_DEFAULT,
  ULTIMATE_BONUS_SECONDS_MAX,
} from "@/lib/time-limit";

// 제한 시간 도메인(구 「세션 한도」, 키 session_limits 유지) — 어드민 메뉴 「제한 시간」.
// ① 시간 규칙(v1.53): 기본 시간·최대 플레이 시간·궁극기 추가 시간 — 한 판을 카운트다운으로 끝낸다(lib/time-limit).
// ② 강제 종료(어뷰징 방지, v0.2x 부터): 최대 경과 시간(게임을 연 뒤 벽시계 — 멈춰 있어도 흐름)·최대 점수.
// Zod 상한 = 제출 clamp 상수(MAX_DURATION_MS/MAX_SCORE_HARD) → 강제종료 제출이 clamp 에서 거부되지 않음(보강#4).
export const MAX_ELAPSED_SECONDS = Math.floor(MAX_DURATION_MS / 1000); // 1800 (30분)

const timeLimitSchema = z
  .object({
    baseSeconds: z.number().int().min(BASE_SECONDS_MIN).max(BASE_SECONDS_MAX),
    maxPlaySeconds: z.number().int().min(BASE_SECONDS_MIN).max(MAX_PLAY_SECONDS_MAX),
    ultimateBonusSeconds: z.number().int().min(0).max(ULTIMATE_BONUS_SECONDS_MAX),
  })
  .refine((t) => t.maxPlaySeconds >= t.baseSeconds, {
    message: "최대 플레이 시간은 기본 시간 이상이어야 해요.",
    path: ["maxPlaySeconds"],
  })
  // 발행된 행(v4, 6/24)엔 없던 키 — 자동 충전(additive 무중단 패턴, score_config.juggle 선례).
  .default({ ...TIME_LIMIT_SECONDS_DEFAULT });

/**
 * 읽기/쓰기 공통 정규화 — 구 키 `maxPlaySeconds`(루트, 벽시계 30분)를 `maxElapsedSeconds` 로 승계한다.
 * 「최대 플레이 시간」은 v1.53 부터 제한 시간의 상한(`timeLimit.maxPlaySeconds`)을 뜻한다(용어 하나에 개념 하나).
 */
export function normalizeSessionLimitsInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const c = input as Record<string, unknown>;
  if (!("maxPlaySeconds" in c)) return input;
  const { maxPlaySeconds, ...rest } = c;
  return "maxElapsedSeconds" in rest ? rest : { ...rest, maxElapsedSeconds: maxPlaySeconds };
}

const sessionLimitsBaseSchema = z
  .object({
    maxElapsedSeconds: z.number().int().min(5).max(MAX_ELAPSED_SECONDS),
    maxScore: z.number().int().min(100).max(MAX_SCORE_HARD),
    timeLimit: timeLimitSchema,
  })
  // 벽시계 강제 종료가 정상 판(최대 플레이 시간)보다 먼저 끊으면 안 된다.
  .refine((v) => v.maxElapsedSeconds >= v.timeLimit.maxPlaySeconds, {
    message: "최대 경과 시간은 최대 플레이 시간 이상이어야 해요.",
    path: ["maxElapsedSeconds"],
  });

export const sessionLimitsSchema = z.preprocess(normalizeSessionLimitsInput, sessionLimitsBaseSchema);

export type SessionLimits = z.infer<typeof sessionLimitsBaseSchema>;

// 강제 종료 기본값 = hard cap(사실상 무제한 — 어뷰징 관측 시 낮춤), 시간 규칙 기본값 = 사용자 확정 60·120·+10.
export const SESSION_LIMITS_DEFAULT: SessionLimits = {
  maxElapsedSeconds: MAX_ELAPSED_SECONDS,
  maxScore: MAX_SCORE_HARD,
  timeLimit: { ...TIME_LIMIT_SECONDS_DEFAULT },
};

// 게임(클라)이 시작 시 읽어 ref 로 동결 → 라이브 주입(루트 레이아웃). 서버(/api/score S11)도 같은 값을 읽는다. 공개 API 미노출.
export const sessionEntry: DomainEntry<SessionLimits> = {
  schema: sessionLimitsSchema,
  codeDefault: SESSION_LIMITS_DEFAULT,
};
