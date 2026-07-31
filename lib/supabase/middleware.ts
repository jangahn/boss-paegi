import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_ENV } from "@/lib/env";
import { supabaseAuthCookieOptions } from "@/lib/supabase/auth-cookie-options";
import { createServerAuthReadFetch } from "@/lib/http/server-auth-read-fetch";
import { readCurrentAuthSessionState } from "@/lib/auth-session-live";

/**
 * Next.js proxy helper — validates an already-issued Supabase access token
 * without refreshing or writing browser credentials.
 *
 * A generic server response is outside the browser's Web Lock, so even a
 * correct refresh could arrive after a newer login/callback/signout response
 * and overwrite it. Refresh ownership therefore lives exclusively in the
 * browser singleton.
 * getUser() 결과(user) + supabase 클라이언트도 함께 반환 — proxy 의 동의 게이팅이
 * member_accounts/profiles self-read(RLS) 를 재생성 없이 쓰도록.
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request });

  const supabase = createServerClient(
    PUBLIC_ENV.SUPABASE_URL,
    PUBLIC_ENV.SUPABASE_ANON_KEY,
    {
      cookieOptions: supabaseAuthCookieOptions(),
      global: {
        fetch: createServerAuthReadFetch({
          supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
        }),
      },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: () => {},
      },
    }
  );

  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();
  let user = authError ? null : authUser;
  if (user) {
    const sessionState = await readCurrentAuthSessionState(() =>
      supabase.rpc("oauth_current_auth_session_live"),
    );
    if (sessionState.kind !== "live") user = null;
  }
  return { response, user, supabase };
}
