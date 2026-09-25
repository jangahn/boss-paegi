import type { ScoreConfig } from "./score-schema";
import { PLAYER_GRADES } from "@/lib/report";
import { SCORE_THRESHOLDS_DEFAULT, TIER_COUNT } from "@/lib/score-tiers";
import { JUGGLE_SECONDS_DEFAULT } from "@/lib/game-tuning";

// 점수 설정 도메인 — 5단계 구간 **경계(thresholds)** + 등급 라벨/한 줄 평(=마케팅 '패기 유형') 라이브 편집.
// 단계 개수(5)는 코드 고정(lib/score-tiers TIER_COUNT). 경계는 라벨과 같은 **라이브** 값 — 바꾸면 과거 판의
// 등급·피격 반응·어드민 「점수 구간 분포」가 새 경계로 재계산된다(스냅샷 아님). 공유·유입 분석 score_tier 만
// 공유 시점 인덱스(각주 고지).
// 검증 schema(zod · 경계 · 창 초수 범위)는 `./score-schema` — 이 모듈은 클라 번들(종료 화면 · 플레이)에 들어가 zod 를 끌어오지 않는다(v1.64).

export type { ScoreConfig };

/**
 * 결과 보고서 한 줄 규칙(v1.57, iPhone SE 375 실측) — 등급 이름은 종료 화면 「다음 등급」 줄(남은 점수 5~6자리와 함께)에서
 * 한글 15자까지(실측 16), 한 줄 평은 판정 등급 줄 아래 전체 폭(303px, text-xs)에서 공백 · 문장부호 포함 34자 · 한글 28자까지
 * (실측 35 · 29) 한 줄. 넘기면 어드민 편집기가 경고만 한다 — 발행은 막지 않고 스키마 상한(20자 · 40자)도 그대로.
 */
export const GRADE_LABEL_ONE_LINE_MAX_HANGUL = 15;
export const GRADE_COMMENT_ONE_LINE_MAX_CHARS = 34;
export const GRADE_COMMENT_ONE_LINE_MAX_HANGUL = 28;

const hangulCount = (s: string) => (s.match(/[가-힣]/g) ?? []).length;

/** 등급 이름 · 한 줄 평이 375px 한 줄 규칙 안인지(편집기 경고 · 코드 기본값 테스트 공용). */
export function gradeFitsOneLine(g: { label: string; comment: string }): { label: boolean; comment: boolean } {
  const comment = g.comment.trim();
  return {
    label: hangulCount(g.label.trim()) <= GRADE_LABEL_ONE_LINE_MAX_HANGUL,
    comment:
      comment.length <= GRADE_COMMENT_ONE_LINE_MAX_CHARS && hangulCount(comment) <= GRADE_COMMENT_ONE_LINE_MAX_HANGUL,
  };
}

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

// 코드 기본값 = PLAYER_GRADES(발행 v10 확정 라벨과 동일) + 기본 경계(미시드 폴백).
export const SCORE_CONFIG_DEFAULT: ScoreConfig = {
  thresholds: [...SCORE_THRESHOLDS_DEFAULT],
  grades: PLAYER_GRADES.map((g) => ({ label: g.label, comment: g.comment })),
  juggle: { ...JUGGLE_SECONDS_DEFAULT },
};
