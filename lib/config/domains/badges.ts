import { z } from "zod";
import type { DomainEntry } from "../registry";
import type { GameplayStats } from "@/lib/stats";
import {
  PERSONA_DEFS,
  PERSONA_FALLBACK_ID,
  matchPersona,
  personaBadgeSlug,
  personaIdFromBadgeSlug,
} from "@/lib/persona";

/**
 * 뱃지 카탈로그 도메인 — 마케터가 임계값(수치)·개수·라벨·활성 편집. 카테고리(패밀리)는 7종 고정,
 * 각 패밀리의 **달성값 계산 함수는 코드**(FAMILY_VALUE, stats 필드 참조라 비직렬화). slug 는 **불변 동결**
 * (threshold 파싱 안 함) → 임계값 바꿔도 user_badges 고아 없음. 삭제 대신 active=false(획득 표시 보존).
 * 인증 grant(/api/score)·컬렉션·챌린지가 이 카탈로그로 구동. 마이그 없음(순수 config).
 */

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

// 패밀리별 달성값(코드 — 마케터 편집 불가). familyKey → (stats,score)→value.
export const FAMILY_VALUE: Record<
  BadgeFamilyKey,
  (s: GameplayStats, score: number) => number
> = {
  score: (_s, score) => score,
  combo: (s) => s.maxCombo,
  hits: (s) => s.hitCount,
  weapon: (s) => Object.keys(s.weaponCounts).length,
  ult: (s) => s.ultimateCount,
  time: (s) => s.durationMs / 60000,
  map: (s) => s.bgVisits.length,
  // 유형은 뱃지별 매칭(evaluateBadges 특례) — 패밀리 단일 달성값 개념 없음
  persona: () => 0,
};

const familySchema = z.object({
  key: z.enum(BADGE_FAMILY_KEYS),
  name: z.string().trim().min(1).max(20),
  emoji: z.string().trim().min(1).max(8),
});
const badgeSchema = z.object({
  slug: z.string().trim().min(1).max(40), // 불변 동결(편집 UI 에서 잠금)
  familyKey: z.enum(BADGE_FAMILY_KEYS),
  threshold: z.number().int().min(0).max(100_000_000),
  label: z.string().trim().min(1).max(40),
  desc: z.string().trim().min(1).max(80),
  active: z.boolean(),
});

type RawBadge = { slug?: unknown; familyKey?: unknown; active?: unknown };

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
  const others = (c.badges as RawBadge[]).filter((b) => b?.familyKey !== PERSONA_FAMILY_KEY);
  const storedPersona = (c.badges as RawBadge[]).filter((b) => b?.familyKey === PERSONA_FAMILY_KEY);
  return {
    ...c,
    families: [...families, storedPersonaFamily ?? PERSONA_FAMILY_DEFAULT],
    badges: [...others, ...personaBadgeRows(storedPersona)],
  };
}

const badgeCatalogBaseSchema = z
  .object({
    families: z.array(familySchema).length(BADGE_FAMILY_KEYS.length),
    badges: z.array(badgeSchema).min(1).max(140),
  })
  .refine((c) => new Set(c.badges.map((b) => b.slug)).size === c.badges.length, {
    message: "duplicate_slug",
    path: ["badges"],
  })
  // 8개 패밀리 키가 중복 없이 완전(누락/중복 시 표시 깨짐) — API trust-boundary 방어(에디터로는 불가).
  .refine((c) => new Set(c.families.map((f) => f.key)).size === BADGE_FAMILY_KEYS.length, {
    message: "family_keys_invalid",
    path: ["families"],
  })
  // 유형 뱃지 집합 == 코드 유형 집합(정규화 후 항상 참 — API 경계 방어)
  .refine(
    (c) => {
      const ids = c.badges
        .filter((b) => b.familyKey === PERSONA_FAMILY_KEY)
        .map((b) => personaIdFromBadgeSlug(b.slug))
        .filter((x): x is string => !!x)
        .sort();
      const expected = PERSONA_DEFS.map((d) => d.id).sort();
      return ids.length === expected.length && ids.every((id, i) => id === expected[i]);
    },
    { message: "persona_badges_invalid", path: ["badges"] }
  );

