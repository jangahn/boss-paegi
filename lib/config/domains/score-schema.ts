import { z } from "zod";
import type { DomainEntry } from "../registry";
import { isValidThresholds, SCORE_THRESHOLDS_DEFAULT, THRESHOLD_STEP, TIER_COUNT } from "@/lib/score-tiers";
import { MAX_SCORE_HARD } from "@/lib/score-limits";
import {
  COMBO_WINDOW_SEC_MAX,
  COMBO_WINDOW_SEC_MIN,
  JUGGLE_SECONDS_DEFAULT,
  JUGGLE_WINDOW_SEC_MAX,
  JUGGLE_WINDOW_SEC_MIN,
} from "@/lib/game-tuning";
import { SCORE_CONFIG_DEFAULT, normalizeScoreConfigInput } from "./score";

// 점수 설정 검증 schema(v1.64 분리) — zod 는 서버(getter · 레지스트리 · 어드민 저장)에서만 쓴다. 값 · 정규화 · 한 줄 규칙은 `./score`.

const grade = z.object({
  label: z.string().trim().min(1).max(20),
  comment: z.string().trim().min(1).max(40),
});

const thresholds = z
  .array(z.number().int().min(THRESHOLD_STEP).max(MAX_SCORE_HARD))
  .length(TIER_COUNT - 1)
  .refine((t) => isValidThresholds(t, THRESHOLD_STEP, MAX_SCORE_HARD), {
    message: `구간 경계는 ${TIER_COUNT - 1}개, ${THRESHOLD_STEP.toLocaleString()}점 단위, 엄격 오름차순이어야 해요.`,
  })
  // 발행된 행(v10)엔 없던 키 — 자동 충전(additive 무중단 패턴).
  .default([...SCORE_THRESHOLDS_DEFAULT]);

/** 변경 보너스·콤보 창 초수(v1.36) — 배율 표는 코드(lib/game-tuning), 어드민은 초수만. 발행행에 없던 키는 기본값 충전(additive). */
const juggle = z
  .object({
    weaponWindowSec: z.number().int().min(JUGGLE_WINDOW_SEC_MIN).max(JUGGLE_WINDOW_SEC_MAX),
    mapWindowSec: z.number().int().min(JUGGLE_WINDOW_SEC_MIN).max(JUGGLE_WINDOW_SEC_MAX),
    comboWindowSec: z.number().min(COMBO_WINDOW_SEC_MIN).max(COMBO_WINDOW_SEC_MAX),
  })
  .default({ ...JUGGLE_SECONDS_DEFAULT });
const scoreConfigBaseSchema = z.object({
  thresholds,
  // 정확히 5단계. 라벨 텍스트는 라이브, tier 인덱스는 고정.
  grades: z.array(grade).length(TIER_COUNT),
  juggle,
});

export const scoreConfigSchema = z.preprocess(normalizeScoreConfigInput, scoreConfigBaseSchema);

export type ScoreConfig = z.infer<typeof scoreConfigBaseSchema>;

// 클라(GameOverModal·플레이 말풍선)+서버(share/history/OG·어드민 분포) 소비 → 라이브 주입(루트 레이아웃). 공개 API 미노출.
export const scoreEntry: DomainEntry<ScoreConfig> = {
  schema: scoreConfigSchema,
  codeDefault: SCORE_CONFIG_DEFAULT,
};
