import "server-only";
import { getSetting, getSettingWithMeta } from "./get";
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

export function getBadgeCatalog(): Promise<BadgeCatalog> {
  return getSetting("badge_catalog", badgeCatalogSchema, BADGE_CATALOG_DEFAULT);
}
export function getBadgeCatalogWithMeta() {
  return getSettingWithMeta("badge_catalog", badgeCatalogSchema, BADGE_CATALOG_DEFAULT);
}
