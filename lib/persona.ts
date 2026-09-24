import { weaponLabel } from "@/lib/report";
import { resolveWeapon } from "@/lib/weapons";
import { deriveStats, type GameplayStats } from "@/lib/stats";
import { formatSecondsKo, reachedMaxPlay } from "@/lib/time-limit";

/**
 * 플레이 스타일 페르소나("패기 유형") — "부장님 패기 인사평가" 패러디.
 * 룰베이스 결정적: 같은 플레이 = 같은 유형(즉시 계산, 종료화면 대기 0).
 * 각 매칭은 자기를 트리거한 stat(evidence)을 동봉 → "이 분석은 이 데이터에서" 신뢰감.
 * GameOverModal(클라)·/api/score(서버 저장·유형 뱃지 부여)·/share·/history(렌더) 공용.
 *
 * v2 (2026-09-02, 사용자 확정):
 *   궁극기 ≥10 → 무기 9종(웨폰 마스터) → 최대 콤보 ≥400 → 비중 40%+ 무기 중 최고 비중 무기의 유형
 *   → 폴백(균형 잡힌 실무형). 비중 = 무기별 타격 횟수 / 총 타격(궁극기 난타 제외).
 *   무기 유형은 카테고리가 아니라 **무기 단위**(주먹/뿅망치, 싸대기/꼬집기, 책/키보드 분리).
 *   과거 유형(속전속결·투척왕·정밀타격)은 은퇴 — 표시 정의만 보존(공유/히스토리는 통계로 재계산하므로 새 룰 적용).
 * v2.1 (2026-09-03, 사용자 확정): 웨폰 마스터 7종+ → 9종(현 활성 로스터 전부. 로스터 길이 파생이 아닌 상수 — 추후 하향 여지),
 *   콤보 500 → 400, 궁극기 유형 라벨 '궁극기 의존형' → '궁극기 폭격기'(id·뱃지 slug·blurb·이모지 불변).
 * v3 (2026-09-11, 사용자 확정 — 맵별 투척 무기 12종·맵 순회 보상과 함께):
 *   궁극기 ≥10 → **맵 5곳 이상 순회(🧳 사내 투어리스트, 신설)** → 무기 10종(웨폰 마스터, 9→10: 한 맵 최대 9종이라 맵을
 *   옮겨야 도달) → 콤보 ≥400 → **투척 카테고리 비중 40%+(📚 사무용품 투척왕, 복귀 — 투척 12종 공통)** → 비중 40%+ 무기 유형
 *   (책·키보드 개별 유형은 은퇴, 표시 정의만 보존) → 폴백. 투어리스트가 웨폰 마스터보다 앞인 이유: 30일 실측에서 맵 5곳
 *   게임의 절반 이상이 무기도 많이 쓴 판이라 뒤에 두면 거의 안 나온다. 맵 수 = GameplayStats.bgVisits(맵 뱃지와 같은 소스).
 * v4 (2026-09-25, 사용자 확정 — 제한 시간 v1.53 과 함께): 궁극기 ≥10 → **이 판의 시간을 최대 플레이 시간까지 늘림
 *   (⏰ 연장근무 달인, 신설)** → 투어리스트 → … 기준은 기본 시간 + 받은 추가 시간 = 최대 플레이 시간이라 어드민 수치가
 *   바뀌어도 그대로 성립한다. 폭격기가 위인 이유: 기본값에서 궁극기 10회 판은 거의 항상 최대까지 늘린 판이라 아래에 두면
 *   폭격기가 사라진다. 제한 시간 전 판(추가 시간 필드 없음)은 해당 없음.
 */

export type PersonaDef = {
  id: string;
  /** 유형 라벨 (직책/분노유형 패러디) */
  label: string;
  emoji: string;
  /** 한 줄 해석 */
  blurb: string;
};

/**
 * 결과 카드 한 줄 규칙(v1.40, 2026-09-11 실측): `PersonaCard` 설명은 text-xs, iPhone SE(375px) 카드 안 폭 275px 에서
 * 공백·문장부호 포함 31자·한글 22자까지 한 줄(가장 긴 현행 문구 264px). 320px(SE 1세대)는 두 줄 허용.
 * `__tests__/score/persona.test.ts` 가 전 유형(은퇴 포함)에 강제한다.
 */
