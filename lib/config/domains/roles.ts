import { z } from "zod";
import type { DomainEntry } from "../registry";
import { ROLE_IDS, ROLE_META, asRole, type RoleId } from "@/lib/roles";
import { LEGACY_ROLE_ALIASES } from "@/lib/roles/ids";
import type { RoleContent } from "@/lib/roles/types";
import { TIER_COUNT } from "@/lib/score-tiers";
import { boss } from "@/lib/roles/boss";
import { ceo } from "@/lib/roles/ceo";
import { exec } from "@/lib/roles/exec";
import { teamlead } from "@/lib/roles/teamlead";
import { client } from "@/lib/roles/client";
import { junior } from "@/lib/roles/junior";
import { friend } from "@/lib/roles/friend";

// 롤 tiered 콘텐츠 도메인 — 순수 모듈(client 프로바이더 default + server getter 공용, lib/roles 와 무순환).
// 점수 5단계 결합 가드: reactions/taunts 는 **정확히 TIER_COUNT tier**(.length(5)), tier 당 ≥1 줄
// (시드는 반응 6줄·멘트 8줄 — 권장치이며 스키마 강제는 아님).
// tier 개수(5)는 코드 고정, 경계는 score_config.thresholds — 마케터는 내용만.
const tier = z.array(z.string().trim().min(1).max(120)).min(1);
const tiered = z.array(tier).length(TIER_COUNT);

// 롤 1개 스키마 — desc(역할 선택 카드 한 줄 설명)는 v1.25 신설이라 발행행에 없으면 롤별 코드 기본값 충전.
function roleFullSchema(role: RoleId) {
  return z.object({
    reactions: tiered,
    taunts: tiered,
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

/**
 * 구 10단계(v1.23 이전 발행행) → 5단계: 인접 쌍 병합(0+1, 2+3, 4+5, 6+7, 8+9).
 * 순서(감정선 아크) 기준 전환이라 경계값과 무관하며, 반응 3+3=6줄·멘트 4+4=8줄로 마케터 편집 줄이 전부 보존된다.
 * 이미 5단계면 그대로. 그 외 모양은 손대지 않고 스키마가 거절하게 둔다.
 */
export function mergeLegacyTiers(tiers: unknown): unknown {
  if (!Array.isArray(tiers) || tiers.length !== TIER_COUNT * 2) return tiers;
  const merged: unknown[] = [];
  for (let i = 0; i < tiers.length; i += 2) {
    const a = Array.isArray(tiers[i]) ? (tiers[i] as unknown[]) : [];
    const b = Array.isArray(tiers[i + 1]) ? (tiers[i + 1] as unknown[]) : [];
    merged.push([...a, ...b]);
  }
  return merged;
}

/**
 * 읽기/쓰기 공통 정규화(뱃지 카탈로그 선례) — 발행행이 구 형태여도 첫 읽기부터 valid(codeDefault 폴백 창 0).
 *  ① 롤별 10단계 → 5단계 쌍 병합 ② 흡수된 구 롤 키(coworker) 제거 — 그 문구는 감사 이력에만 남고
 *  현행 롤(friend)은 코드 기본값 시드 ③ 발행행에 없는 신규 롤은 코드 기본값으로 충전.
 * 그 외 미지 키는 건드리지 않아 strict 스키마가 거절한다(API 경계 방어).
 */
export function normalizeRoleContentInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.hasOwn(LEGACY_ROLE_ALIASES, key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const role = value as Record<string, unknown>;
      out[key] = {
        ...role,
        reactions: mergeLegacyTiers(role.reactions),
        taunts: mergeLegacyTiers(role.taunts),
      };
    } else {
      out[key] = value;
    }
  }
  for (const r of ROLE_IDS) {
    if (!(r in out)) out[r] = ROLE_CONFIG_DEFAULT[r];
  }
  return out;
}

export const roleConfigSchema = z.preprocess(normalizeRoleContentInput, roleConfigBaseSchema);

export type RoleFull = z.infer<ReturnType<typeof roleFullSchema>>;
export type RoleConfig = Record<RoleId, RoleFull>;

// 기존 RoleContent(readonly tuple) + ROLE_META(label·desc) → 편집 가능한 mutable RoleFull 로 복제.
// 호칭은 label 1개로 통일 — 목적격/조사/칩은 josaEul·josaEun·josaEuro 로 파생(데이터 중복 제거).
function toFull(rc: RoleContent, role: RoleId): RoleFull {
  return {
    reactions: rc.reactions.map((t) => [...t]),
    taunts: rc.taunts.map((t) => [...t]),
    traits: [...rc.traits],
    ranks: [...rc.ranks],
    departments: [...rc.departments],
    label: ROLE_META[role].label,
    desc: ROLE_META[role].desc,
  };
}

export const ROLE_CONFIG_DEFAULT: RoleConfig = {
  boss: toFull(boss, "boss"),
  ceo: toFull(ceo, "ceo"),
  exec: toFull(exec, "exec"),
  teamlead: toFull(teamlead, "teamlead"),
  client: toFull(client, "client"),
  junior: toFull(junior, "junior"),
  friend: toFull(friend, "friend"),
};

/** cfg 에서 한 롤의 전체 콘텐츠. cfg 미지정 시 코드 기본값(미배선 소비자 안전 폴백). 구 alias(coworker)는 friend. */
export function roleFrom(role: RoleId | string, cfg?: RoleConfig): RoleFull {
  return (cfg ?? ROLE_CONFIG_DEFAULT)[asRole(role)];
}

// 클라(시비멘트/반응/칩)는 루트 레이아웃이 서버에서 읽어 RoleContentProvider 로 주입(라이브).
// → /api/config/public 에 노출 불필요(큰 페이로드 방지). 서버 OG/doll 은 getRoleConfig() 직접.
export const rolesEntry: DomainEntry<RoleConfig> = {
  schema: roleConfigSchema as unknown as z.ZodType<RoleConfig>,
  codeDefault: ROLE_CONFIG_DEFAULT,
};

// dev 보조: 7롤 키가 ROLE_IDS 와 일치하는지(런타임 결합 가드, prod 영향 없음).
if (process.env.NODE_ENV !== "production") {
  const keys = Object.keys(ROLE_CONFIG_DEFAULT).sort().join(",");
  if (keys !== [...ROLE_IDS].sort().join(",")) {
    console.error(`[config/roles] 기본값 롤 키 불일치: ${keys}`);
  }
}
