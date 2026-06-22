import type { RoleContent } from "./types";
import { boss } from "./boss";
import { exec } from "./exec";
import { teamlead } from "./teamlead";
import { client } from "./client";
import { coworker } from "./coworker";

/**
 * 캐릭터 롤 레지스트리 — 단일 소스. 셀렉터(lib/report·taunts)가 role 로 인덱싱한다.
 * 렌더는 asRole()(미지값→boss)로 관대하게, 쓰기(PATCH)는 isRoleId()로 엄격하게.
 */
export const ROLE_IDS = ["boss", "exec", "teamlead", "client", "coworker"] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export const DEFAULT_ROLE: RoleId = "boss";

const ROLE_SET: ReadonlySet<string> = new Set(ROLE_IDS);

/** 외부 입력(DB/URL/응답) → RoleId 정규화. 미지값은 boss 폴백 (렌더용). */
export function asRole(v: unknown): RoleId {
  return typeof v === "string" && ROLE_SET.has(v) ? (v as RoleId) : DEFAULT_ROLE;
}

/** 엄격 검증 (PATCH 등 쓰기) — 미지값을 boss 로 바꾸지 않는다. */
export function isRoleId(v: unknown): v is RoleId {
  return typeof v === "string" && ROLE_SET.has(v);
}

/**
 * 한국어 조사 "(으)로" — 받침 없음 또는 ㄹ받침이면 "로", 그 외 "으로".
 * 예: 부장으로 / 임원으로 / 팀장으로 / 거래처로 / 동료로.
 */
export function josaEuro(word: string): string {
  const code = word.charCodeAt(word.length - 1);
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return "로"; // 비한글 기본
  const jong = (code - 0xac00) % 28; // 종성 인덱스 (0=받침없음, 8=ㄹ)
  return jong === 0 || jong === 8 ? "로" : "으로";
}

/** 표시 메타 — label(호칭/단일 표시), chip(갤러리 칩 짧은 라벨). */
export const ROLE_META: Record<RoleId, { label: string; chip: string }> = {
  boss: { label: "부장님", chip: "부장" },
  exec: { label: "임원", chip: "임원" },
  teamlead: { label: "팀장님", chip: "팀장" },
  client: { label: "거래처", chip: "거래처" },
  coworker: { label: "직장동료", chip: "동료" },
};

const CONTENT: Record<RoleId, RoleContent> = {
  boss,
  exec,
  teamlead,
  client,
  coworker,
};

export function getRoleContent(role: RoleId): RoleContent {
  return CONTENT[role] ?? boss;
}

// dev assert — 빈 tier / 빈 배열 조기 검출 (10단계 길이는 TieredLines 튜플이 컴파일 강제).
if (process.env.NODE_ENV !== "production") {
  for (const [id, c] of Object.entries(CONTENT)) {
    const bad: string[] = [];
    (["reactions", "taunts", "ogLines"] as const).forEach((k) =>
      c[k].forEach((t, i) => {
        if (t.length < 1) bad.push(`${k}[${i}] 빈 tier`);
      })
    );
    (["traits", "ranks", "departments"] as const).forEach((k) => {
      if (c[k].length < 1) bad.push(`${k} 비어있음`);
    });
    if (bad.length) console.error(`[roles] '${id}' 콘텐츠 이상: ${bad.join(", ")}`);
  }
}
