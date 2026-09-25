import { z } from "zod";
import type { DomainEntry } from "../registry";
import { PERSONA_DEFS, personaIdFromBadgeSlug } from "@/lib/persona";
import {
  BADGE_CATALOG_DEFAULT,
  BADGE_FAMILY_KEYS,
  PERSONA_FAMILY_KEY,
  normalizeBadgeCatalogInput,
} from "./badges";

// 뱃지 카탈로그 검증 schema(v1.64 분리) — zod 는 서버(getter · 레지스트리 · 어드민 저장)에서만 쓴다. 값 · 헬퍼는 `./badges`.

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

export const badgeEntry: DomainEntry<BadgeCatalog> = {
  schema: badgeCatalogSchema,
  codeDefault: BADGE_CATALOG_DEFAULT,
};
