import Link from "next/link";
import { getRoleConfigWithMeta } from "@/lib/config/getters";
import { RoleContentEditor } from "@/components/admin/content/RoleContentEditor";
import { PaperPanel } from "@/components/dossier";

export const dynamic = "force-dynamic";

export default async function RoleContentPage() {
  const { value, version, source, invalid } = await getRoleConfigWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/content" className="whitespace-nowrap text-xs text-steel hover:text-ink">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/role_content" className="whitespace-nowrap text-xs text-steel hover:text-ink">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 font-bold text-2xl sm:text-3xl">롤 대사</h1>
        <p className="mt-1 text-sm text-steel">
          롤별 시비 멘트·반응·공유 문구·인사기록. 점수 10단계(0~9,999 … 90,000+)는 고정이며 칸 안의 문구만 편집합니다.
          줄바꿈으로 여러 개를 입력하면 랜덤으로 노출돼요.
        </p>
        <PaperPanel className="mt-4 overflow-x-auto p-4">
          <RoleContentEditor
            initial={value}
            version={version ?? 0}
            source={source}
            invalid={!!invalid}
          />
        </PaperPanel>
      </div>
    </main>
  );
}
