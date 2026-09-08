import { z } from "zod";
import type { DomainEntry } from "../registry";
import { ROLE_IDS, ROLE_META, asRole, type RoleId } from "@/lib/roles";
import type { RoleContent } from "@/lib/roles/types";
import { TIER_COUNT } from "@/lib/score-tiers";
import { boss } from "@/lib/roles/boss";
import { exec } from "@/lib/roles/exec";
import { teamlead } from "@/lib/roles/teamlead";
import { client } from "@/lib/roles/client";
import { coworker } from "@/lib/roles/coworker";

// 롤 tiered 콘텐츠 도메인 — 순수 모듈(client 프로바이더 default + server getter 공용, lib/roles 와 무순환).
// 점수 5단계 결합 가드: reactions/taunts 는 **정확히 TIER_COUNT tier**(.length(5)), tier 당 ≥1 줄
// (시드는 반응 6줄·멘트 8줄 — 권장치이며 스키마 강제는 아님).
// tier 개수(5)는 코드 고정, 경계는 score_config.thresholds — 마케터는 내용만.
const tier = z.array(z.string().trim().min(1).max(120)).min(1);
const tiered = z.array(tier).length(TIER_COUNT);

const roleFullSchema = z.object({
  reactions: tiered,
  taunts: tiered,
  traits: z.array(z.string().trim().min(1).max(60)).min(1),
  ranks: z.array(z.string().trim().min(1).max(40)).min(1),
  departments: z.array(z.string().trim().min(1).max(40)).min(1),
  label: z.string().trim().min(1).max(20),
});

// 5롤 고정(엔지니어 전용) — 키 정확히 boss/exec/teamlead/client/coworker.
const roleConfigBaseSchema = z.object({
  boss: roleFullSchema,
  exec: roleFullSchema,
  teamlead: roleFullSchema,
  client: roleFullSchema,
  coworker: roleFullSchema,
});

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

/** 읽기/쓰기 공통 정규화(뱃지 카탈로그 선례) — 발행행이 구 형태여도 첫 읽기부터 valid(codeDefault 폴백 창 0). */
export function normalizeRoleContentInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
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
  return out;
}

export const roleConfigSchema = z.preprocess(normalizeRoleContentInput, roleConfigBaseSchema);

export type RoleFull = z.infer<typeof roleFullSchema>;
export type RoleConfig = z.infer<typeof roleConfigBaseSchema>;

// 기존 RoleContent(readonly tuple) + ROLE_META(label) → 편집 가능한 mutable RoleFull 로 복제.
// 호칭은 label 1개로 통일 — 목적격/조사/칩은 josaEul·josaEun·josaEuro 로 파생(데이터 중복 제거).
function toFull(rc: RoleContent, label: string): RoleFull {
  return {
    reactions: rc.reactions.map((t) => [...t]),
    taunts: rc.taunts.map((t) => [...t]),
    traits: [...rc.traits],
    ranks: [...rc.ranks],
    departments: [...rc.departments],
    label,
  };
}

export const ROLE_CONFIG_DEFAULT: RoleConfig = {
  boss: toFull(boss, ROLE_META.boss.label),
  exec: toFull(exec, ROLE_META.exec.label),
  teamlead: toFull(teamlead, ROLE_META.teamlead.label),
  client: toFull(client, ROLE_META.client.label),
  coworker: toFull(coworker, ROLE_META.coworker.label),
};

/** cfg 에서 한 롤의 전체 콘텐츠. cfg 미지정 시 코드 기본값(미배선 소비자 안전 폴백). */
export function roleFrom(role: RoleId | string, cfg?: RoleConfig): RoleFull {
  return (cfg ?? ROLE_CONFIG_DEFAULT)[asRole(role)];
}

// 클라(시비멘트/반응/칩)는 루트 레이아웃이 서버에서 읽어 RoleContentProvider 로 주입(라이브).
// → /api/config/public 에 노출 불필요(큰 페이로드 방지). 서버 OG/doll 은 getRoleConfig() 직접.
export const rolesEntry: DomainEntry<RoleConfig> = {
  schema: roleConfigSchema,
  codeDefault: ROLE_CONFIG_DEFAULT,
};

// dev 보조: 5롤 키가 ROLE_IDS 와 일치하는지(런타임 결합 가드, prod 영향 없음).
if (process.env.NODE_ENV !== "production") {
  const keys = Object.keys(ROLE_CONFIG_DEFAULT).sort().join(",");
  if (keys !== [...ROLE_IDS].sort().join(",")) {
    console.error(`[config/roles] 기본값 롤 키 불일치: ${keys}`);
  }
}
