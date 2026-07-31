import type { CreditProduct } from "@/lib/credit-products";
import {
  DEPLOYMENT_IDENTITY_COMMIT_HEADER,
  DEPLOYMENT_IDENTITY_PROJECT_HEADER,
  DEPLOYMENT_IDENTITY_VERCEL_DEPLOYMENT_HEADER,
  DEPLOYMENT_IDENTITY_VERCEL_ENVIRONMENT_HEADER,
  DEPLOYMENT_IDENTITY_VERCEL_PROJECT_HEADER,
  DEPLOYMENT_IDENTITY_VERCEL_URL_HEADER,
  deploymentIdentityHeaders,
  type DeploymentIdentityEnvironment,
} from "../deployment-identity.ts";

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
  DEPLOYMENT_IDENTITY_PROJECT_HEADER;
export const PAYMENT_ROLLOUT_COMMIT_HEADER =
  DEPLOYMENT_IDENTITY_COMMIT_HEADER;
export const PAYMENT_ROLLOUT_VERCEL_PROJECT_HEADER =
  DEPLOYMENT_IDENTITY_VERCEL_PROJECT_HEADER;
export const PAYMENT_ROLLOUT_VERCEL_DEPLOYMENT_HEADER =
  DEPLOYMENT_IDENTITY_VERCEL_DEPLOYMENT_HEADER;
export const PAYMENT_ROLLOUT_VERCEL_URL_HEADER =
  DEPLOYMENT_IDENTITY_VERCEL_URL_HEADER;
export const PAYMENT_ROLLOUT_VERCEL_ENVIRONMENT_HEADER =
  DEPLOYMENT_IDENTITY_VERCEL_ENVIRONMENT_HEADER;

/**
 * Public, non-secret deployment identity used by the production migration
 * runner to bind every frozen paid route to the exact Supabase project and
 * application build it is about to change.
 *
 * Return both fields or neither. A partially configured deployment must never
 * look authoritative to the rollout runner.
 */
export function paymentRolloutIdentityHeaders(
  env: DeploymentIdentityEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
  },
): Readonly<Record<string, string>> {
  return deploymentIdentityHeaders(env);
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
