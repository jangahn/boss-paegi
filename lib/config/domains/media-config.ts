import { z } from "zod";
import type { DomainEntry } from "../registry";

// 미디어 자산(기본 OG 이미지·서비스 로고) — **path 만 저장**(URL 금지). 소비 URL 은 lib/site-assets 에서 파생.
// path 형식: <slot>/YYYYMM/<uuid>.<ext>  (업로드 라우트가 생성·검증, 저장측에서 prefix 재검증)
// 슬롯별 prefix 분리 — og 슬롯엔 'og/' 만, logo 슬롯엔 'logo/' 만 허용.
const OG_PATH_RE = /^og\/\d{6}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
const LOGO_PATH_RE = /^logo\/\d{6}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

// 슬롯 비움 = null, 채움 = prefix 일치 path 만. http/object/render 등 URL 은 regex 불일치로 자동 거부
// (저장값은 절대 URL 이 아님). 빈문자/공백은 에디터가 null 로 보냄 → "" 는 검증 실패(폴백=default).
// transform 없이 Input=Output 유지(DomainEntry<T> = ZodType<T> 할당 안전).
const slotPath = (re: RegExp) => z.string().regex(re, "invalid_asset_path").nullable();

export const mediaConfigSchema = z.object({
  ogImagePath: slotPath(OG_PATH_RE),
  logoPath: slotPath(LOGO_PATH_RE),
});

export type MediaConfig = z.infer<typeof mediaConfigSchema>;

// 미설정/검증실패 폴백 — 둘 다 비움(소비처가 정적 default 로 폴백).
export const MEDIA_CONFIG_DEFAULT: MediaConfig = { ogImagePath: null, logoPath: null };

export const mediaConfigEntry: DomainEntry<MediaConfig> = {
  schema: mediaConfigSchema,
  codeDefault: MEDIA_CONFIG_DEFAULT,
};
