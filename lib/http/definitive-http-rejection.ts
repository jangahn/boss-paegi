/**
 * A fully received, non-transient 4xx response proves that the requested
 * operation was rejected. Request timeout/rate-limit/client-closed statuses
 * remain ambiguous because an intermediary or upstream may still have
 * committed.
 */
export function isDefinitiveHttpRejectionStatus(
  status: number,
): boolean {
  return (
    Number.isSafeInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429 &&
    // Common proxy/client-closed request statuses. The upstream may still
    // have committed even if these non-standard codes reach the browser.
    status !== 460 &&
    status !== 499
  );
}
