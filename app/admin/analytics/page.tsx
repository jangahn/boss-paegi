import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-server";
import {
  getWeaponBalance,
  getMapBalance,
  getFunnel,
  getMemberActivity,
  getWeaponConcentration,
  getWeaponThroughput,
  getMapStickiness,
  getDevicePerf,
  getPersonaDistribution,
} from "@/lib/admin-analytics";
import { parseStatWindow, statWindowLabel } from "@/lib/admin-period";
import { PeriodTabs } from "@/components/admin/PeriodTabs";
import {
  BalanceBars,
  PersonaBars,
  FunnelView,
  WeaponConcentrationCard,
  WeaponThroughputBars,
  MapStickinessCard,
} from "@/components/admin/analytics/AnalyticsViews";
import { DevicePerfPanel } from "@/components/admin/DevicePerfPanel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const window = parseStatWindow(sp.days);

  const [weapons, maps, funnel, member, weaponConc, throughput, mapStick, devicePerf, personas] =
    await Promise.all([
      getWeaponBalance(window),
      getMapBalance(window),
      getFunnel(window),
      getMemberActivity(window),
      getWeaponConcentration(window),
      getWeaponThroughput(window),
      getMapStickiness(window),
      getDevicePerf(window),
      getPersonaDistribution(window),
    ]);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h1 className="text-2xl font-bold">게임플레이 분석</h1>
          <PeriodTabs basePath="/admin/analytics" current={window} />
        </div>
        <p className="-mt-4 text-xs text-zinc-400">
          {statWindowLabel(window)}. 익명+회원 합산. 비-회원은 요약만 집계(타임라인 없음).
          <br />
          오늘은 실시간(raw), 어제까지는 일 단위 확정 집계예요. 점수/초·프레임타임 중앙값은 히스토그램
          근사예요.
          {window === "all" && (
            <>
              <br />
              &lsquo;전체&rsquo;의 세션단위 지표(편중·효율·맵고착·퍼포먼스)는 하이브리드 도입(2026-08-29)
              이전 과거가 잔존 세션(익명 30일 보존) 기준 근사예요.
            </>
          )}
        </p>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">
            렌더 퍼포먼스 <span className="font-normal text-zinc-400">(프레임타임·렉 — device_class별)</span>
          </h2>
          <DevicePerfPanel data={devicePerf} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">무기 편중·다양성</h2>
          <WeaponConcentrationCard data={weaponConc} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">무기 효율·파워 <span className="font-normal text-zinc-400">(메인무기 기준 점수/초 중앙값 — 근사)</span></h2>
          <WeaponThroughputBars data={throughput} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">맵 고착·전환</h2>
          <MapStickinessCard data={mapStick} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">무기 밸런스 <span className="font-normal text-zinc-400">(타격·점수 비중)</span></h2>
          <BalanceBars stats={weapons} kind="weapon" />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">맵 밸런스 <span className="font-normal text-zinc-400">(맵 점유)</span></h2>
          <BalanceBars stats={maps} kind="map" />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">패기 유형 분포 <span className="font-normal text-zinc-400">(제출 게임 단위 판정)</span></h2>
          <PersonaBars stats={personas} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">플레이내 펀널 · 이탈</h2>
          <FunnelView funnel={funnel} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">
            회원 활동 <span className="font-normal text-zinc-400">(코호트·재방문 — 익명은 ephemeral 이라 회원 한정)</span>
          </h2>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="회원 세션" value={member.sessions.toLocaleString()} />
            <Stat label="활동 회원" value={member.members.toLocaleString()} />
            <Stat label="재방문(2회+)" value={member.returning.toLocaleString()} />
          </div>
          <p className="mt-1 text-[10px] text-zinc-400">
            재방문은 기간을 하루 단위로 쪼갤 수 없어(요일 걸친 2회 방문) 잔존 회원 세션 raw 기준이에요.
          </p>
        </section>

        <Link href="/admin/analytics/sessions" className="text-sm text-sky-600 underline">
          최근 세션 인스펙터 →
        </Link>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-foreground/10 ui-surface p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums">{value}</p>
    </div>
  );
}