export const PERSONA_BLURB_MAX_CHARS = 31;
export const PERSONA_BLURB_MAX_HANGUL = 22;

export const PERSONA_ULT_MIN = 10;
/** 웨폰 마스터 — 한 맵 로스터(9칸)를 넘는 10종: 맵을 옮겨 투척 무기를 바꿔야 도달(v3). 의도적으로 상수. */
export const PERSONA_WEAPON_MASTER_MIN = 10;
/** 사내 투어리스트 — 한 판에 순회한 맵 수(6맵 중 5곳 이상, v3). */
export const PERSONA_TOURIST_MAPS_MIN = 5;
export const PERSONA_COMBO_MIN = 400;
/** 무기 유형 진입 최소 비중(타격 횟수 기준) */
export const PERSONA_WEAPON_SHARE_MIN = 0.4;

const DEFS = {
  ult_dependent: {
    id: "ult_dependent",
    label: "궁극기 폭격기",
    emoji: "💥",
    blurb: "필살기 없으면 손이 안 나가는, 한 방의 승부사.",
  },
  overtime: {
    id: "overtime",
    label: "연장근무 달인",
    emoji: "⏰",
    blurb: "칼퇴는 사치, 궁극기로 시간을 끝까지 늘린 야근러.",
  },
  tourist: {
    id: "tourist",
    label: "사내 투어리스트",
    emoji: "🧳",
    blurb: "사무실이든 회식자리든 어디서든 패고 보는 방랑자.",
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
  thrower: {
    id: "thrower",
    label: "사무용품 투척왕",
    emoji: "📚",
    blurb: "잡히는 건 다 던진 투척 챔피언.",
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
  { id: "precision", label: "묵직한 정밀타격형", emoji: "🥷", blurb: "한 방 한 방 묵직하게 꽂은 정밀 타격형." },
  // v3: 투척 12종 공통 '투척왕'(카테고리 비중)으로 통합 — 개별 무기 유형은 표시 정의만 보존
  { id: "book", label: "독서 강요형", emoji: "📚", blurb: "책으로 때리는 게 곧 교육이라 믿는 독서 강요자." },
  { id: "keyboard", label: "키보드 워리어", emoji: "⌨️", blurb: "키보드를 말이 아니라 물리력으로 쓰는 워리어." },
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

/** 무기 키 → 무기 유형(비투척). 투척 12종은 카테고리 비중으로 '투척왕'(v3) — 여기 매핑 없음. */
const WEAPON_PERSONA: Record<string, PersonaDef> = {
  fist: DEFS.barehand,
  hammer: DEFS.hammer,
  slap: DEFS.slap,
  pinch: DEFS.pinch,
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
  if (reachedMaxPlay(stats))
    return {
      ...DEFS.overtime,
      evidence: `최대 ${formatSecondsKo((stats.timeCapMs ?? 0) / 1000)}까지 연장 (+${Math.round((stats.timeBonusMs ?? 0) / 1000)}초)`,
    };
  const mapsVisited = new Set(stats.bgVisits).size;
  if (mapsVisited >= PERSONA_TOURIST_MAPS_MIN)
    return { ...DEFS.tourist, evidence: `맵 ${mapsVisited}곳 순회` };
  if (d.distinctWeapons >= PERSONA_WEAPON_MASTER_MIN)
    return { ...DEFS.carpet, evidence: `${d.distinctWeapons}종 무기 동원` };
  if (stats.maxCombo >= PERSONA_COMBO_MIN)
    return { ...DEFS.combo, evidence: `최대 콤보 x${stats.maxCombo}` };

  // 비중 40% 이상인 무기가 있으면 그중 최고 비중 무기의 유형 — 투척은 카테고리 합산(투척왕)이 먼저
  const total = Object.values(stats.weaponCounts).reduce((s, n) => s + n, 0) || stats.hitCount;
  if (total > 0) {
    const throwHits = Object.entries(stats.weaponCounts).reduce(
      (sum, [key, n]) => (resolveWeapon(key).category === "throw" ? sum + n : sum),
      0,
    );
    if (throwHits / total >= PERSONA_WEAPON_SHARE_MIN) {
      return { ...DEFS.thrower, evidence: `투척 비중 ${pct(throwHits / total)}%` };
    }
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
