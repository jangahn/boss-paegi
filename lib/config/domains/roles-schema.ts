import { z } from "zod";
import type { DomainEntry } from "../registry";
import { ROLE_IDS, ROLE_META, type RoleId } from "@/lib/roles";
import { TIER_COUNT } from "@/lib/score-tiers";
import { ROLE_CONFIG_DEFAULT, femaleVoiceDefault, normalizeRoleContentInput, type RoleConfig } from "./roles";

// 롤 콘텐츠 검증 schema(v1.64 분리) — zod 는 서버(getter · 레지스트리 · 어드민 저장)에서만 쓴다. 값 · 정규화 · 헬퍼는 `./roles`.

const tier = z.array(z.string().trim().min(1).max(120)).min(1);
const tiered = z.array(tier).length(TIER_COUNT);

// 성별 보이스 한 벌(피격 반응·시비 멘트) — 루트 reactions/taunts 가 남성(기본), female 블록이 여성(v1.26).
const genderVoiceSchema = z.object({ reactions: tiered, taunts: tiered });

// 롤 1개 스키마 — desc(v1.25)·female(v1.26)은 신설이라 발행행에 없으면 롤별 코드 기본값 충전(재발행 시 저장됨).
function roleFullSchema(role: RoleId) {
  return z.object({
    reactions: tiered,
    taunts: tiered,
    female: genderVoiceSchema.default(() => femaleVoiceDefault(role)),
    traits: z.array(z.string().trim().min(1).max(60)).min(1),
    ranks: z.array(z.string().trim().min(1).max(40)).min(1),
    departments: z.array(z.string().trim().min(1).max(40)).min(1),
    label: z.string().trim().min(1).max(20),
    desc: z.string().trim().min(1).max(40).default(ROLE_META[role].desc),
  });
}

// 7롤 고정(엔지니어 전용) — 키 = ROLE_IDS 정확히(추가 키는 strict 거절, 구 alias 는 정규화가 제거).
const roleConfigBaseSchema = z
  .object(
    Object.fromEntries(ROLE_IDS.map((r) => [r, roleFullSchema(r)])) as Record<
      RoleId,
      ReturnType<typeof roleFullSchema>
    >,
  )
  .strict();

export const roleConfigSchema = z.preprocess(normalizeRoleContentInput, roleConfigBaseSchema);

export type RoleFull = z.infer<ReturnType<typeof roleFullSchema>>;

// 클라(시비멘트/반응/칩)는 루트 레이아웃이 서버에서 읽어 RoleContentProvider 로 주입(라이브).
// → /api/config/public 에 노출 불필요(큰 페이로드 방지). 서버 OG/doll 은 getRoleConfig() 직접.
export const rolesEntry: DomainEntry<RoleConfig> = {
  schema: roleConfigSchema as unknown as z.ZodType<RoleConfig>,
  codeDefault: ROLE_CONFIG_DEFAULT,
};
