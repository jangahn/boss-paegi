import type { CreditProduct } from "@/lib/credit-products";

/**
 * Deliberate compile-time legal fence. An environment toggle alone cannot
 * open checkout until the separated affirmative withdrawal-limit confirmation
 * and immutable evidence contract is implemented and reviewed.
 */
export const WITHDRAWAL_LIMIT_EVIDENCE_IMPLEMENTED = true;

/**
 * Checkout is fail-closed across DB-first payment migrations. A deployment
 * must opt in explicitly after the expand/contract and smoke gates pass.
 */
export function paymentCheckoutEnabled(
  value: unknown = process.env.PAYMENT_CHECKOUT_ENABLED,
): boolean {
  return value === "1" && WITHDRAWAL_LIMIT_EVIDENCE_IMPLEMENTED;
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
 * runner to bind every frozen paid route to the exact Supabase project and
 * application build it is about to change.
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

export type CheckoutPayMode = "test" | "live";

/**
 * The checkout page tells the API which mode was rendered to the user. A
 * reviewer/config change between render and click must never silently turn a
 * TEST-labelled action into a LIVE payment (or the reverse).
 */
export function checkoutPayModeMatches(
  actualMode: CheckoutPayMode,
  expectedMode: unknown,
): expectedMode is CheckoutPayMode {
  return (
    (expectedMode === "test" || expectedMode === "live") &&
    expectedMode === actualMode
  );
}

/**
 * The product shown on the checkout page is an optimistic snapshot only.
 * Compare every user-visible/economic field with the fresh strict config
 * before creating an order so a publish between render and click cannot
 * silently change the amount, granted credits, or receipt name.
 */
export function checkoutProductSnapshotMatches(
  actual: CreditProduct,
  expected: unknown,
): expected is CreditProduct {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return false;
  }
  const value = expected as Record<string, unknown>;
  return (
    value.productId === actual.productId &&
    value.goodname === actual.goodname &&
    value.price === actual.price &&
    value.credits === actual.credits
  );
}
