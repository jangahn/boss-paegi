// member-hint.ts — 회원 힌트(v1.51): "이 브라우저는 회원(비익명) 세션인가"를 세션 쿠키만으로 **첫 페인트 전에** 동기 판별한다.
//
// 배경: 홈은 정적 페이지라 서버 HTML 이 로그인 상태를 모른다. hydrate 뒤에 세션을 읽어 화면을 바꾸면 회원은 그동안 비회원 화면을
//   본다(프로드 실측: 데스크톱 0.15~0.41초, 모바일 0.82~1.54초). 그래서 상태에 따라 달라지는 영역은 두 상태를 정적 HTML 에 같이
//   넣고, <head> 의 동기 인라인 스크립트가 <html data-member-hint> 를 달아 CSS(`member-hint:` 변형, app/globals.css)가 하나만
//   보이게 한다 — Next 가이드 「preventing flash before hydration」의 Themes 방식. 홈은 정적 그대로다.
// 힌트는 **표시 전용**이다. 권위 판정은 여전히 getSession()·getMyProfile()·서버 proxy 가 하고, 확정되면 applyMemberHint 로 맞춘다.
//   힌트가 틀려도 달라지는 것은 링크뿐이고 회원 전용 경로는 proxy 가 다시 막는다.
// 쿠키 형식(@supabase/ssr: `<이름>` 단일 또는 `<이름>.0..N` 청크, 값 = "base64-" + base64url(JSON))은
//   lib/supabase/session-cookie.ts readSupabaseSessionCookie 와 같은 규칙으로 읽는다(형식이 어긋나면 힌트 없음 = 비회원 화면).
//   인라인 스크립트(ES5 문자열)와 memberHintFromCookie 는 같은 알고리즘의 두 구현 — __tests__/qa/member-hint.test.ts 가
//   @supabase/ssr createChunks 로 만든 실제 형식의 쿠키 행렬에서 두 구현의 결과 일치를 고정한다.
import { PUBLIC_ENV } from "@/lib/env";
import { supabaseAuthCookieName } from "@/lib/supabase/session-cookie";

export const MEMBER_HINT_ATTRIBUTE = "data-member-hint";

/**
 * 세션 쿠키 이름 — `sb-<프로젝트 ref>-auth-token`(쿠키 이름을 바꾸는 옵션은 쓰지 않는다, lib/supabase/auth-cookie-options.ts).
 * 공개 env 가 없거나 URL 이 아니면 null — 루트 레이아웃이 전 페이지 prerender 에서 부르므로 **던지면 안 된다**
 * (CI 의 `next build` 는 NEXT_PUBLIC_SUPABASE_URL 없이 돈다 — v1.51 1차 CI 가 이 때문에 전 페이지 prerender 실패).
 * null 이면 힌트 없이 동작한다(= 종전처럼 hydrate 뒤 교체).
 */
export function memberHintCookieName(supabaseUrl: string | undefined = PUBLIC_ENV.SUPABASE_URL): string | null {
  try {
    return supabaseUrl ? supabaseAuthCookieName(supabaseUrl) : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  // 길이 % 4 = 0 → "", 2 → "==", 3 → "=" (1 은 잘못된 입력 → atob 가 던진다)
  return atob(base64 + "===".slice((base64.length + 3) % 4));
}

/**
 * `document.cookie` 문자열에서 회원(비익명) 세션 여부를 판별한다. 판별할 수 없으면 false(= 비회원 화면).
 * 서명·만료는 보지 않는다 — 표시용 힌트일 뿐이다.
 */
export function memberHintFromCookie(cookieHeader: string, cookieName: string): boolean {
  try {
    const parts = cookieHeader ? cookieHeader.split(/; */) : [];
    let exact: string | null = null;
    const chunks: (string | undefined)[] = [];
    let count = 0;
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (key === cookieName) {
        if (exact !== null) return false;
        exact = value;
      } else if (key.indexOf(`${cookieName}.`) === 0) {
        const suffix = key.slice(cookieName.length + 1);
        if (!/^(?:0|[1-9]\d{0,2})$/.test(suffix) || chunks[Number(suffix)] !== undefined || !value) return false;
        chunks[Number(suffix)] = value;
        count += 1;
      }
    }
    if (exact !== null && count > 0) return false;
    let combined = exact;
    if (combined === null) {
      if (count === 0) return false;
      combined = "";
      for (let index = 0; index < count; index += 1) {
        const chunk = chunks[index];
        if (chunk === undefined) return false;
        combined += chunk;
      }
    }
    const session: unknown = JSON.parse(
      combined.indexOf("base64-") === 0 ? decodeBase64Url(combined.slice(7)) : decodeURIComponent(combined),
    );
    if (session === null || typeof session !== "object") return false;
    const { user, access_token: accessToken } = session as { user?: unknown; access_token?: unknown };
    let anonymous: unknown =
      user !== null && typeof user === "object" ? (user as { is_anonymous?: unknown }).is_anonymous : undefined;
    if (typeof anonymous !== "boolean") {
      // user 가 없는 저장 형식 대비 — access token 의 is_anonymous 클레임.
      const claims: unknown = JSON.parse(decodeBase64Url(String(accessToken).split(".")[1]));
      anonymous = claims !== null && typeof claims === "object" ? (claims as { is_anonymous?: unknown }).is_anonymous : undefined;
    }
    return anonymous === false;
  } catch {
    return false;
  }
}

