import { ownRecordValue } from "../own-record.ts";

type CopyVarValue = string | number;

/**
 * 카피 런타임 값은 호출자가 제공한 own property만 인정한다.
 * Object.create/Proxy 등에서 상속된 값을 템플릿에 노출하지 않는다.
 */
export function copyVarValue(
  vars: Readonly<Record<string, CopyVarValue | undefined>> | undefined,
  key: string,
): CopyVarValue | undefined {
  return vars ? ownRecordValue(vars, key) : undefined;
}
