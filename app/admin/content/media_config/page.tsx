import Link from "next/link";
import { getMediaConfigWithMeta } from "@/lib/config/getters";
import { siteAssetUrl, OG_PREVIEW_TRANSFORM, LOGO_PREVIEW_TRANSFORM } from "@/lib/site-assets";
import { MediaConfigEditor } from "@/components/admin/content/MediaConfigEditor";

export const dynamic = "force-dynamic";

export default async function MediaConfigPage() {
  const { value, version, source, invalid } = await getMediaConfigWithMeta();
  // 저장된 path → 작은 미리보기 transform URL(서버 파생). raw object URL 미노출.
  const initialPreviews = {
    og: value.ogImagePath ? siteAssetUrl(value.ogImagePath, OG_PREVIEW_TRANSFORM) : null,
    logo: value.logoPath ? siteAssetUrl(value.logoPath, LOGO_PREVIEW_TRANSFORM) : null,
  };
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link
            href="/admin/content/history/media_config"
            className="text-xs text-zinc-500 hover:text-foreground"
          >
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">미디어 자산</h1>
        <p className="mt-1 text-sm text-zinc-500">
          기본 OG 공유 이미지·서비스 로고를 업로드해 관리합니다. 발행하면 다음 로드부터 반영됩니다. (파비콘은 정적
          관리 — 여기서 다루지 않습니다.)
        </p>
        <MediaConfigEditor
          initial={value}
          initialPreviews={initialPreviews}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
        />
      </div>
    </main>
  );
}
