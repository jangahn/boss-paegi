/**
 * 게임플레이 분석 순수 수학(서버/런타임 의존 0 — 단위 테스트 대상).
 * 히스토그램 중앙값 복원: 일별 롤업 히스토그램(0110 sess_sps_·sess_perf_ dim)을 윈도우 합산한 뒤
 * 버킷 내 균등분포 가정으로 보간한 근사 중앙값. 버킷 스펙(폭·cap)은 0110 마이그레이션의 불변 상수와 일치.
 */

export type HistBucket = { bucket: number; count: number };

/** 'fist|12' · 'mobile-touch|33' → 그룹/버킷 분해(마지막 '|' 기준). 형식 불량은 null. */
export function parseBucketKey(dimKey: string): { group: string; bucket: number } | null {
  const at = dimKey.lastIndexOf("|");
  if (at <= 0 || at === dimKey.length - 1) return null;
  const bucket = Number(dimKey.slice(at + 1));
  if (!Number.isSafeInteger(bucket) || bucket < 0) return null;
  return { group: dimKey.slice(0, at), bucket };
}

/**
 * 히스토그램 근사 중앙값 — 0-based rank r 의 값을 버킷 내 균등분포로 보간:
 * est(r) = bucket*width + width*((r - cumBefore + 0.5) / count). 짝수 표본은 중앙 2위치 평균.
 * cap 버킷([cap*width, ∞) overflow)도 같은 식으로 하한 근사한다. 표본 0 이면 null.
 */
export function histogramMedian(buckets: readonly HistBucket[], width: number): number | null {
  const sorted = buckets
    .filter((b) => b.count > 0 && Number.isFinite(b.bucket) && b.bucket >= 0)
    .slice()
    .sort((a, b) => a.bucket - b.bucket);
  const n = sorted.reduce((s, b) => s + b.count, 0);
  if (n <= 0) return null;
  const est = (rank: number): number => {
    let cumBefore = 0;
    for (const b of sorted) {
      if (rank < cumBefore + b.count) {
        return b.bucket * width + width * ((rank - cumBefore + 0.5) / b.count);
      }
      cumBefore += b.count;
    }
    const last = sorted[sorted.length - 1];
    return last.bucket * width + width;
  };
  if (n % 2 === 1) return est((n - 1) / 2);
  return (est(n / 2 - 1) + est(n / 2)) / 2;
}

/** 히스토그램 총 표본수. */
export function histogramCount(buckets: readonly HistBucket[]): number {
  return buckets.reduce((s, b) => s + (b.count > 0 ? b.count : 0), 0);
}

/** 단일 hit 분포의 Herfindahl(Σshare²). 빈 분포는 null. (기존 lib/admin-analytics 이관) */
export function herfindahlOf(hits: Record<string, number>): number | null {
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let h = 0;
  for (const v of Object.values(hits)) {
    const sh = v / total;
    h += sh * sh;
  }
  return h;
}