/**
 * <head> 에 넣는 동기 인라인 스크립트(ES5) — memberHintFromCookie 와 같은 알고리즘. HTML 파싱 중, 첫 페인트 전에 실행된다.
 * 문서 로드마다 한 번 실행된다(로그인·로그아웃은 전부 문서 로드를 거친다: OAuth 리다이렉트, signOut 의 location.href).
 */
export function memberHintInlineScript(cookieName: string): string {
  // 코드 안의 비교 연산자 `<` 는 그대로 둔다(문자열 밖에서는 \u 이스케이프가 안 된다) — 이름 리터럴만 </script 주입을 막는다.
  const nameLiteral = JSON.stringify(cookieName).replace(/</g, "\\u003c");
  return `
(function () {
  try {
    var name = ${nameLiteral};
    var parts = document.cookie ? document.cookie.split(/; */) : [];
    var exact = null, chunks = [], count = 0;
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq < 0) continue;
      var key = parts[i].slice(0, eq), value = parts[i].slice(eq + 1);
      if (key === name) {
        if (exact !== null) return;
        exact = value;
      } else if (key.indexOf(name + ".") === 0) {
        var suffix = key.slice(name.length + 1);
        if (!/^(?:0|[1-9]\\d{0,2})$/.test(suffix) || chunks[+suffix] !== undefined || !value) return;
        chunks[+suffix] = value;
        count++;
      }
    }
    if (exact !== null && count) return;
    var combined = exact;
    if (combined === null) {
      if (!count) return;
      combined = "";
      for (var j = 0; j < count; j++) {
        if (chunks[j] === undefined) return;
        combined += chunks[j];
      }
    }
    var decode = function (s) {
      s = s.replace(/-/g, "+").replace(/_/g, "/");
      return atob(s + "===".slice((s.length + 3) % 4));
    };
    var session = JSON.parse(combined.indexOf("base64-") === 0 ? decode(combined.slice(7)) : decodeURIComponent(combined));
    if (session === null || typeof session !== "object") return;
    var user = session.user;
    var anonymous = user !== null && typeof user === "object" ? user.is_anonymous : undefined;
    if (typeof anonymous !== "boolean") {
      var claims = JSON.parse(decode(String(session.access_token).split(".")[1]));
      anonymous = claims !== null && typeof claims === "object" ? claims.is_anonymous : undefined;
    }
    if (anonymous === false) document.documentElement.setAttribute(${JSON.stringify(MEMBER_HINT_ATTRIBUTE)}, "");
  } catch (e) {}
})();
`.replace(/\n\s*/g, "");
}

/** 지금 화면이 따르는 회원 힌트(브라우저 전용 — 서버에서는 false). */
export function readMemberHint(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(MEMBER_HINT_ATTRIBUTE);
}

/** 확정된 로그인 상태로 힌트를 맞춘다(getSession·getMyProfile 결과가 나온 곳에서 호출). */
export function applyMemberHint(isMember: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(MEMBER_HINT_ATTRIBUTE, isMember);
}
