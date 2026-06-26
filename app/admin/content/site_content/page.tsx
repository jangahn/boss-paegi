import Link from "next/link";
import { getSiteContentWithMeta } from "@/lib/config/getters";
import { SiteContentEditor } from "@/components/admin/content/SiteContentEditor";

export const dynamic = "force-dynamic";

export default async function SiteContentPage() {
  const { value, version, source, invalid } = await getSiteContentWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/site_content" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">소개·FAQ (SEO)</h1>
        <p className="mt-1 text-sm text-zinc-500">
          홈 소개 섹션·/faq·검색 메타·구조화 데이터의 단일 소스. 발행하면 즉시(다음 로드부터) 반영됩니다.
        </p>
        <SiteContentEditor initial={value} version={version ?? 0} source={source} invalid={!!invalid} />
      </div>
    </main>
  );
}
