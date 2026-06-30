import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-server";
import { getShareStats, getAcquisitionStats } from "@/lib/admin-acquisition";
import { getScoreConfig } from "@/lib/config/getters";
import { ShareAnalyticsCard } from "@/components/admin/ShareAnalyticsCard";
import { AcquisitionCard } from "@/components/admin/AcquisitionCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 공유·유입 분석 — 게임플레이 분석(/admin/analytics)과 성격이 달라 별도 탭으로 격리.
 * analytics_rollups(무식별 집계) 기반. 공유 행동(누가·어디서·얼마나) + 유입 경로·전환·바이럴 루프.
 */
export default async function AcquisitionPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const days = sp.days === "30" ? 30 : 7;

  const [shareStats, acqStats, scoreConfig] = await Promise.all([
    getShareStats(days),
    getAcquisitionStats(days),
    getScoreConfig(),
  ]);
  const tierLabels = scoreConfig.grades.map((g) => g.label);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">공유·유입 분석</h1>
          <div className="flex gap-1 text-xs">
            {[7, 30].map((d) => (
              <Link
                key={d}
                href={`/admin/acquisition?days=${d}`}
                className={`rounded-full px-3 py-1.5 font-medium transition ${
                  days === d ? "bg-foreground text-paper-2" : "text-zinc-500 hover:bg-foreground/5"
                }`}
              >
                {d}일
              </Link>
            ))}
          </div>
        </div>
        <p className="-mt-4 text-xs text-zinc-400">
          최근 {days}일(KST 자정 기준). <b>무식별·집계</b>(개인추적·PII 없음). 게임플레이 분석과 별개 도메인 —
          공유 행동·유입 경로 전용.
          <br />
          일 1회 집계라 당일 수치가 최대 ~1일 지연될 수 있어요.
        </p>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">
            공유 분석 <span className="font-normal text-zinc-400">(누가·어디서·얼마나 — 공유 시도)</span>
          </h2>
          <ShareAnalyticsCard stats={shareStats} tierLabels={tierLabels} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">
            유입 분석 <span className="font-normal text-zinc-400">(경로·전환·바이럴 루프)</span>
          </h2>
          <AcquisitionCard stats={acqStats} />
        </section>
      </div>
    </main>
  );
}
