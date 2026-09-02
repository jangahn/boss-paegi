import { weaponLabel } from "@/lib/report";
import { deriveStats, type GameplayStats } from "@/lib/stats";

/**
 * 플레이 스타일 페르소나("패기 유형") — "부장님 패기 인사평가" 패러디.
 * 룰베이스 결정적: 같은 플레이 = 같은 유형(즉시 계산, 종료화면 대기 0).
 * 각 매칭은 자기를 트리거한 stat(evidence)을 동봉 → "이 분석은 이 데이터에서" 신뢰감.
 * GameOverModal(클라)·/api/score(서버 저장·유형 뱃지 부여)·/share·/history(렌더) 공용.
 *
 * v2 (2026-09-02, 사용자 확정):
 *   궁극기 ≥10 → 무기 7종+(웨폰 마스터) → 최대 콤보 ≥500 → 비중 40%+ 무기 중 최고 비중 무기의 유형
 *   → 폴백(균형 잡힌 실무형). 비중 = 무기별 타격 횟수 / 총 타격(궁극기 난타 제외).
 *   무기 유형은 카테고리가 아니라 **무기 단위**(주먹/뿅망치, 싸대기/꼬집기, 책/키보드 분리).
 *   과거 유형(속전속결·투척왕·정밀타격)은 은퇴 — 표시 정의만 보존(공유/히스토리는 통계로 재계산하므로 새 룰 적용).
 */

export type PersonaDef = {
  id: string;
  /** 유형 라벨 (직책/분노유형 패러디) */
  label: string;
  emoji: string;
  /** 한 줄 해석 */
  blurb: string;
};

export const PERSONA_ULT_MIN = 10;
export const PERSONA_WEAPON_MASTER_MIN = 7;
export const PERSONA_COMBO_MIN = 500;
/** 무기 유형 진입 최소 비중(타격 횟수 기준) */
export const PERSONA_WEAPON_SHARE_MIN = 0.4;

const DEFS = {
  ult_dependent: {
    id: "ult_dependent",
    label: "궁극기 의존형",
    emoji: "💥",
    blurb: "필살기 없으면 손이 안 나가는, 한 방의 승부사.",
  },
  carpet: {
    id: "carpet",
    label: "웨폰 마스터",
    emoji: "🌪️",
    blurb: "무기고를 통째로 비운, 손에 잡히는 건 전부 무기.",
  },
  combo: {
    id: "combo",
    label: "콤보 마스터",
    emoji: "🔥",
    blurb: "끊김 없는 연타로 리듬을 탄 콤보의 지배자.",
  },
  barehand: {
    id: "barehand",
    label: "정통 맨손격투가",
    emoji: "👊",
    blurb: "도구는 사치, 주먹이 진리인 정통파.",
  },
  hammer: {
    id: "hammer",
    label: "뿅망치 처형관",
    emoji: "🔨",
    blurb: "뾱뾱 소리에 진심인, 뿅망치 한 자루로 집행하는 처형관.",
  },
  slap: {
    id: "slap",
    label: "싸대기 장인",
    emoji: "✋",
    blurb: "손바닥 하나로 상대의 고개를 돌려놓는 싸대기 장인.",
  },
  pinch: {
    id: "pinch",
    label: "볼따구 학대형",
    emoji: "🤌",
    blurb: "볼을 쥐고 늘리고 흔들며 괴롭힌, 집요한 볼따구 학대자.",
  },
  book: {
    id: "book",
    label: "독서 강요형",
    emoji: "📚",
    blurb: "책으로 때리는 게 곧 교육이라 믿는 독서 강요자.",
  },
  keyboard: {
    id: "keyboard",
    label: "키보드 워리어",
    emoji: "⌨️",
    blurb: "키보드를 말이 아니라 물리력으로 쓰는 워리어.",
  },
  sniper: {
    id: "sniper",
    label: "냉정한 저격수",
    emoji: "🔫",
    blurb: "거리 두고 비비탄으로 갈긴 원거리 처리반.",
  },
  grabber: {
    id: "grabber",
    label: "들었다 놨다형",
    emoji: "🤏",
    blurb: "상대를 통째로 집어던진 물리력의 화신.",
  },
  graffiti: {
    id: "graffiti",
    label: "낙서 테러범",
    emoji: "🖊️",
    blurb: "때리기보다 펜으로 상대의 체면을 박살낸 예술가.",
  },
  balanced: {
    id: "balanced",
    label: "균형 잡힌 실무형",
    emoji: "🎯",
    blurb: "한쪽에 치우치지 않고 골고루 두드린, 균형 잡힌 실무자.",
  },
} satisfies Record<string, PersonaDef>;

