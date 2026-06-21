import type { GameplayStats } from "@/lib/stats";

/**
 * 뱃지 — 패밀리×티어 ladder(단일 소스). 한 판에서 달성 가능한 업적, 룰베이스 결정적.
 * 인게임 라이브 체크리스트·획득 토스트·수집 페이지·종료/공유 strip 전부 이 데이터로 구동.
 * 궁극기 난타는 스탯에서 제외(PR: 궁극기 점수만) → 콤보/무기/타격은 순수 수동 기준.
 */

export type BadgeDef = {
  id: string;
  familyKey: string;
  familyName: string;
  emoji: string;
  /** 카드/칩 라벨 (예: "콤보 1,000") */
  label: string;
  /** 획득 조건 (획득 카드에만 노출, 미획득은 "?") */
  desc: string;
  /** 임계값 (badgeValue ≥ threshold 면 획득) */
  threshold: number;
};

type Family = {
  key: string;
  name: string;
  emoji: string;
  tiers: number[];
  /** 이 패밀리의 현재 달성값 (stats + score) */
  value: (stats: GameplayStats, score: number) => number;
  label: (t: number) => string;
  desc: (t: number) => string;
};

// 상위 티어일수록 어렵거나(전설) 사실상 불가(콤보/타격 상위는 10분 캡상 도달 불가).
const FAMILIES: Family[] = [
  {
    key: "score",
    name: "점수",
    emoji: "🏆",
    tiers: [1000, 3000, 5000, 10000, 30000, 50000, 100000, 300000, 500000, 1000000],
    value: (_s, score) => score,
    label: (t) => `${t.toLocaleString()}점`,
    desc: (t) => `총 정산 점수 ${t.toLocaleString()}점 달성`,
  },
  {
    key: "combo",
    name: "콤보",
    emoji: "🔥",
    tiers: [100, 200, 300, 500, 1000, 1500, 2000, 3000, 5000, 10000],
    value: (s) => s.maxCombo,
    label: (t) => `콤보 ${t.toLocaleString()}`,
    desc: (t) => `최대 콤보 ${t.toLocaleString()} 달성`,
  },
  {
    key: "hits",
    name: "타격",
    emoji: "👊",
    // 콤보(100·200·300·500·1k·1.5k·2k·3k·5k·10k)보다 크고 값 겹침 없게. 150~30,000.
    tiers: [150, 400, 700, 1200, 2500, 4000, 7000, 12000, 20000, 30000],
    value: (s) => s.hitCount,
    label: (t) => `${t.toLocaleString()}타`,
    desc: (t) => `한 판에 ${t.toLocaleString()}타 (궁극기 제외)`,
  },
  {
    key: "weapon",
    name: "무기",
    emoji: "🗡️",
    tiers: [2, 4, 6, 8, 9],
    value: (s) => Object.keys(s.weaponCounts).length,
    label: (t) => `무기 ${t}종`,
    desc: (t) => `한 판에 무기 ${t}종 사용`,
  },
  {
    key: "ult",
    name: "궁극기",
    emoji: "💥",
    tiers: [1, 2, 3, 5, 10, 15, 20, 30, 40, 50],
    value: (s) => s.ultimateCount,
    label: (t) => `궁극기 ${t}회`,
    desc: (t) => `한 판에 궁극기 ${t}회 발동`,
  },
  {
    key: "time",
    name: "플레이",
    emoji: "⏱️",
    tiers: [1, 2, 3, 5, 7, 10, 12, 15, 18, 20], // 분 단위 — 체크리스트 cur/goal 깔끔하게(ms 아님)
    value: (s) => Math.floor(s.durationMs / 60000),
    label: (t) => `${t}분`,
    desc: (t) => `${t}분 이상 플레이`,
  },
  {
    key: "map",
    name: "맵",
    emoji: "🗺️",
    tiers: [2, 3, 4, 5, 6],
    value: (s) => s.bgVisits.length,
    label: (t) => `맵 ${t}곳`,
    desc: (t) => `한 판에 맵 ${t}곳 순회`,
  },
];

const FAMILY_BY_KEY = new Map(FAMILIES.map((f) => [f.key, f]));

export const BADGE_DEFS: BadgeDef[] = FAMILIES.flatMap((f) =>
  f.tiers.map((t) => ({
    id: `${f.key}_${t}`,
    familyKey: f.key,
    familyName: f.name,
    emoji: f.emoji,
    label: f.label(t),
    desc: f.desc(t),
    threshold: t,
  }))
);

export const BADGE_TOTAL = BADGE_DEFS.length;

const BY_ID = new Map(BADGE_DEFS.map((d) => [d.id, d]));
/** known(현 카탈로그) id 집합 — 구 badge_id 고아를 카운트에서 제외할 때 사용. */
export const KNOWN_BADGE_IDS = new Set(BADGE_DEFS.map((d) => d.id));

/** 수집 페이지용 — 패밀리별 그룹(티어 오름차순). */
export const BADGE_FAMILIES: {
  key: string;
  name: string;
  emoji: string;
  defs: BadgeDef[];
}[] = FAMILIES.map((f) => ({
  key: f.key,
  name: f.name,
  emoji: f.emoji,
  defs: BADGE_DEFS.filter((d) => d.familyKey === f.key),
}));

export function badgeById(id: string): BadgeDef | undefined {
  return BY_ID.get(id);
}

/** 이 뱃지의 현재 달성값 (인게임 진행도·체크리스트용). */
export function badgeValue(
  def: BadgeDef,
  stats: GameplayStats,
  score: number
): number {
  return FAMILY_BY_KEY.get(def.familyKey)?.value(stats, score) ?? 0;
}

/** 이번 판 stats+score 로 달성한 뱃지 id 전체 (ladder 하위 티어 동반 획득). */
export function evaluateBadges(stats: GameplayStats, score: number): string[] {
  return BADGE_DEFS.filter((d) => badgeValue(d, stats, score) >= d.threshold).map(
    (d) => d.id
  );
}

/** 표시 압축 — 패밀리별 최고 티어 1개씩(FAMILIES 순서). 종료/공유 strip 용. */
export function summarizeBadges(ids: string[]): string[] {
  const top = new Map<string, BadgeDef>();
  for (const id of ids) {
    const def = BY_ID.get(id);
    if (!def) continue; // 고아 skip
    const cur = top.get(def.familyKey);
    if (!cur || def.threshold > cur.threshold) top.set(def.familyKey, def);
  }
  return FAMILIES.map((f) => top.get(f.key)?.id).filter(
    (x): x is string => !!x
  );
}
