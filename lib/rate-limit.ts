import "server-only";

/**
 * 인메모리 고정창(fixed-window) rate-limit — 공개 엔드포인트(신고 등) 스팸 완화용 MVP.
 *
 * ⚠️ 서버리스(Vercel) per-instance 한계: 인스턴스마다 별도 카운터라 전역 보장 아님.
 *    스케일/엄격성 필요 시 Upstash 등 외부 스토어로 교체(README 운영 메모).
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
