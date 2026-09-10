/**
 * 실루엣 피격 판정 — 순수 함수(PIXI·matter·DOM 무의존, 단위 테스트 대상).
 *
 * 투척물·비비탄은 물리 몸체(캐릭터 원 r=0.55·naturalSize)와 부딪히는 순간이 아니라, **캐릭터 그림(알파맵)에
 * 실제로 닿은 프레임**에 맞은 것으로 친다(v1.34). PlayScene 이 매 프레임 비행 중인 발사체마다
 *  ① 직전 위치→현재 위치 선분을 SEGMENT_SAMPLE_STEP 간격으로 나눠(고속 관통 방지)
 *  ② 각 중심점에 대해 이모지 중심부 원(반지름 PROJECTILE_CORE_RATIO × size, 중심 + 둘레 8점)을 만들고
 *  ③ 각 점을 캐릭터 bodyWrap 로컬로 옮겨 Doll.isInsideBody(알파 ≥ 48) 에 넣는다.
 * 처음 실루엣 안에 들어온 점이 타격점이다. 이모지 글리프는 정사각형을 다 채우지 않으므로 중심부 원이
 * 회전과 무관하게 실제 그림에 가깝다. 비비탄은 점이라 중심만 검사한다(size 0).
 */

export type Point = { x: number; y: number };
/** scene 좌표 → 캐릭터 bodyWrap 로컬 좌표(스쿼시·회전·위치 반영). */
export type ToLocalFn = (p: Point) => Point;
/** bodyWrap 로컬 좌표가 실루엣 안인지(Doll.isInsideBody). */
export type InsideFn = (lx: number, ly: number) => boolean;

/** 이모지 중심부 판정 원의 반지름 비율(× projectileSize). 사용자 확정 시작값 0.3. */
export const PROJECTILE_CORE_RATIO = 0.3;
/** 중심부 원 둘레 샘플 수(중심 1 + 둘레 8 = 9점). */
export const PROJECTILE_CORE_POINTS = 8;
/** 선분 샘플 간격(px) — 최고 속도 1600px/s(60fps 27px/프레임)·비비탄 2600px/s(43px) 모두 촘촘히 덮는다. */
export const SEGMENT_SAMPLE_STEP = 20;

/** 중심 (cx, cy) 의 이모지 중심부 판정점 — 중심 + 반지름 ratio×size 원 둘레 n 점. size 0 이면 중심만. */
export function projectileSamplePoints(
  cx: number,
  cy: number,
  size: number,
  ratio: number = PROJECTILE_CORE_RATIO,
  n: number = PROJECTILE_CORE_POINTS,
): Point[] {
  const out: Point[] = [{ x: cx, y: cy }];
  const r = size * ratio;
  if (r <= 0 || n <= 0) return out;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

/**
 * from→to 선분을 step 간격으로 나눈 중심점들(시간순, `to` 포함·`from` 제외 — from 은 직전 프레임에 이미 검사됨).
 * from 과 to 가 같거나 from 이 없으면 [to].
 */
export function segmentSamplePoints(
  from: Point | null,
  to: Point,
  step: number = SEGMENT_SAMPLE_STEP,
): Point[] {
  if (!from) return [to];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0) || !(step > 0)) return [to];
  const n = Math.max(1, Math.ceil(dist / step));
  const out: Point[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
  return out;
}

/** points 를 순서대로 로컬 변환해 실루엣 안인 첫 점(scene 좌표)을 돌려준다. 없으면 null. */
export function findSilhouetteHit(points: readonly Point[], toLocal: ToLocalFn, inside: InsideFn): Point | null {
  for (const p of points) {
    const l = toLocal(p);
    if (inside(l.x, l.y)) return p;
  }
  return null;
}

/**
 * 발사체 한 개의 이번 프레임 피격 판정 — 선분 샘플 × 중심부 원 샘플을 시간순으로 검사해
 * 처음 닿은 점을 돌려준다. size 0 = 점 발사체(비비탄).
 */
export function findProjectileHit(
  from: Point | null,
  to: Point,
  size: number,
  toLocal: ToLocalFn,
  inside: InsideFn,
  ratio: number = PROJECTILE_CORE_RATIO,
): Point | null {
  for (const c of segmentSamplePoints(from, to)) {
    const hit = findSilhouetteHit(projectileSamplePoints(c.x, c.y, size, ratio), toLocal, inside);
    if (hit) return hit;
  }
  return null;
}
