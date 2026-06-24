import "server-only";
import { getSetting, getSettingWithMeta } from "./get";
import {
  marketingCopySchema,
  MARKETING_COPY_DEFAULT,
  type MarketingCopy,
} from "./domains/marketing";

// 도메인별 타입드 서버 getter — 핫패스 value-only + 어드민 진단 WithMeta. (도메인 PR 마다 추가.)
export function getMarketingCopy(): Promise<MarketingCopy> {
  return getSetting("marketing_copy", marketingCopySchema, MARKETING_COPY_DEFAULT);
}
export function getMarketingCopyWithMeta() {
  return getSettingWithMeta("marketing_copy", marketingCopySchema, MARKETING_COPY_DEFAULT);
}
