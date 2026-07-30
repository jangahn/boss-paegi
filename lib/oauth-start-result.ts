export type OAuthStartProvider = "kakao" | "google";

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

export function isExactPrepareSignupAck(value: unknown): boolean {
  return exactObject(value, ["ok"]) && value.ok === true;
}

/**
 * Supabase's default OAuth method navigates before returning its acknowledgement.
 * Callers use skipBrowserRedirect, validate this URL, then navigate themselves.
 */
export function parseOAuthStartUrl(
  result: {
    data: unknown;
    error: unknown | null;
  },
  expected: {
    provider: OAuthStartProvider;
    supabaseUrl: string;
    redirectTo: string;
  },
): string | null {
  if (result.error !== null && result.error !== undefined) return null;
  if (!exactObject(result.data, ["provider", "url"])) return null;
  if (
    result.data.provider !== expected.provider ||
    typeof result.data.url !== "string" ||
    result.data.url.length === 0 ||
    result.data.url.length > 4096
  ) {
    return null;
  }

  try {
    const authority = new URL(expected.supabaseUrl);
    const redirect = new URL(expected.redirectTo);
    const target = new URL(result.data.url);
    const authorizePath = new URL(
      "auth/v1/authorize",
      authority.href.endsWith("/") ? authority.href : `${authority.href}/`,
    ).pathname;
    if (
      target.origin !== authority.origin ||
      target.pathname !== authorizePath ||
      target.username !== "" ||
      target.password !== "" ||
      target.searchParams.get("provider") !== expected.provider ||
      target.searchParams.get("redirect_to") !== redirect.href ||
      target.searchParams.get("skip_http_redirect") !== "true"
    ) {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}
