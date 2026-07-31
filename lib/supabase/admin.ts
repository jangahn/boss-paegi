import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { createAuthTransportFetch } from "@/lib/http/auth-transport-fetch";

export function createAdminClient() {
  return createSupabaseClient(
    PUBLIC_ENV.SUPABASE_URL,
    SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: createAuthTransportFetch({
          supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
        }),
      },
    }
  );
}
