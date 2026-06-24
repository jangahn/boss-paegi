import { josaEul, josaEun, josaEuro } from "@/lib/roles";

/**
 * 마케팅 카피 치환 — 클라/서버 공용 **순수 모듈**(server-only getter import 금지).
 *
 * 두 종류 토큰:
 *  1) 호칭 토큰 {호칭}{호칭을}{호칭은}{호칭으로} — 롤 호칭(label)+조사 자동. 마케터가 직접 의미를 정함.
 *  2) 값 토큰 {제작자}{점수}{등급}{특이사항}{상위} — **코드가 런타임 값을 채움**(마케터는 위치만 지정).
 *     제공 안 된 값 토큰은 빈 문자열로 제거(공개 화면에 {…} 누출 방지).
 */

// 호칭 토큰(긴 것부터). "{호칭}"은 "{호칭을}"의 부분문자열이 아니므로 순서만 지키면 안전.
const ROLE_REPLACERS: ReadonlyArray<readonly [string, (label: string) => string]> = [
  ["{호칭을}", (l) => `${l}${josaEul(l)}`],
  ["{호칭은}", (l) => `${l}${josaEun(l)}`],
  ["{호칭으로}", (l) => `${l}${josaEuro(l)}`],
  ["{호칭}", (l) => l],
];

/** 코드가 채우는 값 토큰(편집 불가, 위치만). 키는 vars 의 키와 동일. */
export const VALUE_TOKENS = ["{제작자}", "{점수}", "{등급}", "{특이사항}", "{상위}"] as const;

const ROLE_TOKENS = ROLE_REPLACERS.map(([t]) => t);

/** 허용 토큰 전체 — 에디터 도움말/검증·미리보기 공용. */
export const KNOWN_TOKENS: readonly string[] = [...ROLE_TOKENS, ...VALUE_TOKENS];

export type CopyVars = Partial<Record<"제작자" | "점수" | "등급" | "특이사항" | "상위", string | number>>;

/**
 * 템플릿의 호칭 토큰을 label+조사로, 값 토큰을 vars 값으로 치환. 제공 안 된 값 토큰은 제거.
 * 미지(`{...}`) 토큰은 그대로 둔다(저장 단계에서 unknownTokens 로 차단).
 */
export function resolveCopy(tpl: string, label: string, vars?: CopyVars): string {
  let out = tpl;
  for (const [token, fn] of ROLE_REPLACERS) {
    if (out.includes(token)) out = out.split(token).join(fn(label));
  }
  for (const token of VALUE_TOKENS) {
    if (!out.includes(token)) continue;
    const key = token.slice(1, -1) as keyof CopyVars;
    const v = vars?.[key];
    out = out.split(token).join(v == null ? "" : String(v));
  }
  return out;
}

/** 허용 토큰 외의 `{...}` 토큰 목록(저장 차단·미리보기 경고용). 없으면 빈 배열. */
export function unknownTokens(tpl: string): string[] {
  const found = tpl.match(/\{[^}]*\}/g) ?? [];
  return [...new Set(found.filter((t) => !KNOWN_TOKENS.includes(t)))];
}
