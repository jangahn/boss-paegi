import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";

export function createAdminClient() {
  return createSupabaseClient(
    PUBLIC_ENV.SUPABASE_URL,
    SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
