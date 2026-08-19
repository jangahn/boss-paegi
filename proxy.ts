import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isMemberOnlyPath, isConsentExempt, isWebhookPath } from "@/lib/routes";
import { readCurrentLegalVersionsEdge } from "@/lib/legal/edge-versions";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { safeNext } from "@/lib/oauth-metadata";
import {
  cookieHeaderHasOAuthFlowBarrier,
} from "@/lib/cookies";
import {
  browserMutationOriginAllowed,
  isBrowserApiMutation,
} from "@/lib/browser-mutation-origin";
import { PUBLIC_ENV } from "@/lib/env";
import {
  fingerprintSupabaseAuthCookiePairs,
  readRawSupabaseAuthCookieNames,
  readRawSupabaseReconcileCookiePairs,
  readSupabaseAccessTokenExpiresAt,
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import {
  AUTH_RECONCILE_CAPABILITY_COOKIE,
  AUTH_RECONCILE_PROBE_ACK_HEADER,
  AUTH_RECONCILE_PROBE_HEADER,
  authReconcileCapabilityDigest,
  authReconcilePath,
  type AuthReconcileIntent,
} from "@/lib/auth-reconcile";

// 글로벌 동의 게이트(렌더 전) — "로그인은 자유, 동의는 모든 페이지 진입 시 강제".
//  · anon: 공개 페이지 + /login 허용, 회원전용 → /login.
//  · 로그인+미동의: 모든(비예외) 페이지 → /consent (우회 불가, 동의/로그아웃만).
//  · 로그인+완료: 정상. /login 접근 시 next(또는 /)로.
// 게이트는 GET/HEAD 문서/RSC 내비에만 — POST/Server Action 은 endpoint requireMember 가 처리.
// 정적/_next 는 matcher 제외, /api·/auth·/consent 는 isConsentExempt.

/**
 * Generic proxy work is intentionally cookie-read-only. A response that
 * started before an H-locked browser mutation must never arrive later with a
 * stale auth-cookie write or clear.
 */
function redirectNoCookie(request: NextRequest, dest: string): NextResponse {
  const res = NextResponse.redirect(new URL(dest, request.url));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** Browser reconciliation performs any session mutation under H then S. */
async function reconcileRedirect(
  request: NextRequest,
  intent: AuthReconcileIntent,
): Promise<NextResponse> {
  const capability = crypto.randomUUID();
  const input = {
    ...intent,
    capability,
    cookiePath: request.nextUrl.pathname,
    cookieNames: readRawSupabaseAuthCookieNames(
      request.headers.get("cookie"),
      PUBLIC_ENV.SUPABASE_URL,
    ),
  };
  const capabilityDigest =
    await authReconcileCapabilityDigest(input);
  const res = NextResponse.redirect(
    new URL(
      authReconcilePath(input),
      request.url,
    ),
    request.method === "GET" || request.method === "HEAD"
      ? 307
      : 303,
  );
  res.cookies.set(
    AUTH_RECONCILE_CAPABILITY_COOKIE,
    capabilityDigest,
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/auth/reconcile",
      maxAge: 90,
    },
  );
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

/**
 * A cleanup running under the browser's H→S lock probes both the original and
 * reconciliation pathnames before releasing the lock. Comparing the full
 * auth+verifier cookie-pair multiset catches a residual Path/Domain-scoped or
 * HttpOnly duplicate even when its name is identical to the valid root cookie.
 * The response never exposes values or their fingerprint.
 */
async function authCookieCleanupProbe(
  request: NextRequest,
): Promise<NextResponse | null> {
  const expected = request.headers.get(
    AUTH_RECONCILE_PROBE_HEADER,
  );
  if (
    request.method !== "HEAD" ||
    expected === null ||
    !/^[0-9a-f]{64}$/u.test(expected) ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  ) {
    return null;
  }
  const raw = readRawSupabaseReconcileCookiePairs(
    request.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  const actual =
    raw.kind === "invalid"
      ? null
      : await fingerprintSupabaseAuthCookiePairs(
          raw.kind === "present" ? raw.cookies : [],
        );
  const matched = actual !== null && actual === expected;
  const response = new NextResponse(null, {
    status: matched ? 204 : 409,
  });
  if (matched) {
    response.headers.set(
      AUTH_RECONCILE_PROBE_ACK_HEADER,
      "1",
    );
  }
  response.headers.set(
    "Cache-Control",
    "private, no-store, max-age=0",
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
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

  const cleanupProbe = await authCookieCleanupProbe(request);
  if (cleanupProbe !== null) return cleanupProbe;

  // OAuth authorization codes are bearer-like one-time credentials. This
  // header must cover even a malformed callback with no marker/proof, before
  // any same-origin asset/RSC request can inherit the full query as Referer.
  if (
    path === "/auth/callback" ||
    path.startsWith("/auth/callback/") ||
    path === "/auth/flow-pending" ||
    path === "/auth/reconcile"
  ) {
    const response = NextResponse.next({ request });
    response.headers.set(
      "Cache-Control",
      "private, no-store, max-age=0",
    );
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  // 0-1. 쿠키 인증 API mutation의 CSRF 경계. Origin이 있는 브라우저 요청은
  // exact same-origin만 허용하고, Fetch Metadata가 cross-site면 body/auth 조회 전에 차단한다.
  if (
    isBrowserApiMutation(path, request.method) &&
    !browserMutationOriginAllowed(request.url, request.headers)
  ) {
    return NextResponse.json(
      { error: "forbidden_origin" },
      {
        status: 403,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }

  // OAuth's visible marker is a session-mutation barrier. Let the callback
  // recovery/status/cancel surfaces run, but do not perform generic server
  // Auth work while that barrier exists. Generic server
  // clients are read-only too, so a request that started just before prepare
  // can never emit a delayed stale auth Set-Cookie after the callback.
  if (
    cookieHeaderHasOAuthFlowBarrier(
      request.headers.get("cookie"),
    )
  ) {
    const recoveryPath =
      path === "/auth/flow-pending" ||
      path === "/api/auth/prepare-signup" ||
      path.startsWith("/api/auth/oauth-flow/");
    if (recoveryPath) {
      const response = NextResponse.next({ request });
      response.headers.set(
        "Cache-Control",
        "private, no-store",
      );
      return response;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const next = safeNext(path + request.nextUrl.search);
      const response = NextResponse.redirect(
        new URL(
          `/auth/flow-pending?next=${encodeURIComponent(next)}`,
          request.url,
        ),
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    return NextResponse.json(
      { error: "oauth_flow_active" },
      {
        status: 409,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "Retry-After": "5",
        },
      },
    );
  }

  const rawAuthSession =
    await readSupabaseSessionCookieHeader(
      request.headers.get("cookie"),
      PUBLIC_ENV.SUPABASE_URL,
    );
  if (rawAuthSession.kind === "invalid") {
    return reconcileRedirect(request, {
      reason: "auth_session_invalid",
      next: safeNext(path + request.nextUrl.search),
      expectedUserId: null,
      expectedSessionId: null,
    });
  }

  const { response, user, supabase } =
    await updateSession(request);
  if (
    rawAuthSession.kind === "present" &&
    (
      !user ||
      user.id !== rawAuthSession.session.userId
    )
  ) {
    // 서명·구조가 유효한 쿠키의 **만료**는 손상이 아니다(v0.85): 만료만이 원인인
    // 공개(비회원전용) GET/HEAD 문서 요청은 격리 복구 인터스티셜 없이 익명 취급으로
    // 통과시키고, refresh 는 소유권자인 브라우저 싱글톤이 백그라운드로 수행한다 —
    // access token(1h) 만료 후 첫 재방문 전원이 /auth/reconcile 전체 사이클(문서
    // cold 2.5s + 잠금/프로브 + 전면 재로드)을 타던 지연의 근본 원인 제거.
    // 미만료인데 검증이 실패한 세션(폐기·대체·ledger non-live)·회원 전용 경로·
    // 비-GET/HEAD·identity 불일치는 종전대로 격리 복구로 보낸다. 만료-통과 중의
    // 동의 게이트는 판정 유예(익명과 동일 노출) — refresh 완료 후 다음 내비/RSC
    // 부터 종전과 동일하게 강제된다.
    const expiresAt = readSupabaseAccessTokenExpiresAt(
      rawAuthSession.session.accessToken,
    );
    const expiredOnly =
      !user &&
      expiresAt !== null &&
      expiresAt * 1000 <= Date.now();
    if (
      !expiredOnly ||
      isMemberOnlyPath(path) ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      return reconcileRedirect(request, {
        reason: "auth_session_check_required",
        next: safeNext(path + request.nextUrl.search),
        expectedUserId: rawAuthSession.session.userId,
        expectedSessionId:
          rawAuthSession.session.sessionId,
      });
    }
  }
  const method = request.method;

  // 1. 익명/무세션이 회원전용 페이지 → /login (기존).
  if (isMemberOnlyPath(path) && (!user || user.is_anonymous)) {
    const next = safeNext(path + request.nextUrl.search);
    return redirectNoCookie(
      request,
      `/login?next=${encodeURIComponent(next)}`,
    );
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
    return redirectNoCookie(request, `/consent?next=${encodeURIComponent(consentNext(request))}`);
  }
  // 삭제 계정 잔존 세션 → 브라우저가 H→S 하에서 exact session을 검증/정리.
  if ((profRes.data as { deleted_at?: string | null } | null)?.deleted_at) {
    if (
      rawAuthSession.kind !== "present" ||
      rawAuthSession.session.userId !== user.id
    ) {
      return reconcileRedirect(request, {
        reason: "auth_session_invalid",
        next: "/login?error=account_deleted",
        expectedUserId: null,
        expectedSessionId: null,
      });
    }
    return reconcileRedirect(request, {
      reason: "account_deleted",
      next: "/login?error=account_deleted",
      expectedUserId: rawAuthSession.session.userId,
      expectedSessionId:
        rawAuthSession.session.sessionId,
    });
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
    return redirectNoCookie(request, `/consent?next=${encodeURIComponent(consentNext(request))}`);
  }

  // 동의완료 — /login 은 anon 전용이므로 로그인 사용자는 next(또는 /)로.
  if (path === "/login") {
    return redirectNoCookie(request, safeNext(request.nextUrl.searchParams.get("next")));
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
