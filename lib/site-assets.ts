import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_ASSETS_BUCKET } from "@/lib/storage-path";
import { getMediaConfig } from "@/lib/config/getters";
import { SITE_URL } from "@/lib/site";

// 미디어 자산 변환 사양 — **항상 width+height+resize**(width-only 는 height 안 줄어듦/Supabase gotcha).
// 고용량 원본을 버킷에 넣어도 소비·미리보기는 늘 리사이즈된 render URL 만 로드.
//   OG: 1200×630 cover(1.91:1) · 로고: 640²  contain(종횡비·투명 보존)
export const OG_TRANSFORM = { width: 1200, height: 630, resize: "cover" } as const;
export const LOGO_TRANSFORM = { width: 640, height: 640, resize: "contain" } as const;
// 어드민 미리보기(더 작게).
export const OG_PREVIEW_TRANSFORM = { width: 400, height: 210, resize: "cover" } as const;
export const LOGO_PREVIEW_TRANSFORM = { width: 160, height: 160, resize: "contain" } as const;

type Transform = { width: number; height: number; resize: "cover" | "contain" };

/**
 * site-assets(public) path → 변환(render) public URL.
 * raw object URL 은 소비처에 노출하지 않는다(항상 transform 경유) — lib/events coverUrl 패턴.
 */
export function siteAssetUrl(path: string, transform: Transform): string {
  const admin = createAdminClient();
  return admin.storage.from(SITE_ASSETS_BUCKET).getPublicUrl(path, { transform }).data.publicUrl;
}

export type MediaAssetUrls = { ogImageUrl: string | null; logoUrl: string | null };

/**
 * media_config(path-only) → 소비용 transform URL. path 없으면 null(소비처가 정적 default 로 폴백).
 * 서버 전용(layout/metadata·provider 주입에서 호출).
 */
export async function getMediaAssetUrls(): Promise<MediaAssetUrls> {
  const cfg = await getMediaConfig();
  return {
    ogImageUrl: cfg.ogImagePath ? siteAssetUrl(cfg.ogImagePath, OG_TRANSFORM) : null,
    logoUrl: cfg.logoPath ? siteAssetUrl(cfg.logoPath, LOGO_TRANSFORM) : null,
  };
}

// 파일-기반 컨벤션(app/opengraph-image) 대신 metadata 에 **명시**하는 정적 기본 OG(public/og-default.png).
export const OG_DEFAULT_URL = `${SITE_URL}/og-default.png`;
export const OG_ALT = "부장님 패기 — 내 사진으로 만든 캐릭터로 직장 스트레스 해소";

export type OgImage = { url: string; width: number; height: number; alt: string };

/**
 * OG/twitter 이미지 단일 해석 — 우선순위: (인자)이벤트 cover > media_config 기본 OG > 정적 default.
 * Next metadata 는 openGraph 를 deep-merge 하지 않으므로(child 가 교체) openGraph 를 세팅하는
 * 모든 라우트(layout·news 등)가 이 함수로 images 를 **항상 명시**해 우선순위를 보장한다.
 */
export async function resolveOgImages(coverOgUrl?: string | null): Promise<OgImage[]> {
  const media = await getMediaAssetUrls();
  return [{ url: coverOgUrl ?? media.ogImageUrl ?? OG_DEFAULT_URL, width: 1200, height: 630, alt: OG_ALT }];
}
