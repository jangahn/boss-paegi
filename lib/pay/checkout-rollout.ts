/**
 * Checkout is fail-closed across DB-first payment migrations. A deployment
 * must opt in explicitly only after the rollout and smoke gates pass.
 */
export function paymentCheckoutEnabled(
  value: unknown = process.env.PAYMENT_CHECKOUT_ENABLED,
): boolean {
  return value === "1";
}
