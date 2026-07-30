/**
 * Shared @supabase/ssr cookie policy.
 *
 * The browser SDK must read its token cookie, so HttpOnly cannot be enabled
 * without replacing the client-side auth architecture. Secure is nevertheless
 * mandatory on every production/preview HTTPS deployment; local `next dev`
 * remains HTTP-compatible.
 */
export function supabaseAuthCookieOptions(
  nodeEnv = process.env.NODE_ENV,
) {
  return {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: false,
    secure: nodeEnv === "production",
  };
}
