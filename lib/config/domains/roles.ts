import { z } from "zod";
import type { DomainEntry } from "../registry";
import { ROLE_IDS, ROLE_META, asRole, type RoleId } from "@/lib/roles";
import type { RoleContent } from "@/lib/roles/types";
import { boss } from "@/lib/roles/boss";
import { exec } from "@/lib/roles/exec";
import { teamlead } from "@/lib/roles/teamlead";
import { client } from "@/lib/roles/client";
import { coworker } from "@/lib/roles/coworker";

// 롤 tiered 콘텐츠 도메인 — 순수 모듈(client 프로바이더 default + server getter 공용, lib/roles 와 무순환).
// 점수 10단계 결합 가드: reactions/taunts/ogLines 는 **정확히 10 tier**(.length(10)), tier 당 ≥1 줄.
// tier 개수(10)·매핑은 코드 고정(score_config) — 마케터는 내용만.
const tier = z.array(z.string().trim().min(1).max(120)).min(1);
const tiered = z.array(tier).length(10);

const roleFullSchema = z.object({
  reactions: tiered,
  taunts: tiered,
  ogLines: tiered,
  traits: z.array(z.string().trim().min(1).max(60)).min(1),
  ranks: z.array(z.string().trim().min(1).max(40)).min(1),
  departments: z.array(z.string().trim().min(1).max(40)).min(1),
  noun: z.string().trim().min(1).max(20),
  targetObj: z.string().trim().min(1).max(20),
  ctaSafe: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(20),
  chip: z.string().trim().min(1).max(10),
});

// 5롤 고정(엔지니어 전용) — 키 정확히 boss/exec/teamlead/client/coworker.
export const roleConfigSchema = z.object({
  boss: roleFullSchema,
  exec: roleFullSchema,
  teamlead: roleFullSchema,
  client: roleFullSchema,
  coworker: roleFullSchema,
});

export type RoleFull = z.infer<typeof roleFullSchema>;
export type RoleConfig = z.infer<typeof roleConfigSchema>;

// 기존 RoleContent(readonly tuple) + ROLE_META(label/chip) → 편집 가능한 mutable RoleFull 로 복제.
function toFull(rc: RoleContent, label: string, chip: string): RoleFull {
  return {
    reactions: rc.reactions.map((t) => [...t]),
    taunts: rc.taunts.map((t) => [...t]),
    ogLines: rc.ogLines.map((t) => [...t]),
    traits: [...rc.traits],
    ranks: [...rc.ranks],
    departments: [...rc.departments],
    noun: rc.noun,
    targetObj: rc.targetObj,
    ctaSafe: rc.ctaSafe,
    label,
    chip,
  };
}

export const ROLE_CONFIG_DEFAULT: RoleConfig = {
  boss: toFull(boss, ROLE_META.boss.label, ROLE_META.boss.chip),
  exec: toFull(exec, ROLE_META.exec.label, ROLE_META.exec.chip),
  teamlead: toFull(teamlead, ROLE_META.teamlead.label, ROLE_META.teamlead.chip),
  client: toFull(client, ROLE_META.client.label, ROLE_META.client.chip),
  coworker: toFull(coworker, ROLE_META.coworker.label, ROLE_META.coworker.chip),
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
