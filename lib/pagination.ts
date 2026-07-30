export const MAX_PAGE_PARAM = 100_000;

/**
 * URL page parameters are untrusted strings. Accept only their canonical
 * positive-decimal form and keep the resulting database offset bounded.
 * Malformed, fractional, exponential, non-finite, duplicated-first invalid,
 * and oversized values all converge to page 1.
 */
export function parsePageParam(
  value: string | string[] | undefined,
  maxPage = MAX_PAGE_PARAM,
): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (
    typeof raw !== "string" ||
    !/^[1-9]\d*$/.test(raw) ||
    !Number.isSafeInteger(maxPage) ||
    maxPage < 1
  ) {
    return 1;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maxPage ? parsed : 1;
}
