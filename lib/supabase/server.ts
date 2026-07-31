import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { PUBLIC_ENV } from "@/lib/env";
import { supabaseAuthCookieOptions } from "@/lib/supabase/auth-cookie-options";
import { createServerAuthReadFetch } from "@/lib/http/server-auth-read-fetch";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
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
        getAll: () => cookieStore.getAll(),
        // Generic server reads are deliberately unable to emit auth cookies.
        // Browser-coordinated writers and the deferred OAuth callback are the
        // only session mutation boundaries.
        setAll: () => {},
      },
    }
  );
}
