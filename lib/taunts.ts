import { scoreTier, TIER_COUNT } from "@/lib/report";
import { getRoleContent, type RoleId } from "@/lib/roles";

/**
 * 캐릭터 시비 멘트. 게임 진행 중 주기적으로 말풍선으로 노출 — 패고 싶게 만드는 게 목적.
 * 롤별 멘트는 lib/roles 레지스트리(점수 10단계 = scoreTier 공유). 비방·욕설 의도적 제외(정책).
 */

/** 피격 시 짧게 반응하는 멘트 (롤 중립 — 짧고 격앙) */
export const HIT_REACTIONS: readonly string[] = [
  "윽!",
  "야!",
  "그만!",
  "이게 뭐 하는 짓이야!",
  "어디 감히!",
  "너 이리 와!",
  "아얏!",
  "커헉!",
] as const;

/** 하위호환 — 부장 전체 풀 (점수/롤 모름 호출용) */
export const TAUNTS: readonly string[] = getRoleContent("boss").taunts.flat();

/**
 * 점수대(10단계) + 롤에 맞는 시비 멘트 랜덤 선택.
 * 해당 단계 풀 + 직전 멘트 제외. score 미지정 시 0단계, role 미지정 시 boss.
 */
export function randomTaunt(exclude?: string, score = 0, role: RoleId = "boss"): string {
  const tier = Math.min(TIER_COUNT - 1, scoreTier(score));
  const pool = getRoleContent(role).taunts[tier];
  let candidate = pool[Math.floor(Math.random() * pool.length)];
  if (exclude && candidate === exclude && pool.length > 1) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
  }
  return candidate;
}
