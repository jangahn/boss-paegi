import { scoreTier, TIER_COUNT, type ScoreTierConfig } from "@/lib/score-tiers";
import { SCORE_TIER_CONFIG_DEFAULT } from "@/lib/report";
import type { RoleId } from "@/lib/roles";
import { roleFrom, roleVoice, type RoleConfig } from "@/lib/config/domains/roles";
import { DEFAULT_GENDER, type Gender } from "@/lib/gender";

/**
 * 캐릭터 시비 멘트. 게임 진행 중 주기적으로 말풍선으로 노출 — 패고 싶게 만드는 게 목적.
 * 롤별 멘트는 role_content(점수 5단계 = scoreTier 공유, 경계는 score_config). 비방·욕설 의도적 제외(정책).
 */

/**
 * 점수대(5단계) + 롤×성별에 맞는 시비 멘트 랜덤 선택.
 * 해당 단계 풀 + 직전 멘트 제외. role 미지정 시 boss, gender 미지정 시 male, cfg 미지정 시 코드 기본값(경계·콘텐츠).
 */
export function randomTaunt(opts: {
  score: number;
  exclude?: string;
  role?: RoleId;
  gender?: Gender;
  roleCfg?: RoleConfig;
  scoreCfg?: ScoreTierConfig;
}): string {
  const { score, exclude, role = "boss", gender = DEFAULT_GENDER, roleCfg, scoreCfg = SCORE_TIER_CONFIG_DEFAULT } = opts;
  const tier = Math.min(TIER_COUNT - 1, scoreTier(score, scoreCfg.thresholds));
  const pool = roleVoice(roleFrom(role, roleCfg), gender).taunts[tier];
  let candidate = pool[Math.floor(Math.random() * pool.length)];
  if (exclude && candidate === exclude && pool.length > 1) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
  }
  return candidate;
}
