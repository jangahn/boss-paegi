/**
 * Checkout is fail-closed across DB-first payment migrations. A deployment
 * must opt in explicitly only after the rollout and smoke gates pass.
 */
export function paymentCheckoutEnabled(
  value: unknown = process.env.PAYMENT_CHECKOUT_ENABLED,
): boolean {
  return value === "1";
}

export const PAYMENT_ROLLOUT_PROJECT_HEADER =
  "X-Boss-Paegi-Supabase-Project-Ref";
export const PAYMENT_ROLLOUT_COMMIT_HEADER =
  "X-Boss-Paegi-Build-Commit";

type DeploymentEnvironment = Readonly<
  Partial<
    Record<
      "NEXT_PUBLIC_SUPABASE_URL" | "VERCEL_GIT_COMMIT_SHA",
      string | undefined
    >
  >
>;

/**
 * Public, non-secret deployment identity used by the production migration
 * runner to bind the frozen HTTP deployment to the exact Supabase project it
 * is about to mutate. The project ref is already public in the browser
 * Supabase URL; the Git commit is public repository metadata.
 *
 * Return both fields or neither. A partially configured deployment must never
 * look authoritative to the rollout runner.
 */
export function paymentRolloutIdentityHeaders(
  env: DeploymentEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  },
): Readonly<Record<string, string>> {
  const commit = env.VERCEL_GIT_COMMIT_SHA?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) return {};

  let projectRef = "";
  try {
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      match === null
    ) {
      return {};
    }
    projectRef = match[1];
  } catch {
    return {};
  }

  return {
    [PAYMENT_ROLLOUT_PROJECT_HEADER]: projectRef,
    [PAYMENT_ROLLOUT_COMMIT_HEADER]: commit,
  };
}
