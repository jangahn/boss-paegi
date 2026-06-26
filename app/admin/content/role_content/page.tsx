import Link from "next/link";
import { getRoleConfigWithMeta } from "@/lib/config/getters";
import { RoleContentEditor } from "@/components/admin/content/RoleContentEditor";

export const dynamic = "force-dynamic";

export default async function RoleContentPage() {
  const { value, version, source, invalid } = await getRoleConfigWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/role_content" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">롤 대사</h1>
        <p className="mt-1 text-sm text-zinc-500">
          롤별 시비 멘트·반응·공유 문구·인사기록. 점수 10단계(0~9,999 … 90,000+)는 고정이며 칸 안의 문구만 편집합니다.
          줄바꿈으로 여러 개를 입력하면 랜덤으로 노출돼요.
        </p>
        <RoleContentEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
        />
      </div>
    </main>
  );
}
