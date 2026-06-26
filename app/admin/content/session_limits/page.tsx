import Link from "next/link";
import { getSessionLimitsWithMeta } from "@/lib/config/getters";
import { MAX_PLAY_SECONDS } from "@/lib/config/domains/session";
import { MAX_SCORE_HARD } from "@/lib/score-limits";
import { SessionLimitsEditor } from "@/components/admin/content/SessionLimitsEditor";
import { PaperPanel } from "@/components/dossier";

export const dynamic = "force-dynamic";

export default async function SessionLimitsPage() {
  const { value, version, source, invalid } = await getSessionLimitsWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/content" className="whitespace-nowrap text-xs text-steel hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/session_limits" className="whitespace-nowrap text-xs text-steel hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 font-display text-2xl font-bold sm:text-3xl">세션 한도 (강제 종료)</h1>
        <p className="mt-1 text-sm text-steel">
          한 판이 이 시간/점수에 도달하면 자동으로 종료되고 결과 화면으로 넘어가요. 기본값은 사실상 무제한이라,
          낮춰야 강제 종료가 동작합니다. (게임 시작 시점 값으로 고정 — 진행 중 변경은 다음 판부터.)
        </p>
        <PaperPanel className="mt-4 overflow-x-auto">
          <SessionLimitsEditor
            initial={value}
            version={version ?? 0}
            source={source}
            invalid={!!invalid}
            maxPlaySeconds={MAX_PLAY_SECONDS}
            maxScoreHard={MAX_SCORE_HARD}
          />
        </PaperPanel>
      </div>
    </main>
  );
}
