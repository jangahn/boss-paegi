/**
 * score_flags.signals 의 세대별 형식 차이를 어드민 읽기 계약 앞에서 흡수한다.
 * 2026-07 anti-abuse v1(어드민 확정 CONFIRMED_AUTOCLICKER: {id, source})·v2({id, value, source})는
 * value/threshold 키가 없어 strict 검증(nullableNumeric)이 예외를 내며 무결성 상세 페이지가
 * 500 이었다(2026-09-03 실관측 3건). 누락 키만 null 로 채우고 나머지는 그대로 검증에 넘긴다.
 */
export function normalizeFlagSignalShape(signals: unknown): unknown {
  if (!Array.isArray(signals)) return signals;
  return signals.map((signal) => {
    if (signal === null || typeof signal !== "object" || Array.isArray(signal)) {
      return signal;
    }
    const record = signal as Record<string, unknown>;
    return {
      ...record,
      value: record.value === undefined ? null : record.value,
      threshold: record.threshold === undefined ? null : record.threshold,
    };
  });
}
