import { deriveStats, type GameplayStats } from "@/lib/stats";

/**
 * 뱃지 — 단일 게임에서 달성 가능한 업적(룰베이스 결정적). 수집 동기부여 + 공유 자랑.
 * 이번 판 달성 = `evaluateBadges`(클라/서버 공용 순수함수). 누적 수집은 user_badges(owner_id).
 */

export type BadgeDef = {
  id: string;
  label: string;
  emoji: string;
  desc: string;
};

const DEFS = {
  score_100: { id: "score_100", label: "세 자리", emoji: "💯", desc: "100점 돌파" },
  score_1k: { id: "score_1k", label: "네 자리", emoji: "🔢", desc: "1,000점 돌파" },
  score_10k: { id: "score_10k", label: "다섯 자리", emoji: "🏆", desc: "10,000점 돌파" },
  combo_30: { id: "combo_30", label: "콤보 30", emoji: "🔥", desc: "최대 콤보 30" },
  combo_50: { id: "combo_50", label: "콤보 50", emoji: "⚡", desc: "최대 콤보 50" },
  weapon_5: { id: "weapon_5", label: "무기상", emoji: "🧰", desc: "한 판에 무기 5종" },
  weapon_all: { id: "weapon_all", label: "무기고 정복", emoji: "🗡️", desc: "한 판에 무기 9종 전부" },
  category_all: { id: "category_all", label: "만능 패기", emoji: "🎛️", desc: "한 판에 6개 조작 전부" },
  ult_master: { id: "ult_master", label: "궁극기 마스터", emoji: "💥", desc: "궁극기 3회 발동" },
  minute: { id: "minute", label: "장기전", emoji: "⏱️", desc: "1분 이상 플레이" },
  map_all: { id: "map_all", label: "전국 투어", emoji: "🗺️", desc: "한 판에 6개 맵 전부" },
} satisfies Record<string, BadgeDef>;

export const BADGE_DEFS: BadgeDef[] = Object.values(DEFS);
export const BADGE_TOTAL = BADGE_DEFS.length;

export function badgeById(id: string): BadgeDef | undefined {
  return (DEFS as Record<string, BadgeDef>)[id];
}

/** 이번 판 stats+score 로 달성한 뱃지 id 목록 (결정적). */
export function evaluateBadges(stats: GameplayStats, score: number): string[] {
  const d = deriveStats(stats);
  const out: string[] = [];
  if (score >= 100) out.push("score_100");
  if (score >= 1000) out.push("score_1k");
  if (score >= 10000) out.push("score_10k");
  if (stats.maxCombo >= 30) out.push("combo_30");
  if (stats.maxCombo >= 50) out.push("combo_50");
  if (d.distinctWeapons >= 5) out.push("weapon_5");
  if (d.distinctWeapons >= 9) out.push("weapon_all");
  if (d.distinctCategories >= 6) out.push("category_all");
  if (stats.ultimateCount >= 3) out.push("ult_master");
  if (stats.durationMs >= 60000) out.push("minute");
  if (stats.bgVisits.length >= 6) out.push("map_all");
  return out;
}
