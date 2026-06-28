import type { ZodType } from "zod";
import type { DomainKey, PublicSurface } from "./keys";
import { marketingEntry } from "./domains/marketing";
import { rolesEntry } from "./domains/roles";
import { scoreEntry } from "./domains/score";
import { sessionEntry } from "./domains/session";
import { growthEntry } from "./domains/growth";
import { badgeEntry } from "./domains/badges";
import { siteContentEntry } from "./domains/site-content";
import { mediaConfigEntry } from "./domains/media-config";

/**
 * 도메인 설정 레지스트리 — 각 도메인 PR 에서 항목을 등록한다.
 * 한 항목 = 쓰기/읽기 검증 schema + 코드 기본값(폴백) + 공개 projection 규칙.
 * 핫패스/에디터는 이 레지스트리를 단일 진실로 사용(키별 schema·default·노출).
 */
export type DomainEntry<T> = {
  /** 쓰기 검증 + 읽기 파싱. 모든 도메인 불변식(tier 수·길이·floor 등)을 여기 인코딩. */
  schema: ZodType<T>;
  /** config 미설정/검증실패 시 폴백 = 현재 코드 기본값. */
  codeDefault: T;
  /** 공개 런타임 노출 surface(없으면 비공개=서버 전용). */
  publicSurfaces?: PublicSurface[];
  /** 공개 projection — 운영필드/비활성/숨김 제거한 최소 value. 미지정 시 value 그대로. */
  toPublic?: (value: T) => unknown;
};

// 도메인 항목은 각 PR 에서 등록(아래 주석 순서).
//   PR2: marketing_copy ✅ · PR3: role_content ✅ · PR4: score_config(등급) ✅
//   PR5: session_limits ✅ · PR6: growth_levers ✅ · PR7: badge_catalog ✅ · 후속: score step(play_sessions)
export const REGISTRY: Partial<Record<DomainKey, DomainEntry<unknown>>> = {
  marketing_copy: marketingEntry as DomainEntry<unknown>,
  role_content: rolesEntry as DomainEntry<unknown>,
  score_config: scoreEntry as DomainEntry<unknown>,
  session_limits: sessionEntry as DomainEntry<unknown>,
  growth_levers: growthEntry as DomainEntry<unknown>,
  badge_catalog: badgeEntry as DomainEntry<unknown>,
  site_content: siteContentEntry as DomainEntry<unknown>,
  media_config: mediaConfigEntry as DomainEntry<unknown>,
};

export function getEntry(key: DomainKey): DomainEntry<unknown> | undefined {
  return REGISTRY[key];
}
