/** 배열에서 i 번째 항목을 dir(-1 위 / +1 아래)로 인접 스왑한 **새 배열**. 범위 밖이면 원본 그대로. */
export function moveItem<T>(arr: readonly T[], i: number, dir: -1 | 1): T[] {
  const next = arr.slice();
  if (
    !Number.isSafeInteger(i) ||
    i < 0 ||
    i >= next.length ||
    (dir !== -1 && dir !== 1)
  ) {
    return next;
  }
  const j = i + dir;
  if (j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** 배열의 i·j 두 항목 자리를 맞바꾼 **새 배열**. 둘 중 하나라도 범위 밖이거나 같으면 원본 그대로. */
export function swapItems<T>(arr: readonly T[], i: number, j: number): T[] {
  const next = arr.slice();
  if (
    !Number.isSafeInteger(i) ||
    !Number.isSafeInteger(j) ||
    i < 0 ||
    j < 0 ||
    i >= next.length ||
    j >= next.length ||
    i === j
  ) {
    return next;
  }
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * 필터로 본 부분 목록(원 배열 순서 보존) 안에서 gi 번째 항목을 dir(-1 위 / +1 아래)로 한 칸 옮긴 **새 배열** —
 * 전체 배열에서는 그 항목과 부분 목록상 이웃의 자리를 맞바꾼다(둘 사이에 다른 그룹 항목이 끼어 있어도 동작).
 * 범위 밖이면 원본 그대로. 표시 순서 = 배열 순서인 그룹 편집기(뱃지 카탈로그의 패밀리)가 쓴다.
 */
export function moveWithinGroup<T>(
  arr: readonly T[],
  inGroup: (item: T) => boolean,
  gi: number,
  dir: -1 | 1
): T[] {
  if (dir !== -1 && dir !== 1) return arr.slice();
  const idx: number[] = [];
  arr.forEach((item, i) => {
    if (inGroup(item)) idx.push(i);
  });
  const gj = gi + dir;
  if (!Number.isSafeInteger(gi) || gi < 0 || gi >= idx.length || gj < 0 || gj >= idx.length) return arr.slice();
  return swapItems(arr, idx[gi], idx[gj]);
}