export const badgeCatalogSchema = z.preprocess(normalizeBadgeCatalogInput, badgeCatalogBaseSchema);

export type BadgeCatalog = z.infer<typeof badgeCatalogBaseSchema>;
export type CatalogBadge = z.infer<typeof badgeSchema>;
export type CatalogFamily = z.infer<typeof familySchema>;

// ── 코드 기본값(현 lib/badges 와 byte-identical) — slug = 현 id(`family_threshold`) 그대로 동결. ──
type Seed = { key: BadgeFamilyKey; name: string; emoji: string; tiers: number[]; label: (t: number) => string; desc: (t: number) => string };
const SEED: Seed[] = [
  { key: "score", name: "점수", emoji: "🏆", tiers: [1000, 3000, 5000, 10000, 30000, 50000, 100000, 300000, 500000, 1000000], label: (t) => `${t.toLocaleString()}점`, desc: (t) => `총 정산 점수 ${t.toLocaleString()}점 달성` },
  { key: "combo", name: "콤보", emoji: "🔥", tiers: [100, 200, 300, 500, 1000, 1500, 2000, 3000, 5000, 10000], label: (t) => `콤보 ${t.toLocaleString()}`, desc: (t) => `최대 콤보 ${t.toLocaleString()} 달성` },
  { key: "hits", name: "타격", emoji: "👊", tiers: [150, 400, 700, 1200, 2500, 4000, 7000, 12000, 20000, 30000], label: (t) => `${t.toLocaleString()}타`, desc: (t) => `한 판에 ${t.toLocaleString()}타 (궁극기 제외)` },
  { key: "weapon", name: "무기", emoji: "🗡️", tiers: [2, 4, 6, 8, 9], label: (t) => `무기 ${t}종`, desc: (t) => `한 판에 무기 ${t}종 사용` },
  { key: "ult", name: "궁극기", emoji: "💥", tiers: [1, 2, 3, 5, 10, 15, 20, 30, 40, 50], label: (t) => `궁극기 ${t}회`, desc: (t) => `한 판에 궁극기 ${t}회 발동` },
  { key: "time", name: "플레이", emoji: "⏱️", tiers: [1, 2, 3, 5, 7, 10, 12, 15, 18, 20], label: (t) => `${t}분`, desc: (t) => `${t}분 이상 플레이` },
  { key: "map", name: "맵", emoji: "🗺️", tiers: [2, 3, 4, 5, 6], label: (t) => `맵 ${t}곳`, desc: (t) => `한 판에 맵 ${t}곳 순회` },
];

export const BADGE_CATALOG_DEFAULT: BadgeCatalog = {
  families: [...SEED.map((f) => ({ key: f.key, name: f.name, emoji: f.emoji })), PERSONA_FAMILY_DEFAULT],
  badges: [
    ...SEED.flatMap((f) =>
      f.tiers.map((t) => ({
        slug: `${f.key}_${t}`,
        familyKey: f.key,
        threshold: t,
        label: f.label(t),
        desc: f.desc(t),
        active: true,
      }))
    ),
    ...personaBadgeRows([]),
  ],
};

export const badgeEntry: DomainEntry<BadgeCatalog> = {
  schema: badgeCatalogSchema,
  codeDefault: BADGE_CATALOG_DEFAULT,
};

// ── 카탈로그 기반 순수 헬퍼(서버 grant + 클라 표시 공용) ──

/** 이번 판 달성 slug 전체 — **active 만** grant(비활성은 신규 획득 안 됨), ladder 하위 동반. */
export function evaluateBadges(
  stats: GameplayStats,
  score: number,
  catalog: BadgeCatalog
): string[] {
  const personaSlug = personaBadgeSlug(matchPersona(stats).id);
  return catalog.badges
    .filter((b) =>
      b.familyKey === PERSONA_FAMILY_KEY
        ? b.active && b.slug === personaSlug // 유형: 이 판의 유형과 일치할 때 1개
        : b.active && FAMILY_VALUE[b.familyKey](stats, score) >= b.threshold
    )
    .map((b) => b.slug);
}

/** 패밀리 달성값(인게임 진행도). */
export function familyValue(
  familyKey: BadgeFamilyKey,
  stats: GameplayStats,
  score: number
): number {
  return FAMILY_VALUE[familyKey](stats, score);
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
