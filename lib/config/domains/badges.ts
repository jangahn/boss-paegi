import type { BadgeCatalog, CatalogBadge, CatalogFamily } from "./badges-schema";
import { buildGameplayStats, type GameplayStats } from "@/lib/stats";
import type { PlayTotals } from "@/lib/play-totals";
import {
  PERSONA_DEFS,
  PERSONA_FALLBACK_ID,
  matchPersona,
  personaBadgeSlug,
} from "@/lib/persona";

/**
 * 뱃지 카탈로그 도메인 — 마케터가 임계값(수치)·개수·라벨·활성 편집. 카테고리(패밀리)는 8종 고정,
 * 각 패밀리의 **달성값 계산 함수와 기준(누적·한 판·유형)은 코드**(FAMILY_VALUE·FAMILY_BASIS). slug 는 **불변 동결**
 * (threshold 파싱 안 함) → 임계값 바꿔도 user_badges 고아 없음. 삭제 대신 active=false(획득 표시 보존).
 * 인증 grant(/api/score)·컬렉션·챌린지가 이 카탈로그로 구동.
 * v1.55(2026-09-25 사용자 결정 A): 👊 타격 · 💥 궁극기 · ⏱️ 플레이 = 누적(내 모든 판 합계, 0132 합계 RPC).
 * 제한 시간(v1.53) 한 판으로는 닿을 수 없는 tier 가 생겨서다. 한 판 기준으로 이미 딴 뱃지는 누적 조건도 충족한다.
 * 검증 schema(zod)는 `./badges-schema` — 이 모듈은 클라 번들(컬렉션 · 챌린지 · 종료 화면)에 들어가 zod 를 끌어오지 않는다(v1.64).
 */

export type { BadgeCatalog, CatalogBadge, CatalogFamily };

export const BADGE_FAMILY_KEYS = [
  "score",
  "combo",
  "hits",
  "weapon",
  "ult",
  "time",
  "map",
  "persona",
] as const;
/**
 * 유형(persona) 패밀리 — 임계값이 아니라 "이 판의 유형 == 뱃지의 유형"으로 평가(2026-09-02 v1.13).
 * 행은 코드의 유형 정의(lib/persona.ts)에서 1:1 파생되는 고정 집합: 어드민은 추가·삭제·임계·라벨 편집
 * 불가, **active(부여 대상)만** 편집. 디폴트는 폴백 유형만 비활성. 저장된 구 카탈로그는 읽기 시
 * normalizeBadgeCatalogInput 이 유형 패밀리/행을 편입해 어드민 편집(다른 패밀리)을 잃지 않는다.
 */
export const PERSONA_FAMILY_KEY = "persona" as const;
export const PERSONA_FAMILY_DEFAULT = { key: PERSONA_FAMILY_KEY, name: "유형", emoji: "🎭" } as const;
export type BadgeFamilyKey = (typeof BADGE_FAMILY_KEYS)[number];

/** 카테고리 기준(코드 고정, 어드민 표시) — 누적 = 내 모든 판 합계 · 한 판 = 그 판 하나 · 유형 = 이 판의 유형 판정. */
export type FamilyBasis = "cumulative" | "game" | "persona";
export const FAMILY_BASIS: Record<BadgeFamilyKey, FamilyBasis> = {
  score: "game",
  combo: "game",
  hits: "cumulative",
  weapon: "game",
  ult: "cumulative",
  time: "cumulative",
  map: "game",
  persona: "persona",
};

/** 이 판의 플레이 시간 — 제한 시간(v1.53) 판은 playMs(첫 타격부터, 멈춘 구간 제외), 그 전 판은 소요 시간. 0132 합계와 같은 규칙. */
export function gamePlayMs(s: GameplayStats): number {
  return s.playMs ?? s.durationMs;
}

// 패밀리별 달성값(코드 — 마케터 편집 불가). familyKey → (stats,score,이전 합계)→value. 누적 = 이전 합계 + 이 판.
export const FAMILY_VALUE: Record<
  BadgeFamilyKey,
  (s: GameplayStats, score: number, totals: PlayTotals) => number
> = {
  score: (_s, score) => score,
  combo: (s) => s.maxCombo,
  hits: (s, _score, t) => t.hits + s.hitCount,
  weapon: (s) => Object.keys(s.weaponCounts).length,
  ult: (s, _score, t) => t.ultimates + s.ultimateCount,
  time: (s, _score, t) => (t.playMs + gamePlayMs(s)) / 60000,
  map: (s) => s.bgVisits.length,
  // 유형은 뱃지별 매칭(evaluateBadges 특례) — 패밀리 단일 달성값 개념 없음
  persona: () => 0,
};