/** 활성 유형 카탈로그(판정 가능한 전부, 폴백 포함) — 유형 뱃지 패밀리의 단일 소스 */
export const PERSONA_DEFS: PersonaDef[] = Object.values(DEFS);
export const PERSONA_IDS: string[] = PERSONA_DEFS.map((d) => d.id);
/** 폴백 유형 — 유형 뱃지 디폴트에서만 비활성(어드민이 켤 수 있음) */
export const PERSONA_FALLBACK_ID = DEFS.balanced.id;

/** 은퇴 유형 — 과거 persona_id 표시 전용(판정 불가) */
export const RETIRED_PERSONA_DEFS: PersonaDef[] = [
  { id: "blitz", label: "속전속결형", emoji: "⚡", blurb: "짧고 굵게 몰아친 속전속결 해소러." },
  { id: "thrower", label: "사무용품 투척왕", emoji: "📚", blurb: "잡히는 건 다 던진 투척 챔피언." },
  { id: "precision", label: "묵직한 정밀타격형", emoji: "🥷", blurb: "한 방 한 방 묵직하게 꽂은 정밀 타격형." },
];

export function personaById(id: string): PersonaDef | undefined {
  return PERSONA_DEFS.find((d) => d.id === id) ?? RETIRED_PERSONA_DEFS.find((d) => d.id === id);
}

/** 유형 뱃지 slug 규약 — `persona_<유형id>` (뱃지 카탈로그 slug 는 불변 동결) */
export const PERSONA_BADGE_PREFIX = "persona_";
export function personaBadgeSlug(id: string): string {
  return `${PERSONA_BADGE_PREFIX}${id}`;
}
export function personaIdFromBadgeSlug(slug: string): string | null {
  return slug.startsWith(PERSONA_BADGE_PREFIX) ? slug.slice(PERSONA_BADGE_PREFIX.length) : null;
}

/** 무기 키 → 무기 유형. 은퇴 무기(paper)는 매핑 없음 → 폴백. */
const WEAPON_PERSONA: Record<string, PersonaDef> = {
  fist: DEFS.barehand,
  hammer: DEFS.hammer,
  slap: DEFS.slap,
  pinch: DEFS.pinch,
  book: DEFS.book,
  keyboard: DEFS.keyboard,
  gun: DEFS.sniper,
  grab: DEFS.grabber,
  pen: DEFS.graffiti,
};

export type Persona = PersonaDef & { evidence: string };

const pct = (x: number) => Math.round(x * 100);

/** stats → 유형. 위에서부터 첫 매칭(결정적 우선순위). */
export function matchPersona(stats: GameplayStats): Persona {
  const d = deriveStats(stats);

  if (stats.ultimateCount >= PERSONA_ULT_MIN)
    return { ...DEFS.ult_dependent, evidence: `궁극기 ${stats.ultimateCount}회 발동` };
  if (d.distinctWeapons >= PERSONA_WEAPON_MASTER_MIN)
    return { ...DEFS.carpet, evidence: `${d.distinctWeapons}종 무기 동원` };
  if (stats.maxCombo >= PERSONA_COMBO_MIN)
    return { ...DEFS.combo, evidence: `최대 콤보 x${stats.maxCombo}` };

  // 비중 40% 이상인 무기가 있으면 그중 최고 비중 무기의 유형
  const total = Object.values(stats.weaponCounts).reduce((s, n) => s + n, 0) || stats.hitCount;
  if (total > 0) {
    let topKey: string | null = null;
    let topCount = -1;
    for (const [key, n] of Object.entries(stats.weaponCounts)) {
      if (n > topCount) {
        topCount = n;
        topKey = key;
      }
    }
    const share = topKey ? topCount / total : 0;
    const def = topKey ? WEAPON_PERSONA[topKey] : undefined;
    if (topKey && def && share >= PERSONA_WEAPON_SHARE_MIN) {
      return { ...def, evidence: `${weaponLabel(topKey)} 비중 ${pct(share)}%` };
    }
  }

  return {
    ...DEFS.balanced,
    evidence: d.topWeaponByScore
      ? `주력 ${weaponLabel(d.topWeaponByScore)}`
      : `총 ${stats.hitCount.toLocaleString()}타`,
  };
}
