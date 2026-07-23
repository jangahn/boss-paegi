// 마케터 설정 도메인 key — app_settings PK 및 RPC allowlist 와 일치(0025·0040·0045·0061).
export const DOMAIN_KEYS = [
  "marketing_copy",
  "role_content",
  "score_config",
  "badge_catalog",
  "session_limits",
  "growth_levers",
  "site_content",
  "media_config",
  "business_info",
] as const;

export type DomainKey = (typeof DOMAIN_KEYS)[number];

export function isDomainKey(k: string): k is DomainKey {
  return (DOMAIN_KEYS as readonly string[]).includes(k);
}

// 공개 런타임 projection surface (운영필드 제거한 최소 노출).
export type PublicSurface = "gameplay" | "marketing";
