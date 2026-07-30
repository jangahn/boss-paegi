import { createBrowserClient } from "@supabase/ssr";
import { PUBLIC_ENV } from "@/lib/env";
import { supabaseAuthCookieOptions } from "@/lib/supabase/auth-cookie-options";
import { createAbortableFetch } from "@/lib/http/abortable-fetch";

export function createClient(signal?: AbortSignal) {
  return createBrowserClient(
    PUBLIC_ENV.SUPABASE_URL,
    PUBLIC_ENV.SUPABASE_ANON_KEY,
    {
      cookieOptions: supabaseAuthCookieOptions(),
      ...(signal
        ? {
            // A signal-bound client must not reuse the process-wide browser
            // singleton, whose fetch lifetime belongs to another operation.
            isSingleton: false,
            global: { fetch: createAbortableFetch(signal) },
          }
        : {}),
    },
  );
}
