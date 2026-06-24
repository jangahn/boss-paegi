// 두 config 스냅샷(jsonb)의 바뀐 항목 요약. 중첩 객체는 재귀해 leaf 스칼라까지,
// 배열/객체 변경은 "변경됨"으로 요약(사용자 결정: 바뀐 항목 요약). 순수 모듈.

export type DiffEntry = { path: string; before?: string; after?: string; complex?: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const show = (v: unknown): string => {
  const s = v == null ? "—" : String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

export function diffConfig(oldV: unknown, newV: unknown, prefix = ""): DiffEntry[] {
  if (JSON.stringify(oldV) === JSON.stringify(newV)) return [];
  // 둘 다 평범한 객체면 키 합집합으로 재귀.
  if (isPlainObject(oldV) && isPlainObject(newV)) {
    const keys = [...new Set([...Object.keys(oldV), ...Object.keys(newV)])];
    return keys.flatMap((k) =>
      diffConfig(oldV[k], newV[k], prefix ? `${prefix}.${k}` : k)
    );
  }
  // 스칼라(문자/숫자/불리/없음) 변경 → 이전→새 표시.
  const scalar = (v: unknown) => v == null || typeof v !== "object";
  if (scalar(oldV) && scalar(newV)) {
    return [{ path: prefix || "(전체)", before: show(oldV), after: show(newV) }];
  }
  // 배열/객체(또는 타입 변경) → 요약.
  return [{ path: prefix || "(전체)", complex: true }];
}
