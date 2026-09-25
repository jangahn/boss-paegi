import type { RoleFull } from "./roles-schema";
import { ROLE_IDS, ROLE_META, asRole, type RoleId } from "@/lib/roles";
import { LEGACY_ROLE_ALIASES } from "@/lib/roles/ids";
import type { GenderVoice, RoleContent } from "@/lib/roles/types";
import { TIER_COUNT } from "@/lib/score-tiers";
import { type Gender } from "@/lib/gender";
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
// 검증 schema(zod)는 `./roles-schema` — 이 모듈은 클라 번들(종료 화면 · 갤러리 · 공유)에 들어가 zod 를 끌어오지 않는다(v1.64).

export type { RoleFull };

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

export type RoleConfig = Record<RoleId, RoleFull>;
export type RoleVoice = { reactions: string[][]; taunts: string[][] };

const CODE_CONTENT: Record<RoleId, RoleContent> = { boss, ceo, exec, teamlead, client, junior, friend };

function copyVoice(v: GenderVoice): RoleVoice {
  return { reactions: v.reactions.map((t) => [...t]), taunts: v.taunts.map((t) => [...t]) };
}

/** 롤별 여성 보이스 코드 기본값(mutable 복제) — 발행행에 female 이 없을 때 스키마 default. */
export function femaleVoiceDefault(role: RoleId): RoleVoice {
  return copyVoice(CODE_CONTENT[role].female);
}

/**
 * 성별에 맞는 보이스(피격 반응·시비 멘트) 선택 — 반응/멘트 소비자(report·taunts)의 단일 분기점.
 * male = 루트 reactions/taunts, female = female 블록. 호칭·인사기록·등급은 성별 무관이라 여기 없다.
 */
export function roleVoice(rc: RoleFull, gender: Gender): RoleVoice {
  return gender === "female" ? rc.female : { reactions: rc.reactions, taunts: rc.taunts };
}

// 기존 RoleContent(readonly tuple) + ROLE_META(label·desc) → 편집 가능한 mutable RoleFull 로 복제.
// 호칭은 label 1개로 통일 — 목적격/조사/칩은 josaEul·josaEun·josaEuro 로 파생(데이터 중복 제거).
function toFull(rc: RoleContent, role: RoleId): RoleFull {
  return {
    reactions: rc.reactions.map((t) => [...t]),
    taunts: rc.taunts.map((t) => [...t]),
    female: copyVoice(rc.female),
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

// dev 보조: 7롤 키가 ROLE_IDS 와 일치하는지(런타임 결합 가드, prod 영향 없음).
if (process.env.NODE_ENV !== "production") {
  const keys = Object.keys(ROLE_CONFIG_DEFAULT).sort().join(",");
  if (keys !== [...ROLE_IDS].sort().join(",")) {
    console.error(`[config/roles] 기본값 롤 키 불일치: ${keys}`);
  }
}
