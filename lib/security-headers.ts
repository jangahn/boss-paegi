/**
 * Global response hardening that is safe for static/ISR pages and the
 * PortOne/OAuth popup flows.
 *
 * Deliberately do not add script-src/style-src here. A nonce-based policy
 * would force every static page to render dynamically, while an unsafe-inline
 * policy would give a misleading impression of script-injection protection.
 * The enforced directives below still close clickjacking, object embedding,
 * and hostile <base> rewriting without changing the current rendering model.
 * form-action is intentionally omitted because third-party payment SDKs can
 * submit provider-owned forms from the application document.
 */
export const GLOBAL_SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value:
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  },
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
] as const;

/**
 * Route Handlers are request-time by default, but an explicit response header
 * is still required to keep browser/CDN/proxy behavior invariant across Next
 * and platform upgrades. Public read routes that intentionally use Vercel's
 * separate CDN cache header may override this in their own response; the
 * browser-facing default remains fail-closed.
 */
export const API_NO_STORE_HEADERS = [
  {
    key: "Cache-Control",
    value: "private, no-store, max-age=0",
  },
] as const;
