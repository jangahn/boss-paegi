import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_ASSETS_BUCKET } from "@/lib/storage-path";
import { getMediaConfig } from "@/lib/config/getters";

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
