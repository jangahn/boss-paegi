import "server-only";

/**
 * 인메모리 고정창(fixed-window) admission shaping.
 *
 * 서버리스(Vercel) isolate마다 카운터가 분리되므로 이것은 권위 있는 quota가
 * 아니다. 호출부는 반드시 DB unique/receipt/quota 같은 전역 방어를 별도로
 * 가져야 한다. 현재 report는 DB quota+receipt, checkout은 사용자별 미해결
 * intent unique index+frozen receipt가 최종 권위이며 이 limiter는 burst 비용만
 * 줄인다.
 */
type Bucket = { count: number; reset: number };
const store = new Map<string, Bucket>();

/** key 가 window 안에서 limit 미만이면 허용(카운트+1)하고 true, 초과면 false. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = store.get(key);
  if (!b || now > b.reset) {
    store.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count < limit) {
    b.count++;
    return true;
  }
  return false;
}
