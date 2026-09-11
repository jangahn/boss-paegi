import { z } from "zod";
import type { DomainEntry } from "../registry";
import { PLAYER_GRADES } from "@/lib/report";
import {
  isValidThresholds,
  SCORE_THRESHOLDS_DEFAULT,
  THRESHOLD_STEP,
  TIER_COUNT,
} from "@/lib/score-tiers";
import { MAX_SCORE_HARD } from "@/lib/score-limits";
import {
  COMBO_WINDOW_SEC_MAX,
  COMBO_WINDOW_SEC_MIN,
  JUGGLE_SECONDS_DEFAULT,
  JUGGLE_WINDOW_SEC_MAX,
  JUGGLE_WINDOW_SEC_MIN,
} from "@/lib/game-tuning";

// 점수 설정 도메인 — 5단계 구간 **경계(thresholds)** + 등급 라벨/한 줄 평(=마케팅 '패기 유형') 라이브 편집.
// 단계 개수(5)는 코드 고정(lib/score-tiers TIER_COUNT). 경계는 라벨과 같은 **라이브** 값 — 바꾸면 과거 판의
// 등급·피격 반응·어드민 「점수 구간 분포」가 새 경계로 재계산된다(스냅샷 아님). 공유·유입 분석 score_tier 만
// 공유 시점 인덱스(각주 고지).
const grade = z.object({
  label: z.string().trim().min(1).max(20),
  comment: z.string().trim().min(1).max(40),
});

/** 구 10단계 발행행(v1.23 이전) → 5단계: 사용자 확정 매핑 — 눈치보는 신입·마음만 퇴사자·키보드 워리어·빌런 심판관·전설의 퇴사자. */
export const LEGACY_GRADE_PICK = [0, 1, 5, 7, 9] as const;

/** 읽기/쓰기 공통 정규화 — 구 10등급 행은 확정 인덱스로 5개 선택, 그 외는 통과(스키마가 판정). thresholds 부재는 .default 가 충전. */
export function normalizeScoreConfigInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const c = input as { grades?: unknown };
  if (Array.isArray(c.grades) && c.grades.length === TIER_COUNT * 2) {
    const legacy = c.grades as unknown[];
    return { ...c, grades: LEGACY_GRADE_PICK.map((i) => legacy[i]) };
  }
  return input;
}

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

// 코드 기본값 = PLAYER_GRADES(발행 v10 확정 라벨과 동일) + 기본 경계(미시드 폴백).
export const SCORE_CONFIG_DEFAULT: ScoreConfig = {
  thresholds: [...SCORE_THRESHOLDS_DEFAULT],
  grades: PLAYER_GRADES.map((g) => ({ label: g.label, comment: g.comment })),
  juggle: { ...JUGGLE_SECONDS_DEFAULT },
};

// 클라(GameOverModal·플레이 말풍선)+서버(share/history/OG·어드민 분포) 소비 → 라이브 주입(루트 레이아웃). 공개 API 미노출.
export const scoreEntry: DomainEntry<ScoreConfig> = {
  schema: scoreConfigSchema,
  codeDefault: SCORE_CONFIG_DEFAULT,
};
