// member-hint.test.ts — 회원 힌트(v1.51): 첫 페인트 전 쿠키 판별(인라인 스크립트) ↔ memberHintFromCookie 결과 일치 · 홈/게임 종료 모달 계약.
//   쿠키는 @supabase/ssr 의 createChunks·stringToBase64URL 로 만든다 — 앱의 브라우저 클라이언트가 실제로 쓰는 형식.
//   실행: node --experimental-strip-types --test __tests__/qa/member-hint.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { register } from "node:module";
import { createChunks, stringToBase64URL } from "@supabase/ssr";

register("../telemetry/node-loader.mjs", import.meta.url);

const { FOR_MEMBER_CLASS, FOR_NONMEMBER_CLASS, MEMBER_HINT_ATTRIBUTE, MEMBER_HINT_STYLE, memberHintCookieName, memberHintFromCookie, memberHintInlineScript } =
  await import("../../lib/member-hint.ts");

const NAME = "sb-testprojectref-auth-token";
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function jwt(claims: Record<string, unknown>): string {
  return `${stringToBase64URL(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${stringToBase64URL(JSON.stringify(claims))}.signature`;
}

function session(isAnonymous: boolean | undefined, extra: Record<string, unknown> = {}) {
  return {
    access_token: jwt({ sub: "5b0b4a6e-6d3a-4f0e-9b0a-1f2e3d4c5b6a", is_anonymous: isAnonymous ?? true }),
    refresh_token: "refresh-token",
    token_type: "bearer",
    user: {
      id: "5b0b4a6e-6d3a-4f0e-9b0a-1f2e3d4c5b6a",
      ...(isAnonymous === undefined ? {} : { is_anonymous: isAnonymous }),
      // 한글(멀티바이트)·따옴표·역슬래시가 섞여도 base64url → JSON 구조가 깨지지 않아야 한다.
      user_metadata: { name: '프로지각대장 "부장" \\ 님', ...extra },
    },
  };
}

function cookiePairs(value: unknown, name = NAME): string[] {
  return createChunks(name, `base64-${stringToBase64URL(JSON.stringify(value))}`).map((c) => `${c.name}=${c.value}`);
}

/** 인라인 스크립트를 가짜 document 위에서 실행 — 속성을 달았는지 돌려준다. */
function runInlineScript(cookie: string, name = NAME): boolean {
  let set = false;
  const document = {
    cookie,
    documentElement: {
      setAttribute(attribute: string, value: string) {
        assert.equal(attribute, MEMBER_HINT_ATTRIBUTE);
        assert.equal(value, "");
        set = true;
      },
    },
  };
  vm.runInNewContext(memberHintInlineScript(name), { document, atob, decodeURIComponent, JSON, String });
  return set;
}

const padded = (chunks: number) => session(false, { pad: "가".repeat(1100 * chunks) });

const CASES: [label: string, cookie: string, expected: boolean][] = [
  ["쿠키 없음", "", false],
  ["다른 쿠키만", "theme=dark; bp_visit=1", false],
  ["회원(청크 2개 이상)", cookiePairs(padded(1)).join("; "), true],
  ["익명", cookiePairs(session(true, { pad: "가".repeat(900) })).join("; "), false],
  ["회원(단일 쿠키)", cookiePairs({ access_token: jwt({ is_anonymous: false }), user: { is_anonymous: false } }).join("; "), true],
  ["회원 — 청크 순서가 섞이고 다른 쿠키 사이에 있음", ["a=1", ...cookiePairs(padded(2)).reverse(), "b=x=y"].join("; "), true],
  ["회원 — 청크 11개 이상(.10 이 .9 뒤)", cookiePairs(padded(12)).join("; "), true],
  ["PKCE code-verifier 쿠키는 무시", [`${NAME}-code-verifier=abc`, ...cookiePairs(padded(1))].join("; "), true],
  ["code-verifier 쿠키만", `${NAME}-code-verifier=abc`, false],
  ["다른 프로젝트의 세션 쿠키", cookiePairs(padded(1), "sb-otherref-auth-token").join("; "), false],
  ["가운데 청크 누락", cookiePairs(padded(3)).filter((_, i) => i !== 1).join("; "), false],
  ["잘못된 청크 접미사", cookiePairs(padded(1)).join("; ").replace(`${NAME}.1=`, `${NAME}.01=`), false],
  ["단일 쿠키와 청크가 같이 있음", [`${NAME}=base64-e30`, ...cookiePairs(padded(1))].join("; "), false],
  ["빈 청크 값", `${NAME}.0=`, false],
  ["깨진 base64", `${NAME}=base64-@@@@`, false],
  ["JSON 이 객체가 아님", `${NAME}=base64-${stringToBase64URL("null")}`, false],
  ["user 없음 → access token 클레임(회원)", cookiePairs({ access_token: jwt({ is_anonymous: false }), refresh_token: "r" }).join("; "), true],
  ["user 없음 → access token 클레임(익명)", cookiePairs({ access_token: jwt({ is_anonymous: true }), refresh_token: "r" }).join("; "), false],
  ["user·access token 둘 다 판별 불가", cookiePairs({ refresh_token: "r" }).join("; "), false],
  ["base64- 접두가 없는 URI 인코딩 JSON", `${NAME}=${encodeURIComponent(JSON.stringify({ user: { is_anonymous: false } }))}`, true],
];

test("회원 힌트: 인라인 스크립트와 memberHintFromCookie 가 실제 쿠키 형식 행렬에서 같은 결과를 낸다", () => {
  assert.ok(cookiePairs(padded(1)).length >= 2, "청크 분할이 실제로 일어나는 크기");
  assert.ok(cookiePairs(padded(12)).length >= 11, "두 자리 청크 번호까지");
  for (const [label, cookie, expected] of CASES) {
    assert.equal(memberHintFromCookie(cookie, NAME), expected, `함수: ${label}`);
    assert.equal(runInlineScript(cookie), expected, `인라인 스크립트: ${label}`);
  }
});

