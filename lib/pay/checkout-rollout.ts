import type { CreditProduct } from "@/lib/credit-products";

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
