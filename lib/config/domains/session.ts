import type { SessionLimits } from "./session-schema";
import { MAX_DURATION_MS, MAX_SCORE_HARD } from "@/lib/score-limits";
import { TIME_LIMIT_SECONDS_DEFAULT } from "@/lib/time-limit";

// 제한 시간 도메인(구 「세션 한도」, 키 session_limits 유지) — 어드민 메뉴 「제한 시간」.
// ① 시간 규칙(v1.53): 기본 시간·최대 플레이 시간·궁극기 추가 시간 — 한 판을 카운트다운으로 끝낸다(lib/time-limit).
// ② 강제 종료(어뷰징 방지, v0.2x 부터): 최대 경과 시간(게임을 연 뒤 벽시계 — 멈춰 있어도 흐름)·최대 점수.
// Zod 상한 = 제출 clamp 상수(MAX_DURATION_MS/MAX_SCORE_HARD) → 강제종료 제출이 clamp 에서 거부되지 않음(보강#4).
// 검증 schema(zod)는 `./session-schema` — 이 모듈은 플레이 클라 번들에 들어가 zod 를 끌어오지 않는다(v1.64).

export type { SessionLimits };

export const MAX_ELAPSED_SECONDS = Math.floor(MAX_DURATION_MS / 1000); // 1800 (30분)

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

// 강제 종료 기본값 = hard cap(사실상 무제한 — 어뷰징 관측 시 낮춤), 시간 규칙 기본값 = 사용자 확정 60·120·+10.
export const SESSION_LIMITS_DEFAULT: SessionLimits = {
  maxElapsedSeconds: MAX_ELAPSED_SECONDS,
  maxScore: MAX_SCORE_HARD,
  timeLimit: { ...TIME_LIMIT_SECONDS_DEFAULT },
};