type RawBadge = { slug?: unknown; familyKey?: unknown; active?: unknown; threshold?: unknown };

/** 유형 뱃지 고정 행 — 라벨·설명은 유형 정의를 그대로 비춤(단일 소스), active 만 저장값 존중 */
function personaBadgeRows(stored: RawBadge[]): CatalogBadge[] {
  const storedActive = new Map<string, boolean>();
  for (const b of stored) {
    if (typeof b.slug === "string" && typeof b.active === "boolean") storedActive.set(b.slug, b.active);
  }
  return PERSONA_DEFS.map((d) => {
    const slug = personaBadgeSlug(d.id);
    return {
      slug,
      familyKey: PERSONA_FAMILY_KEY,
      threshold: 0,
      label: `${d.emoji} ${d.label}`,
      desc: `이 판의 패기 유형이 '${d.label}' 으로 판정됨`,
      active: storedActive.get(slug) ?? d.id !== PERSONA_FALLBACK_ID,
    };
  });
}

/**
 * 읽기/쓰기 공통 정규화 — 유형 패밀리·행을 코드 정의와 일치시킨다.
 * 구 카탈로그(7패밀리)는 유형 패밀리를 편입, 미지 유형 slug 는 제거, 라벨/설명은 코드값으로 고정.
 */
export function normalizeBadgeCatalogInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const c = input as { families?: unknown; badges?: unknown };
  if (!Array.isArray(c.families) || !Array.isArray(c.badges)) return input;
  const families = (c.families as { key?: unknown }[]).filter((f) => f?.key !== PERSONA_FAMILY_KEY);
  const storedPersonaFamily = (c.families as { key?: unknown; name?: unknown; emoji?: unknown }[]).find(
    (f) => f?.key === PERSONA_FAMILY_KEY
  );
  const stored = (c.badges as RawBadge[]).filter((b) => b?.familyKey !== PERSONA_FAMILY_KEY);
  const storedPersona = (c.badges as RawBadge[]).filter((b) => b?.familyKey === PERSONA_FAMILY_KEY);
  // v1.37: 코드 신설 tier(weapon_10·13·16·19)만 저장본에 편입(additive). 코드 은퇴 tier 는 비활성 고정(v1.39 현재 없음 — weapon_9 은퇴 철회).
  // 그 외 저장본에 없는 시드(어드민이 뺀 tier)는 되살리지 않는다 — 발행본이 정본(v1.38 교정: 종전엔 전부 편입해 14개가 되살아났다).
  const storedSlugs = new Set(stored.map((b) => (typeof b.slug === "string" ? b.slug : "")));
  const added = SEED_BADGES.filter((b) => CODE_ADDED_BADGE_SLUGS.has(b.slug) && !storedSlugs.has(b.slug));
  // 편입 행은 같은 패밀리 블록 안, threshold 가 더 낮은 마지막 저장 행 바로 뒤에 끼운다(없으면 블록 맨 앞, 패밀리 저장
  // 행이 없으면 맨 끝). 패밀리 행이 배열에서 흩어지면 어드민 순서 화살표·공개 /badges 순서(둘 다 배열 순서)가 어긋난다.
  const merged: RawBadge[] = stored.slice();
  for (const b of added) {
    const famIdx = merged.flatMap((r, i) => (r?.familyKey === b.familyKey ? [i] : []));
    if (famIdx.length === 0) {
      merged.push(b);
      continue;
    }
    const below = famIdx.filter((i) => Number(merged[i]?.threshold) < b.threshold);
    merged.splice(below.length ? below[below.length - 1] + 1 : famIdx[0], 0, b);
  }
  const others = merged.map((b) =>
    typeof b.slug === "string" && CODE_RETIRED_BADGE_SLUGS.has(b.slug) ? { ...b, active: false } : b
  );
  return {
    ...c,
    families: [...families, storedPersonaFamily ?? PERSONA_FAMILY_DEFAULT],
    badges: [...others, ...personaBadgeRows(storedPersona)],
  };
}

