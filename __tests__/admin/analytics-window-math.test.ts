import assert from "node:assert/strict";
import test from "node:test";
import {
  herfindahlOf,
  histogramCount,
  histogramMedian,
  parseBucketKey,
} from "../../lib/admin-analytics-math.ts";

// 하이브리드(0110) 히스토그램 중앙값 복원 — 버킷 내 균등분포 보간의 정확 산식 회귀.
// est(r) = bucket*width + width*((r - cumBefore + 0.5)/count), 짝수 표본은 중앙 2위치 평균.

test("histogram median interpolates within buckets", () => {
  assert.equal(histogramMedian([], 1), null);
  assert.equal(histogramMedian([{ bucket: 16, count: 0 }], 1), null);
  // 단일 표본: [16,17) 균등 → 16.5
  assert.equal(histogramMedian([{ bucket: 16, count: 1 }], 1), 16.5);
  // 홀수 표본 한 버킷: rank1/3 → 5 + (1.5/3) = 5.5
  assert.equal(histogramMedian([{ bucket: 5, count: 3 }], 1), 5.5);
  // 짝수 표본 두 버킷(정렬 무관): est(0)=0.5, est(1)=10.5 → 5.5
  assert.equal(
    histogramMedian(
      [
        { bucket: 10, count: 1 },
        { bucket: 0, count: 1 },
      ],
      1,
    ),
    5.5,
  );
  // 버킷 폭 반영: bucket2 × width10 → [20,30) 단일 표본 = 25
  assert.equal(histogramMedian([{ bucket: 2, count: 1 }], 10), 25);
  // 누적 경계: {0:2, 1:2} → est(1)=0+ (1-0+0.5)/2 = 0.75, est(2)=1+(0.5/2)=1.25 → 1.0
  assert.equal(
    histogramMedian(
      [
        { bucket: 0, count: 2 },
        { bucket: 1, count: 2 },
      ],
      1,
    ),
    1,
  );
});

test("histogram count sums positive buckets only", () => {
  assert.equal(histogramCount([]), 0);
  assert.equal(
    histogramCount([
      { bucket: 0, count: 2 },
      { bucket: 3, count: 5 },
      { bucket: 9, count: 0 },
    ]),
    7,
  );
});

test("bucket keys split on the last separator and reject malformed forms", () => {
  assert.deepEqual(parseBucketKey("fist|12"), { group: "fist", bucket: 12 });
  assert.deepEqual(parseBucketKey("mobile-touch|33"), { group: "mobile-touch", bucket: 33 });
  // 그룹에 '|' 가 있어도 마지막 구분자 기준(방어적 허용)
  assert.deepEqual(parseBucketKey("a|b|3"), { group: "a|b", bucket: 3 });
  for (const bad of ["bad", "|3", "x|", "x|-1", "x|1.5", "x|nan", ""]) {
    assert.equal(parseBucketKey(bad), null, bad);
  }
});

test("herfindahl matches the legacy in-session definition", () => {
  assert.equal(herfindahlOf({}), null);
  assert.equal(herfindahlOf({ a: 0 }), null);
  assert.equal(herfindahlOf({ a: 7 }), 1);
  assert.equal(herfindahlOf({ a: 1, b: 1 }), 0.5);
  const skewed = herfindahlOf({ a: 9, b: 1 });
  assert.ok(skewed !== null && Math.abs(skewed - 0.82) < 1e-9);
});
