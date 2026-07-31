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

export function parsePrepareSignupAck(
  value: unknown,
  expectedFlowId: string,
): string | null {
  return (
    exactObject(value, ["ok", "flowId"]) &&
    value.ok === true &&
    value.flowId === expectedFlowId
  )
    ? expectedFlowId
    : null;
}

export function parsePrepareSignupActiveConflict(
  value: unknown,
): boolean {
  return (
    exactObject(value, ["error"]) &&
    value.error === "oauth_flow_already_active"
  );
}

/**
 * Supabase's default OAuth method navigates before returning its acknowledgement.
 * Callers use skipBrowserRedirect, validate this URL, then navigate themselves.
 * In the pinned auth-js, signInWithOAuth's URL builder receives only
 * redirectTo/scopes/queryParams, so skipBrowserRedirect never appends a
 * skip_http_redirect parameter; it only suppresses the automatic navigation.
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
    codeChallenge: string;
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
    const expectedKeys =
      expected.provider === "google"
        ? [
            "provider",
            "redirect_to",
            "code_challenge",
            "code_challenge_method",
            "prompt",
          ]
        : [
            "provider",
            "redirect_to",
            "code_challenge",
            "code_challenge_method",
          ];
    const entries = [...target.searchParams.entries()];
    const authorizePath = new URL(
      "auth/v1/authorize",
      authority.href.endsWith("/") ? authority.href : `${authority.href}/`,
    ).pathname;
    if (
      target.origin !== authority.origin ||
      target.pathname !== authorizePath ||
      target.username !== "" ||
      target.password !== "" ||
      target.hash !== "" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(expected.codeChallenge) ||
      entries.length !== expectedKeys.length ||
      expectedKeys.some(
        (key) =>
          target.searchParams.getAll(key).length !== 1,
      ) ||
      entries.some(([key]) => !expectedKeys.includes(key)) ||
      target.searchParams.get("provider") !==
        expected.provider ||
      target.searchParams.get("redirect_to") !== redirect.href ||
      target.searchParams.get("code_challenge") !==
        expected.codeChallenge ||
      target.searchParams.get("code_challenge_method") !==
        "s256" ||
      (expected.provider === "google"
        ? target.searchParams.get("prompt") !== "select_account"
        : target.searchParams.has("prompt"))
    ) {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}
