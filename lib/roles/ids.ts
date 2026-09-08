/**
 * 캐릭터 롤 어휘 — **단일 소스, 순수 모듈**(import 0). 별칭(@/) 없이 상대 경로로도 로드되므로
 * node --test·클라 안전 모듈(play-doll-init·pending-generations-response·testbench·generation 도메인)이
 * 리스트를 복제하지 않고 여기서 파생한다. DB 어휘(CHECK·함수 allowlist)는 마이그레이션 0120 이 같은 7종.
 *
 * v1.25(2026-09-08): boss·exec·teamlead·client + **ceo(사장님)·junior(신입)·friend(친구)** 신설,
 * coworker(동료)는 friend 로 흡수(DB 리맵, 렌더는 alias 관용).
 */
export const ROLE_IDS = ["boss", "ceo", "exec", "teamlead", "client", "junior", "friend"] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export const DEFAULT_ROLE: RoleId = "boss";

/** 흡수된 구 롤 id → 현행 롤. 렌더(asRole)만 관용, 쓰기(isRoleId)는 거절(DB 도 0120 이후 거절). */
export const LEGACY_ROLE_ALIASES: Readonly<Record<string, RoleId>> = { coworker: "friend" };

const ROLE_SET: ReadonlySet<string> = new Set(ROLE_IDS);

/** 엄격 검증 (PATCH·생성 등 쓰기) — 미지값·구 alias 를 정규화하지 않는다. */
export function isRoleId(v: unknown): v is RoleId {
  return typeof v === "string" && ROLE_SET.has(v);
}

/** 외부 입력(DB/URL/응답) → RoleId 정규화. 구 alias 는 현행 롤로, 미지값은 boss 폴백 (렌더용). */
export function asRole(v: unknown): RoleId {
  if (isRoleId(v)) return v;
  if (typeof v === "string" && Object.hasOwn(LEGACY_ROLE_ALIASES, v)) return LEGACY_ROLE_ALIASES[v];
  return DEFAULT_ROLE;
}
