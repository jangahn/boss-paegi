import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_ENV } from "@/lib/env";

/**
 * Next.js middleware helper — Supabase 세션 토큰 refresh.
 * 모든 요청에 대해 호출해서 만료된 세션을 갱신.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    PUBLIC_ENV.SUPABASE_URL,
    PUBLIC_ENV.SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();
  return response;
}
