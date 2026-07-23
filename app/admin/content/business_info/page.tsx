import Link from "next/link";
import { getBusinessInfoWithMeta } from "@/lib/config/getters";
import { BusinessInfoEditor } from "@/components/admin/content/BusinessInfoEditor";

export const dynamic = "force-dynamic";

export default async function BusinessInfoPage() {
  const { value, version, source, invalid } = await getBusinessInfoWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/business_info" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">사업자 정보</h1>
        <p className="mt-1 text-sm text-zinc-500">
          전 페이지 푸터에 상시 노출되는 사업자정보(PG 심사 요건)의 단일 소스. 발행하면 즉시(다음 로드부터) 반영됩니다.
        </p>
        <BusinessInfoEditor initial={value} version={version ?? 0} source={source} invalid={!!invalid} />
      </div>
    </main>
  );
}
