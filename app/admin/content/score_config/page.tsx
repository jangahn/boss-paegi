import Link from "next/link";
import { getScoreConfigWithMeta } from "@/lib/config/getters";
import { ScoreConfigEditor } from "@/components/admin/content/ScoreConfigEditor";

export const dynamic = "force-dynamic";

export default async function ScoreConfigPage() {
  const { value, version, source, invalid } = await getScoreConfigWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
          ← 콘텐츠
        </Link>
        <h1 className="mt-2 text-2xl font-bold">점수 설정</h1>
        <p className="mt-1 text-sm text-zinc-500">
          점수 10단계의 등급 라벨·한 줄 평(=&apos;패기 유형&apos;). 점수 구간(0~9,999 … 90,000+)은 고정,
          칸 안 문구만 편집합니다. (구간 간격 조절은 추후.)
        </p>
        <ScoreConfigEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
        />
      </div>
    </main>
  );
}
