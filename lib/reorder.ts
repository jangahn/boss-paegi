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
