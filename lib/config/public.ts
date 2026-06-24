import "server-only";
import { getSetting } from "./get";
import { REGISTRY } from "./registry";
import type { DomainKey, PublicSurface } from "./keys";

/**
 * 공개 런타임 config — surface(gameplay|marketing)별 **최소 projection**.
 * 운영필드(updated_by/version)·inactive 상품·hidden 뱃지 등은 각 도메인 entry.toPublic 이 제거.
 * 등록된(레지스트리) 도메인 중 해당 surface 노출 대상만 포함. (PR1 레지스트리 비어있음=빈 응답.)
 */
export async function buildPublicConfig(
  surface: PublicSurface
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (!entry || !entry.publicSurfaces?.includes(surface)) continue;
    const value = await getSetting(key as DomainKey, entry.schema, entry.codeDefault);
    out[key] = entry.toPublic ? entry.toPublic(value) : value;
  }
  return out;
}