// ── 코드 기본값 — slug = `family_threshold` 동결. 라벨·설명은 v1.55 누적 문구(발행본이 정본, 발행 전 기본값에만 쓰인다). ──
type Seed = {
  key: BadgeFamilyKey;
  name: string;
  emoji: string;
  tiers: number[];
  /** 코드 은퇴 tier — slug 는 동결 유지(획득 표시 보존), 디폴트·정규화에서 active=false 고정 */
  retired?: number[];
  /**
   * 카탈로그가 어드민 소유가 된 뒤 코드에 신설된 tier — 저장 카탈로그에 없으면 정규화가 편입한다(additive).
   * 여기 없는 시드 tier 는 어드민이 뺀 것일 수 있으므로 편입하지 않는다(발행본 = 정본).
   */
  added?: number[];
  label: (t: number) => string;
  desc: (t: number) => string;
};
const SEED: Seed[] = [
  { key: "score", name: "점수", emoji: "🏆", tiers: [1000, 3000, 5000, 10000, 30000, 50000, 100000, 300000, 500000, 1000000], label: (t) => `${t.toLocaleString()}점`, desc: (t) => `총 정산 점수 ${t.toLocaleString()}점 달성` },
  { key: "combo", name: "콤보", emoji: "🔥", tiers: [100, 200, 300, 500, 1000, 1500, 2000, 3000, 5000, 10000], label: (t) => `콤보 ${t.toLocaleString()}`, desc: (t) => `최대 콤보 ${t.toLocaleString()} 달성` },
  { key: "hits", name: "타격", emoji: "👊", tiers: [150, 400, 700, 1200, 2500, 4000, 7000, 12000, 20000, 30000], label: (t) => `누적 ${t.toLocaleString()}타`, desc: (t) => `모든 판 합계 ${t.toLocaleString()}타 (궁극기 제외)` },
  // v1.37: 로스터 19종(맵별 투척 12종) — 10·13·16·19 신설. v1.39: 9종 tier 코드 은퇴 철회(어드민 활성 체크가 정본 — 발행본은 3·6·9·12·15 를 쓴다)
  { key: "weapon", name: "무기", emoji: "🗡️", tiers: [2, 4, 6, 8, 9, 10, 13, 16, 19], added: [10, 13, 16, 19], label: (t) => `무기 ${t}종`, desc: (t) => `한 판에 무기 ${t}종 사용` },
  { key: "ult", name: "궁극기", emoji: "💥", tiers: [1, 2, 3, 5, 10, 15, 20, 30, 40, 50], label: (t) => `누적 궁극기 ${t}회`, desc: (t) => `모든 판 합계 궁극기 ${t}회 발동` },
  { key: "time", name: "플레이", emoji: "⏱️", tiers: [1, 2, 3, 5, 7, 10, 12, 15, 18, 20], label: (t) => `누적 ${t}분`, desc: (t) => `모든 판 합계 ${t}분 플레이 (일시정지 제외)` },
  { key: "map", name: "맵", emoji: "🗺️", tiers: [2, 3, 4, 5, 6], label: (t) => `맵 ${t}곳`, desc: (t) => `한 판에 맵 ${t}곳 순회` },
];

/** 코드 시드 뱃지(유형 제외) — 디폴트 카탈로그의 원천. 저장 카탈로그에는 `added` 로 표시된 slug 만 편입한다. */
const SEED_BADGES: CatalogBadge[] = SEED.flatMap((f) =>
  f.tiers.map((t) => ({
    slug: `${f.key}_${t}`,
    familyKey: f.key,
    threshold: t,
    label: f.label(t),
    desc: f.desc(t),
    active: !(f.retired ?? []).includes(t),
  }))
);
/** 코드 은퇴 slug — 저장값과 무관하게 active=false 로 고정(획득 표시는 보존). */
export const CODE_RETIRED_BADGE_SLUGS: ReadonlySet<string> = new Set(
  SEED.flatMap((f) => (f.retired ?? []).map((t) => `${f.key}_${t}`))
);
/** 코드 신설 slug — 저장 카탈로그에 없으면 편입. 그 외 시드는 어드민이 뺀 것으로 보고 되살리지 않는다. */
export const CODE_ADDED_BADGE_SLUGS: ReadonlySet<string> = new Set(
  SEED.flatMap((f) => (f.added ?? []).map((t) => `${f.key}_${t}`))
);

export const BADGE_CATALOG_DEFAULT: BadgeCatalog = {
  families: [...SEED.map((f) => ({ key: f.key, name: f.name, emoji: f.emoji })), PERSONA_FAMILY_DEFAULT],
  badges: [...SEED_BADGES, ...personaBadgeRows([])],
};

// ── 카탈로그 기반 순수 헬퍼(서버 grant + 클라 표시 공용) ──

