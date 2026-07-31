import "server-only";
import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import type { NextResponse } from "next/server";
import { PUBLIC_ENV } from "@/lib/env";
import { supabaseAuthCookieOptions } from "@/lib/supabase/auth-cookie-options";
import { createAuthTransportFetch } from "@/lib/http/auth-transport-fetch";

export type DeferredCookieWrite = {
  name: string;
  value: string;
  options: CookieOptions;
};

/**
 * Route-local virtual cookie jar. Auth exchange writes are visible to later
 * calls on the same Supabase client but are not attached to the browser
 * response until the caller has durably finalized its surrounding saga.
 */
export function createDeferredServerClient(
  initialCookies: readonly { name: string; value: string }[],
) {
  const jar = new Map(
    initialCookies.map(({ name, value }) => [name, value]),
  );
  const pending = new Map<string, DeferredCookieWrite>();
  const client = createServerClient(
    PUBLIC_ENV.SUPABASE_URL,
    PUBLIC_ENV.SUPABASE_ANON_KEY,
    {
      cookieOptions: supabaseAuthCookieOptions(),
      global: {
        fetch: createAuthTransportFetch({
          supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
        }),
      },
      cookies: {
        getAll: () =>
          Array.from(jar, ([name, value]) => ({ name, value })),
        setAll: (toSet) => {
          for (const write of toSet) {
            if (
              write.value === "" ||
              write.options.maxAge === 0
            ) {
              jar.delete(write.name);
            } else {
              jar.set(write.name, write.value);
            }
            pending.set(write.name, {
              name: write.name,
              value: write.value,
              options: { ...write.options },
            });
          }
        },
      },
    },
  );

  return {
    client,
    pendingWrites: (): readonly DeferredCookieWrite[] =>
      Array.from(pending.values()),
    applyPendingCookies(response: NextResponse): void {
      for (const write of pending.values()) {
        response.cookies.set(
          write.name,
          write.value,
          write.options,
        );
      }
    },
  };
}
