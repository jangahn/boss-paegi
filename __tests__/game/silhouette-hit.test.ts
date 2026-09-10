// silhouette-hit.test.ts — 투척물·비비탄 실루엣 피격 판정(v1.34) 순수 함수 회귀 가드.
//   실행: node --test __tests__/game/silhouette-hit.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  PROJECTILE_CORE_POINTS,
  PROJECTILE_CORE_RATIO,
  SEGMENT_SAMPLE_STEP,
  findProjectileHit,
  findSilhouetteHit,
  projectileSamplePoints,
  segmentSamplePoints,
} = await import("../../game/physics/silhouette-hit.ts");

type Pt = { x: number; y: number };
const identity = (p: Pt) => p;
/** 합성 실루엣 — 캐릭터 중심 (0,0), 머리 원 r=60 + 몸통 사각 |x|≤40, 40≤y≤140 (Doll 의 placeholder 근사와 같은 꼴) */
const inside = (x: number, y: number) => x * x + y * y <= 60 * 60 || (Math.abs(x) <= 40 && y >= 40 && y <= 140);

test("중심부 원 샘플: 중심 + 둘레 8점, 반지름 = 0.3 × size, size 0 이면 중심만", () => {
  assert.equal(PROJECTILE_CORE_RATIO, 0.3);
  assert.equal(PROJECTILE_CORE_POINTS, 8);
  const pts = projectileSamplePoints(100, 50, 52);
  assert.equal(pts.length, 9);
  assert.deepEqual(pts[0], { x: 100, y: 50 });
  for (const p of pts.slice(1)) {
    assert.ok(Math.abs(Math.hypot(p.x - 100, p.y - 50) - 52 * 0.3) < 1e-9);
  }
  assert.deepEqual(projectileSamplePoints(3, 4, 0), [{ x: 3, y: 4 }]);
});

test("선분 샘플: step 간격 이하로 나누고 to 포함·from 제외, 정지·from 없음은 to 하나", () => {
  assert.equal(SEGMENT_SAMPLE_STEP, 20);
  const pts = segmentSamplePoints({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 0 });
  assert.ok(pts.every((p, i) => Math.abs(p.x - (i + 1) * 20) < 1e-9));
  assert.deepEqual(segmentSamplePoints(null, { x: 7, y: 8 }), [{ x: 7, y: 8 }]);
  assert.deepEqual(segmentSamplePoints({ x: 7, y: 8 }, { x: 7, y: 8 }), [{ x: 7, y: 8 }]);
  // 비비탄 43px/프레임 → 3분할(≤20px)
  assert.equal(segmentSamplePoints({ x: 0, y: 0 }, { x: 0, y: 43 }).length, 3);
});

test("findSilhouetteHit: 순서대로 검사해 처음 실루엣 안인 점을 돌려준다", () => {
  const pts = [
    { x: 300, y: 300 },
    { x: 200, y: 0 },
    { x: 50, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.deepEqual(findSilhouetteHit(pts, identity, inside), { x: 50, y: 0 });
  assert.equal(findSilhouetteHit([{ x: 300, y: 300 }], identity, inside), null);
});

test("물리 원 안이지만 그림 밖(허공)이면 빗나감, 중심부 원이 실루엣에 닿으면 명중", () => {
  // 종전 물리 원 반지름 110: 캐릭터 중심에서 100px 옆은 원 안이지만 실루엣(머리 r=60) 밖
  const size = 52;
  const inAir = findProjectileHit({ x: 100, y: 0 }, { x: 100, y: 0 }, size, identity, inside);
  assert.equal(inAir, null);
  // 중심 75px: 중심부 원(r=15.6)의 왼쪽 끝 59.4 < 60 → 실루엣 접촉
  const touching = findProjectileHit({ x: 75, y: 0 }, { x: 75, y: 0 }, size, identity, inside);
  assert.ok(touching);
  assert.ok(inside(touching!.x, touching!.y));
  // 이모지 정사각형 모서리(26px)만 겹치는 76.5px 는 중심부 원 기준으로는 빗나감
  assert.equal(findProjectileHit({ x: 76.5, y: 0 }, { x: 76.5, y: 0 }, size, identity, inside), null);
});

test("고속 통과: 한 프레임에 실루엣을 가로질러도 선분 샘플이 잡고, 타격점은 진입 쪽", () => {
  // 위→아래 200px 이동, 머리 원(r=60)을 관통
  const hit = findProjectileHit({ x: 0, y: -120 }, { x: 0, y: 80 }, 0, identity, inside);
  assert.ok(hit);
  assert.ok(hit!.y <= -40, `진입 쪽 타격점이어야 함: ${hit!.y}`);
  // 실루엣을 비켜 지나가는 선분은 빗나감
  assert.equal(findProjectileHit({ x: 100, y: -200 }, { x: 100, y: 200 }, 0, identity, inside), null);
});

test("toLocal 변환을 거친다 — 캐릭터가 이동·회전·스쿼시된 좌표계에서 판정", () => {
  // 캐릭터가 (500, 400) 에 있고 2배로 늘어난 상태: scene 점 (600, 400) 은 로컬 (50, 0) → 머리 원(r=60) 안
  const toLocal = (p: Pt) => ({ x: (p.x - 500) / 2, y: (p.y - 400) / 2 });
  const hit = findProjectileHit({ x: 600, y: 400 }, { x: 600, y: 400 }, 0, toLocal, inside);
  assert.deepEqual(hit, { x: 600, y: 400 });
  // 스쿼시 없이 같은 점이면 로컬 (100, 0) → 밖
  const toLocalPlain = (p: Pt) => ({ x: p.x - 500, y: p.y - 400 });
  assert.equal(findProjectileHit({ x: 600, y: 400 }, { x: 600, y: 400 }, 0, toLocalPlain, inside), null);
});
