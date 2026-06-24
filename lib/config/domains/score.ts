import { z } from "zod";
import type { DomainEntry } from "../registry";
import { PLAYER_GRADES, type ReportGrade } from "@/lib/report";

// 점수 설정 도메인 — 현재는 등급 라벨/코멘트 10단계(=마케팅 '패기 유형')만 라이브 편집.
// tier 매핑(scoreTier)·간격(step)·개수(10)는 코드 고정(엔지니어). step 조절+동결은 후속(play_sessions와 함께).
const grade = z.object({
  label: z.string().trim().min(1).max(20),
  comment: z.string().trim().min(1).max(40),
});

export const scoreConfigSchema = z.object({
  // 정확히 10단계(0~9,999 … 90,000+). 라벨 텍스트는 라이브, tier 인덱스는 고정.
  grades: z.array(grade).length(10),
});

export type ScoreConfig = z.infer<typeof scoreConfigSchema>;

// 코드 기본값 = 현 PLAYER_GRADES(byte-identical, 미시드 폴백).
export const SCORE_CONFIG_DEFAULT: ScoreConfig = {
  grades: PLAYER_GRADES.map((g: ReportGrade) => ({ label: g.label, comment: g.comment })),
};

// 클라(GameOverModal)+서버(share/history) 소비 → 라이브 주입(루트 레이아웃). 공개 API 미노출.
export const scoreEntry: DomainEntry<ScoreConfig> = {
  schema: scoreConfigSchema,
  codeDefault: SCORE_CONFIG_DEFAULT,
};
