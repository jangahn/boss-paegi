import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getShareStats, getAcquisitionStats } from "@/lib/admin-acquisition";
import { getScoreConfig } from "@/lib/config/getters";
import { parseStatWindow, statWindowLabel } from "@/lib/admin-period";
import { PeriodTabs } from "@/components/admin/PeriodTabs";
import { ShareAnalyticsCard } from "@/components/admin/ShareAnalyticsCard";
import { AcquisitionCard } from "@/components/admin/AcquisitionCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 공유·유입 분석 — 게임플레이 분석(/admin/analytics)과 성격이 달라 별도 탭으로 격리.
 * 하이브리드(v1.06): 오늘=analytics_events 라이브 집계, 어제까지=analytics_rollups(무식별 집계).
 * 공유 행동(누가·어디서·얼마나) + 유입 경로·전환·바이럴 루프.
 */
export default async function AcquisitionPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const window = parseStatWindow(sp.days);

  const [shareStats, acqStats, scoreConfig] = await Promise.all([
    getShareStats(window),
    getAcquisitionStats(window),
    getScoreConfig(),
  ]);
  const tierLabels = scoreConfig.grades.map((g) => g.label);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h1 className="text-2xl font-bold">공유·유입 분석</h1>
          <PeriodTabs basePath="/admin/acquisition" current={window} />
        </div>
        <p className="-mt-4 text-xs text-zinc-400">
          {statWindowLabel(window)}. <b>무식별·집계</b>(개인추적·PII 없음). 게임플레이 분석과 별개 도메인 —
          공유 행동·유입 경로 전용.
          <br />
          오늘은 실시간(raw), 어제까지는 일 단위 확정 집계예요. 방문은 첫 터치·스크롤 등 상호작용이 있었던 방문만 세요(봇 제외, 2026-08-29부터).
          {window !== 1 && (
            <>
              <br />
              수집 공백 2026-07-30~08-21(수집 게이트, 소급 불가)이 있어 그 구간 수치는 비어 있어요.
              전체 기간의 시작은 수집 개시(2026-07-01)예요.
            </>
          )}
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