/**
 * 이번 판 달성 slug 전체 — **active 만** grant(비활성은 신규 획득 안 됨), ladder 하위 동반.
 * totals = 이 판을 뺀 이전 누적 합계(누적 카테고리만 씀, lib/play-totals). 모르면 PLAY_TOTALS_ZERO — 누적 카테고리가 이 판 값만으로
 * 평가된다(표시 전용 폴백. 서버 부여는 합계를 모르면 리포트를 재시도로 돌린다).
 */
export function evaluateBadges(
  stats: GameplayStats,
  score: number,
  catalog: BadgeCatalog,
  totals: PlayTotals
): string[] {
  const personaSlug = personaBadgeSlug(matchPersona(stats).id);
  return catalog.badges
    .filter((b) =>
      b.familyKey === PERSONA_FAMILY_KEY
        ? b.active && b.slug === personaSlug // 유형: 이 판의 유형과 일치할 때 1개
        : b.active && FAMILY_VALUE[b.familyKey](stats, score, totals) >= b.threshold
    )
    .map((b) => b.slug);
}

/** 이 판 값이 0 인 판 — 판 시작 전 달성 판정용(누적 카테고리는 이전 합계만 남고, 한 판 카테고리는 0). */
const EMPTY_GAME: GameplayStats = buildGameplayStats({
  hitCount: 0,
  maxCombo: 0,
  durationMs: 0,
  weaponCounts: {},
  weaponScores: {},
  ultScore: 0,
  ultimateCount: 0,
  firstHitMs: null,
  bgVisits: [],
});

/**
 * 판 시작 전에 이전 합계만으로 이미 넘은 누적 뱃지(v1.56) — 인게임 도전은 이것을 토스트 없이 달성 처리한다.
 * 부여는 이번 판 제출 때 서버가 하고 종료 화면이 NEW 로 보인다(v1.55 설계 「다음 판 제출 때 한꺼번에」).
 * 토스트는 이번 판에 새로 넘는 tier 만. 한 판 카테고리와 유형은 해당 없음.
 */
export function reachedBeforeGame(badge: CatalogBadge, totals: PlayTotals): boolean {
  return (
    FAMILY_BASIS[badge.familyKey] === "cumulative" &&
    FAMILY_VALUE[badge.familyKey](EMPTY_GAME, 0, totals) >= badge.threshold
  );
}

/** 패밀리 달성값(인게임 진행도) — 누적 카테고리는 이전 합계 + 이 판. */
export function familyValue(
  familyKey: BadgeFamilyKey,
  stats: GameplayStats,
  score: number,
  totals: PlayTotals
): number {
  return FAMILY_VALUE[familyKey](stats, score, totals);
}

/** 컬렉션 카운트 분모/known 집합 — 카탈로그의 모든 slug(active+inactive; 획득 보존). 구 고아 제외용. */
export function knownSlugs(catalog: BadgeCatalog): Set<string> {
  return new Set(catalog.badges.map((b) => b.slug));
}

/** 활성 뱃지만(컬렉션/챌린지 표시·달성 후보). */
export function activeBadges(catalog: BadgeCatalog): CatalogBadge[] {
  return catalog.badges.filter((b) => b.active);
}

export function badgeBySlug(catalog: BadgeCatalog, slug: string): CatalogBadge | undefined {
  return catalog.badges.find((b) => b.slug === slug);
}

export function familyEmoji(catalog: BadgeCatalog, familyKey: string): string {
  return catalog.families.find((f) => f.key === familyKey)?.emoji ?? "🏅";
}

/** 컬렉션 페이지용 — 패밀리별 active 뱃지 그룹(SEED 순서). */
export function familyGroups(
  catalog: BadgeCatalog
): { key: string; name: string; emoji: string; badges: CatalogBadge[] }[] {
  return catalog.families.map((f) => ({
    key: f.key,
    name: f.name,
    emoji: f.emoji,
    badges: catalog.badges.filter((b) => b.active && b.familyKey === f.key),
  }));
}

/** 표시 압축 — 패밀리별 최고 threshold 1개(strip). 획득 slug 중 카탈로그에 있는 것만. */
export function summarizeBadges(catalog: BadgeCatalog, ownedSlugs: string[]): string[] {
  const top = new Map<string, CatalogBadge>();
  for (const slug of ownedSlugs) {
    const b = badgeBySlug(catalog, slug);
    if (!b) continue;
    const cur = top.get(b.familyKey);
    if (!cur || b.threshold > cur.threshold) top.set(b.familyKey, b);
  }
  return catalog.families
    .map((f) => top.get(f.key)?.slug)
    .filter((x): x is string => !!x);
}
