import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isMemberOnlyPath, isConsentExempt, isWebhookPath } from "@/lib/routes";
import { readCurrentLegalVersionsEdge } from "@/lib/legal/edge-versions";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { safeNext } from "@/lib/oauth-metadata";
import { MIGRATE_COOKIE } from "@/lib/cookies";

// 글로벌 동의 게이트(렌더 전) — "로그인은 자유, 동의는 모든 페이지 진입 시 강제".
//  · anon: 공개 페이지 + /login 허용, 회원전용 → /login.
//  · 로그인+미동의: 모든(비예외) 페이지 → /consent (우회 불가, 동의/로그아웃만).
//  · 로그인+완료: 정상. /login 접근 시 next(또는 /)로.
// 게이트는 GET/HEAD 문서/RSC 내비에만 — POST/Server Action 은 endpoint requireMember 가 처리.
// 정적/_next 는 matcher 제외, /api·/auth·/consent 는 isConsentExempt.

/** updateSession 갱신 쿠키 보존 + no-store. (세션 refresh 직후 루프·구버전 redirect 재사용 방지.) */
function redirectKeep(request: NextRequest, response: NextResponse, dest: string): NextResponse {
  const res = NextResponse.redirect(new URL(dest, request.url));
  response.cookies.getAll().forEach((c) => res.cookies.set(c));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** 삭제 계정/로그아웃 — sb-* auth 쿠키 + MIGRATE 만료(잔존 세션 루프 방지) + no-store. */
function signoutRedirect(request: NextRequest, dest: string): NextResponse {
  const res = NextResponse.redirect(new URL(dest, request.url));
  for (const c of request.cookies.getAll()) {
    if (c.name.startsWith("sb-")) res.cookies.set(c.name, "", { maxAge: 0, path: "/" });
  }
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** 미동의 → /consent?next= 의 next: /login 이면 login 의 next param, 아니면 현재 path+search. 둘 다 safeNext. */
function consentNext(request: NextRequest): string {
  if (request.nextUrl.pathname === "/login") {
    return safeNext(request.nextUrl.searchParams.get("next"));
  }
  return safeNext(request.nextUrl.pathname + request.nextUrl.search);
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // 0. 결제 webhook — updateSession 전에 즉시 통과(세션 실패가 외부 webhook 응답을 막지 않음).
  if (isWebhookPath(path)) return NextResponse.next();

  const { response, user, supabase } = await updateSession(request);
  const method = request.method;

  // 1. 익명/무세션이 회원전용 페이지 → /login (기존).
  if (isMemberOnlyPath(path) && (!user || user.is_anonymous)) {
    return redirectKeep(request, response, `/login?next=${encodeURIComponent(path)}`);
  }

  // 2. 동의 게이트는 GET/HEAD 문서/RSC 내비에만. (POST/PUT/PATCH/DELETE 는 endpoint requireMember.)
  if (method !== "GET" && method !== "HEAD") return response;

  // 3. 예외 경로(/consent·/api·/auth) → 통과.
  if (isConsentExempt(path)) return response;

  // 4. anon → 공개 + /login 허용.
  if (!user || user.is_anonymous) return response;

  // 5. 로그인(non-anon) — deleted/member self-read(병렬, maybeSingle).
  const [profRes, memRes] = await Promise.all([
    supabase.from("profiles").select("deleted_at").eq("id", user.id).maybeSingle(),
    supabase
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  // 실제 조회 실패(DB/RLS/network) → fail-closed(/consent). (no-row 는 error 아님 — 신규 정상.)
  if (profRes.error || memRes.error) {
    return redirectKeep(request, response, `/consent?next=${encodeURIComponent(consentNext(request))}`);
  }
  // 삭제 계정 잔존 세션 → auth 쿠키 clear + /login?error=account_deleted (루프 방지).
  if ((profRes.data as { deleted_at?: string | null } | null)?.deleted_at) {
    return signoutRedirect(request, "/login?error=account_deleted");
  }

  // no-row=정상(신규 OAuth 직후, 아직 member 없음) → member=null → age 필요 → /consent.
  const member = (memRes.data as ConsentMember) ?? null;
  let curr: { terms: number | null; privacy: number | null };
  try {
    curr = await readCurrentLegalVersionsEdge();
  } catch {
    curr = { terms: null, privacy: null }; // 버전 조회 실패 → fail-open(stamp 회원 통째 잠금 방지)
  }

  if (missingConsentItems(member, curr).length > 0) {
    return redirectKeep(request, response, `/consent?next=${encodeURIComponent(consentNext(request))}`);
  }

  // 동의완료 — /login 은 anon 전용이므로 로그인 사용자는 next(또는 /)로.
  if (path === "/login") {
    return redirectKeep(request, response, safeNext(request.nextUrl.searchParams.get("next")));
  }
  return response;
}

export const config = {
  // 동의 게이트/세션 리프레시는 **문서/RSC 내비**에만. 정적 asset·_next·특수파일 제외
  // (미동의 사용자의 JS/CSS/img/font 요청이 /consent 로 redirect → 페이지 깨짐 방지).
  matcher: [
    "/((?!_next/|monitoring|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest|opengraph-image|twitter-image|icon|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|json|woff|woff2)$).*)",
  ],
};
