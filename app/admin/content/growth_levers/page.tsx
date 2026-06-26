import Link from "next/link";
import { getGrowthLeversWithMeta } from "@/lib/config/getters";
import { GrowthLeversEditor } from "@/components/admin/content/GrowthLeversEditor";

export const dynamic = "force-dynamic";

export default async function GrowthLeversPage() {
  const { value, version, source, invalid } = await getGrowthLeversWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/growth_levers" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 font-bold text-2xl sm:text-3xl">성장 레버 (가입 생성권·가격)</h1>
        <p className="mt-1 text-sm text-zinc-500">
          가입 기념 생성권 개수와 충전 상품(개수·가격)을 설정해요. <b>가격은 실결제에 즉시 반영</b>되니 신중히.
          최소 1,000원(페이앱 제한). 상품 비활성화 시 판매에서 숨겨지고 과거 주문은 그대로 보존됩니다.
        </p>
        <GrowthLeversEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
        />
      </div>
    </main>
  );
}
