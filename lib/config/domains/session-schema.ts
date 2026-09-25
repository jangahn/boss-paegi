import { z } from "zod";
import type { DomainEntry } from "../registry";
import { MAX_SCORE_HARD } from "@/lib/score-limits";
import {
  BASE_SECONDS_MAX,
  BASE_SECONDS_MIN,
  MAX_PLAY_SECONDS_MAX,
  TIME_LIMIT_SECONDS_DEFAULT,
  ULTIMATE_BONUS_SECONDS_MAX,
} from "@/lib/time-limit";
import { MAX_ELAPSED_SECONDS, SESSION_LIMITS_DEFAULT, normalizeSessionLimitsInput } from "./session";

// 제한 시간 검증 schema(v1.64 분리) — zod 는 서버(getter · 레지스트리 · 어드민 저장)에서만 쓴다. 값 · 정규화는 `./session`.

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

// 게임(클라)이 시작 시 읽어 ref 로 동결 → 라이브 주입(루트 레이아웃). 서버(/api/score S11)도 같은 값을 읽는다. 공개 API 미노출.
export const sessionEntry: DomainEntry<SessionLimits> = {
  schema: sessionLimitsSchema,
  codeDefault: SESSION_LIMITS_DEFAULT,
};
