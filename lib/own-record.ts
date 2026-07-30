/**
 * Runtime 문자열로 정적 레코드를 조회할 때 Object.prototype 상속값을 성공값으로
 * 오인하지 않도록 하는 공용 allowlist 조회.
 */
export function ownRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string | null | undefined,
): T | undefined {
  return typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}
