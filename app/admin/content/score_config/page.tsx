import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getScoreConfigWithMeta } from "@/lib/config/getters";
import { ScoreConfigEditor } from "@/components/admin/content/ScoreConfigEditor";
import { TIER_COUNT } from "@/lib/score-tiers";

export const dynamic = "force-dynamic";

export default async function ScoreConfigPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect(gate.error === "consent_required" ? "/consent?next=/admin" : "/");

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
        <h1 className="mt-2 text-2xl font-bold">점수 설정</h1>
        <p className="mt-1 text-sm text-zinc-500">
          점수 {TIER_COUNT}단계의 구간 경계와 등급 라벨·한 줄 평(=&apos;패기 유형&apos;). 단계 개수는 고정이고, 경계와 문구를 편집합니다.
          같은 단계를 롤 대사(피격 반응·시비 멘트)와 게임 분석의 점수 구간 분포가 공유해요.
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