test("인라인 스크립트: 한 줄 ES5(브라우저 호환) · 스크립트 종료 태그를 만들 수 없다 · 실패해도 던지지 않는다", () => {
  const script = memberHintInlineScript(NAME);
  assert.doesNotMatch(script, /\n/);
  assert.doesNotMatch(script, /=>|\bconst\b|\blet\b|`|\?\.|\?\?/, "ES5 문법만");
  assert.doesNotMatch(script, /<\/script|<!--/i);
  assert.doesNotMatch(memberHintInlineScript('x"</script><script>alert(1)//'), /<\/script/i, "이름 리터럴 이스케이프");
  // document 가 아예 없어도(실행 환경 이상) 예외가 새지 않는다.
  assert.doesNotThrow(() => vm.runInNewContext(script, {}));
});

test("쿠키 이름: 공개 env 가 없거나 URL 이 아니면 null — 루트 레이아웃 prerender 에서 던지지 않는다(CI 빌드는 env 없이 돈다)", () => {
  assert.equal(memberHintCookieName("https://abcdefghijklmnop.supabase.co"), "sb-abcdefghijklmnop-auth-token");
  assert.equal(memberHintCookieName(undefined), null);
  assert.equal(memberHintCookieName(""), null);
  assert.equal(memberHintCookieName("not a url"), null);
  // 이 테스트 프로세스에도 NEXT_PUBLIC_SUPABASE_URL 이 없다 — 기본 인자 경로가 던지지 않아야 한다.
  assert.doesNotThrow(() => memberHintCookieName());
});

test("루트 레이아웃: <head> 인라인 스크립트 + <html suppressHydrationWarning> + 개발 모드 재적용 컴포넌트", () => {
  const layout = source("app/layout.tsx");
  assert.match(layout, /<html lang="ko" className="h-full antialiased" suppressHydrationWarning>/);
  assert.match(layout, /const memberHintCookie = memberHintCookieName\(\);/);
  assert.match(
    layout,
    /<head>[\s\S]*\{memberHintCookie !== null && \(\s*<script dangerouslySetInnerHTML=\{\{ __html: memberHintInlineScript\(memberHintCookie\) \}\} \/>\s*\)\}\s*<\/head>/,
  );
  assert.match(layout, /<body className="min-h-full flex flex-col">\s*<MemberHintSync \/>/);
  const sync = source("components/MemberHintSync.tsx");
  assert.match(
    sync,
    /useLayoutEffect\(\(\) => \{\s*const cookieName = memberHintCookieName\(\);\s*if \(cookieName !== null\) applyMemberHint\(memberHintFromCookie\(document\.cookie, cookieName\)\);/,
  );
  // 표시 규칙은 스타일시트가 아니라 <head> 인라인 <style> — 스크립트보다 앞(같은 <head>), env 와 무관하게 항상 들어간다.
  assert.match(
    layout,
    /<head>[\s\S]*<style dangerouslySetInnerHTML=\{\{ __html: MEMBER_HINT_STYLE \}\} \/>\s*\{memberHintCookie !== null && \(/,
  );
  assert.equal(
    MEMBER_HINT_STYLE,
    `[${MEMBER_HINT_ATTRIBUTE}] .${FOR_NONMEMBER_CLASS}{display:none!important}html:not([${MEMBER_HINT_ATTRIBUTE}]) .${FOR_MEMBER_CLASS}{display:none!important}`,
  );
  assert.doesNotMatch(MEMBER_HINT_STYLE, /<|>\s*\//, "style 종료 태그를 만들 수 없다");
  // v1.51 사고 재발 방지: 첫 페인트를 좌우하는 규칙을 Tailwind 변형·globals.css 에 두지 않는다
  // (Vercel 이 빌드 캐시를 복원한 빌드에서 새 @custom-variant 유틸 규칙이 CSS 에 생성되지 않아 회원에게 비회원 홈이 고정으로 보였다).
  assert.doesNotMatch(source("app/globals.css"), /member-hint/);
  for (const file of ["app/page.tsx", "components/home/HomeCharacterRow.tsx", "components/GameOverModal.tsx"]) {
    assert.doesNotMatch(source(file), /member-hint:/, `${file}: Tailwind 변형 사용 금지`);
  }
  // 홈은 정적 페이지로 남는다 — 서버에서 쿠키를 읽지 않는다.
  assert.doesNotMatch(layout, /cookies\(\)|headers\(\)/);
  assert.doesNotMatch(source("app/page.tsx"), /cookies\(\)|headers\(\)/);
});

test("게임 종료 모달: 프로필 확인 전에는 회원 힌트를 따르고, 확인되면 힌트도 맞춘다", () => {
  const modal = source("components/GameOverModal.tsx");
  assert.match(modal, /const \[isLoggedIn, setIsLoggedIn\] = useState<boolean \| null>\(null\);/);
  assert.match(modal, /const nextPlay = \(isLoggedIn \?\? readMemberHint\(\)\)\s*\? \{ kind: "member" as const, href: "\/gallery"/);
  assert.match(modal, /setIsLoggedIn\(p\.isLoggedIn\);\s*applyMemberHint\(p\.isLoggedIn\);/);
  // 닫힌 모달은 아무것도 그리지 않으므로(서버 HTML 에도 없음) 렌더 중 힌트 읽기가 hydrate 불일치를 만들지 않는다.
  assert.ok(modal.indexOf("if (!open) return null;") < modal.indexOf("const nextPlay ="));
});
