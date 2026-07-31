import { createAuthTransportFetch } from "./auth-transport-fetch.ts";

/**
 * Server-render and generic API clients may validate an already-issued access
 * token, but they must never rotate browser session credentials. A delayed
 * server response cannot participate in the browser's Web Locks and could
 * otherwise overwrite a newer anonymous, reviewer, OAuth, or signed-out
 * session with stale Set-Cookie headers.
 */
export function createServerAuthReadFetch(options: {
  supabaseUrl: string;
  fetcher?: typeof fetch;
}): typeof fetch {
  const baseUrl = new URL(options.supabaseUrl);
  const authPrefix = new URL("/auth/v1/", baseUrl);
  const userUrl = new URL("/auth/v1/user", baseUrl);
  const bounded = createAuthTransportFetch({
    supabaseUrl: baseUrl.toString(),
    fetcher: options.fetcher,
  });

  return ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(
        input instanceof Request ? input.url : String(input),
      );
    } catch {
      return bounded(input, init);
    }
    if (
      url.origin === authPrefix.origin &&
      url.pathname.startsWith(authPrefix.pathname)
    ) {
      const method = (
        init?.method ??
        (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (
        url.pathname !== userUrl.pathname ||
        url.search !== "" ||
        method !== "GET"
      ) {
        // A transport rejection is retryable to auth-js. In particular, an
        // expired SSR cookie makes getUser() retry the forbidden refresh
        // request eight times before it gives up. Return one definitive Auth
        // response instead: generic server rendering still cannot rotate a
        // browser credential, while the proxy can hand the exact session to
        // the browser reconciliation page without a request-wide stall.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "server_auth_session_mutation_blocked",
              error_description:
                "server auth session mutation blocked",
            }),
            {
              status: 400,
              headers: {
                "Cache-Control": "private, no-store, max-age=0",
                "Content-Type": "application/json",
              },
            },
          ),
        );
      }
    }
    return bounded(input, init);
  }) as typeof fetch;
}
