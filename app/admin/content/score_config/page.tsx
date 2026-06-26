import Link from "next/link";
import { getScoreConfigWithMeta } from "@/lib/config/getters";
import { ScoreConfigEditor } from "@/components/admin/content/ScoreConfigEditor";
import { PaperPanel, DashedDivider } from "@/components/dossier";

export const dynamic = "force-dynamic";

export default async function ScoreConfigPage() {
  const { value, version, source, invalid } = await getScoreConfigWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/score_config" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 font-display text-2xl font-bold sm:text-3xl">점수 설정</h1>
        <PaperPanel className="mt-3 p-4 sm:p-5">
          <p className="text-sm text-zinc-500">
            점수 10단계의 등급 라벨·한 줄 평(=&apos;패기 유형&apos;). 점수 구간(0~9,999 … 90,000+)은 고정,
            칸 안 문구만 편집합니다. (구간 간격 조절은 추후.)
          </p>
          <DashedDivider className="my-4" />
          <ScoreConfigEditor
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
