import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { PUBLIC_ENV } from "@/lib/env";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    PUBLIC_ENV.SUPABASE_URL,
    PUBLIC_ENV.SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Components can't set cookies; middleware refreshes them.
          }
        },
      },
    }
  );
}
