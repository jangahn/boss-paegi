/** 배열에서 i 번째 항목을 dir(-1 위 / +1 아래)로 인접 스왑한 **새 배열**. 범위 밖이면 원본 그대로. */
export function moveItem<T>(arr: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  const next = arr.slice();
  if (j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
