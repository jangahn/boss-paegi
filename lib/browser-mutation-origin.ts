const STATE_CHANGING_METHODS = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const FETCH_SITE_VALUES = new Set([
  "same-origin",
  "same-site",
  "cross-site",
  "none",
]);

/**
 * Only browser-facing API mutations need this check. GET/HEAD/OPTIONS remain
 * available for normal navigation, reads, and CORS-denied preflight behavior.
 */
export function isBrowserApiMutation(
  pathname: string,
  method: string,
): boolean {
  return (
    pathname.startsWith("/api/") &&
    STATE_CHANGING_METHODS.has(method.toUpperCase())
  );
}

/**
 * CSRF boundary for cookie-authenticated Route Handlers.
 *
 * Modern browsers send Origin on non-GET fetch/form requests and Fetch
 * Metadata cannot be set by page JavaScript. Exact origin comparison blocks
 * both cross-site and sibling-subdomain requests. Server-to-server callers
 * (cron, signed provider callbacks) commonly send neither header and remain
 * compatible; signed webhooks bypass the proxy before this helper.
 */
export function browserMutationOriginAllowed(
  requestUrl: string,
  headers: Pick<Headers, "get">,
): boolean {
  const rawFetchSite = headers.get("sec-fetch-site");
  const fetchSite = rawFetchSite?.trim().toLowerCase() ?? null;
  if (fetchSite !== null && !FETCH_SITE_VALUES.has(fetchSite)) return false;
  if (fetchSite === "cross-site") return false;

  const origin = headers.get("origin");
  if (origin !== null) {
    try {
      const parsedOrigin = new URL(origin).origin;
      const parsedRequest = new URL(requestUrl);
      if (parsedOrigin === parsedRequest.origin) return true;

      // `next dev --hostname 0.0.0.0` may canonicalize request.url to
      // localhost even when the browser connected to 127.0.0.1/LAN IP.
      // Host is the HTTP request authority the cookie was actually sent to.
      const host = headers.get("host");
      if (!host || /[,\s/\\]/.test(host)) return false;
      return parsedOrigin === new URL(`${parsedRequest.protocol}//${host}`).origin;
    } catch {
      return false;
    }
  }

  // A browser-declared sibling site without Origin is not needed by this app
  // and must not silently downgrade the exact-origin check. Headerless machine
  // clients and same-origin/explicit user navigations remain compatible.
  return fetchSite !== "same-site";
}
