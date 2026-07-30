import "server-only";
import {
  getSetting,
  getSettingWithMeta,
  getSettingUncached,
  getSettingWithMetaUncached,
  getSettingStrictUncached,
  getSettingWithMetaStrictUncached,
} from "./get";
import {
  generationConfigSchema,
  GENERATION_CONFIG_DEFAULT,
  type GenerationConfig,
} from "./domains/generation";
import {
  marketingCopySchema,
  MARKETING_COPY_DEFAULT,
  type MarketingCopy,
} from "./domains/marketing";
import {
  roleConfigSchema,
  ROLE_CONFIG_DEFAULT,
  type RoleConfig,
} from "./domains/roles";
import {
  scoreConfigSchema,
  SCORE_CONFIG_DEFAULT,
  type ScoreConfig,
} from "./domains/score";
import {
  sessionLimitsSchema,
  SESSION_LIMITS_DEFAULT,
  type SessionLimits,
} from "./domains/session";
import {
  growthLeversSchema,
  GROWTH_LEVERS_DEFAULT,
  type GrowthLevers,
} from "./domains/growth";
import {
  badgeCatalogSchema,
  BADGE_CATALOG_DEFAULT,
  type BadgeCatalog,
} from "./domains/badges";
import {
  siteContentSchema,
  SITE_CONTENT_DEFAULT,
  type SiteContent,
} from "./domains/site-content";
import {
  mediaConfigSchema,
  MEDIA_CONFIG_DEFAULT,
  type MediaConfig,
} from "./domains/media-config";
import {
  businessInfoConfigSchema,
  BUSINESS_INFO_DEFAULT,
  type BusinessInfoConfig,
} from "./domains/business-info";

// 도메인별 타입드 서버 getter — 핫패스 value-only + 어드민 진단 WithMeta. (도메인 PR 마다 추가.)
export function getMarketingCopy(): Promise<MarketingCopy> {
  return getSetting("marketing_copy", marketingCopySchema, MARKETING_COPY_DEFAULT);
}
export function getMarketingCopyWithMeta() {
  return getSettingWithMeta("marketing_copy", marketingCopySchema, MARKETING_COPY_DEFAULT);
}

export function getRoleConfig(): Promise<RoleConfig> {
  return getSetting("role_content", roleConfigSchema, ROLE_CONFIG_DEFAULT);
}
export function getRoleConfigWithMeta() {
  return getSettingWithMeta("role_content", roleConfigSchema, ROLE_CONFIG_DEFAULT);
}

export function getScoreConfig(): Promise<ScoreConfig> {
  return getSetting("score_config", scoreConfigSchema, SCORE_CONFIG_DEFAULT);
}
export function getScoreConfigWithMeta() {
  return getSettingWithMeta("score_config", scoreConfigSchema, SCORE_CONFIG_DEFAULT);
}

export function getSessionLimits(): Promise<SessionLimits> {
  return getSetting("session_limits", sessionLimitsSchema, SESSION_LIMITS_DEFAULT);
}
export function getSessionLimitsWithMeta() {
  return getSettingWithMeta("session_limits", sessionLimitsSchema, SESSION_LIMITS_DEFAULT);
}

export function getGrowthLevers(): Promise<GrowthLevers> {
  return getSetting("growth_levers", growthLeversSchema, GROWTH_LEVERS_DEFAULT);
}
export function getGrowthLeversWithMeta() {
  return getSettingWithMeta("growth_levers", growthLeversSchema, GROWTH_LEVERS_DEFAULT);
}
export function getGrowthLeversStrict(): Promise<GrowthLevers> {
  return getSettingStrictUncached(
    "growth_levers",
    growthLeversSchema,
    GROWTH_LEVERS_DEFAULT,
  );
}

export function getBadgeCatalog(): Promise<BadgeCatalog> {
  return getSetting("badge_catalog", badgeCatalogSchema, BADGE_CATALOG_DEFAULT);
}
/** Score report grants are immutable, so read/validation errors must retry. */
export function getBadgeCatalogStrictUncached(): Promise<BadgeCatalog> {
  return getSettingStrictUncached(
    "badge_catalog",
    badgeCatalogSchema,
    BADGE_CATALOG_DEFAULT,
  );
}
export function getBadgeCatalogWithMeta() {
  return getSettingWithMeta("badge_catalog", badgeCatalogSchema, BADGE_CATALOG_DEFAULT);
}

export function getSiteContent(): Promise<SiteContent> {
  return getSetting("site_content", siteContentSchema, SITE_CONTENT_DEFAULT);
}
export function getSiteContentWithMeta() {
  return getSettingWithMeta("site_content", siteContentSchema, SITE_CONTENT_DEFAULT);
}

export function getMediaConfig(): Promise<MediaConfig> {
  return getSetting("media_config", mediaConfigSchema, MEDIA_CONFIG_DEFAULT);
}
export function getMediaConfigWithMeta() {
  return getSettingWithMeta("media_config", mediaConfigSchema, MEDIA_CONFIG_DEFAULT);
}

export function getBusinessInfo(): Promise<BusinessInfoConfig> {
  return getSetting("business_info", businessInfoConfigSchema, BUSINESS_INFO_DEFAULT);
}
export function getBusinessInfoWithMeta() {
  return getSettingWithMeta("business_info", businessInfoConfigSchema, BUSINESS_INFO_DEFAULT);
}

// generation_config 는 **uncached 강한읽기** — 발행 직후 첫 생성이 새 값을 써야 하므로 SWR 우회.
// 소비는 생성 제출 시 1회(비핫패스)라 캐시 이득 없음.
export function getGenerationConfig(): Promise<GenerationConfig> {
  return getSettingUncached("generation_config", generationConfigSchema, GENERATION_CONFIG_DEFAULT);
}
export function getGenerationConfigWithMeta() {
  return getSettingWithMetaUncached(
    "generation_config",
    generationConfigSchema,
    GENERATION_CONFIG_DEFAULT
  );
}
export function getGenerationConfigWithMetaStrict() {
  return getSettingWithMetaStrictUncached(
    "generation_config",
    generationConfigSchema,
    GENERATION_CONFIG_DEFAULT,
  );
}
