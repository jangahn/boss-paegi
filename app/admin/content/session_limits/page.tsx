import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getSessionLimitsWithMeta } from "@/lib/config/getters";
import { MAX_ELAPSED_SECONDS } from "@/lib/config/domains/session";
import { MAX_SCORE_HARD } from "@/lib/score-limits";
import { SCORE_PER_SEC_MAX } from "@/lib/anti-abuse-rules";
import { TIME_CAP_GRACE_SECONDS } from "@/lib/time-limit";
import { SessionLimitsEditor } from "@/components/admin/content/SessionLimitsEditor";

export const dynamic = "force-dynamic";

export default async function SessionLimitsPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect(gate.error === "consent_required" ? "/consent?next=/admin" : "/");

  const { value, version, source, invalid } = await getSessionLimitsWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/session_limits" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">제한 시간</h1>
        <p className="mt-1 text-sm text-zinc-500">
          한 판의 시간 규칙이에요. 첫 타격부터 시간이 흐르고 궁극기를 쓰면 늘어나요. 발행하면 새로 시작하는 판부터 적용돼요.
        </p>
        <SessionLimitsEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
          maxElapsedSecondsHard={MAX_ELAPSED_SECONDS}
          maxScoreHard={MAX_SCORE_HARD}
          scorePerSecMax={SCORE_PER_SEC_MAX}
          timeCapGraceSeconds={TIME_CAP_GRACE_SECONDS}
        />
      </div>
    </main>
  );
}
