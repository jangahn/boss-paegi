import Link from "next/link";
import { getMarketingCopyWithMeta } from "@/lib/config/getters";
import { MarketingCopyEditor } from "@/components/admin/content/MarketingCopyEditor";

export const dynamic = "force-dynamic";

export default async function MarketingCopyPage() {
  const { value, version, source, invalid } = await getMarketingCopyWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
          ← 콘텐츠
        </Link>
        <h1 className="mt-2 text-2xl font-bold">마케팅 카피</h1>
        <p className="mt-1 text-sm text-zinc-500">
          홈 화면·가입 배너 문구. 발행하면 즉시(다음 로드부터) 반영됩니다.
        </p>
        <MarketingCopyEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
        />
      </div>
    </main>
  );
}
