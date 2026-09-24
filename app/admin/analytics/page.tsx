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
  getKeyboardUsage,
  getPersonaDistribution,
  getScoreBuckets,
} from "@/lib/admin-analytics";
import { bandScoreBuckets } from "@/lib/admin-analytics-math";
import { getScoreConfig } from "@/lib/config/getters";
import { scoreTier, tierBandLabel, TIER_COUNT } from "@/lib/score-tiers";
import { parseStatWindow, statWindowLabel } from "@/lib/admin-period";
import { PeriodTabs } from "@/components/admin/PeriodTabs";
import {
  BalanceBars,
  PersonaBars,
  ScoreBandBars,
  FunnelView,
  WeaponConcentrationCard,
  WeaponThroughputBars,
  MapStickinessCard,
} from "@/components/admin/analytics/AnalyticsViews";
import { DevicePerfPanel } from "@/components/admin/DevicePerfPanel";
import { KeyboardUsagePanel } from "@/components/admin/KeyboardUsagePanel";

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

  const [weapons, maps, funnel, member, weaponConc, throughput, mapStick, devicePerf, keyboardUsage, personas, scoreBuckets, scoreCfg] =
    await Promise.all([
      getWeaponBalance(window),
      getMapBalance(window),
      getFunnel(window),
      getMemberActivity(window),
      getWeaponConcentration(window),
      getWeaponThroughput(window),
      getMapStickiness(window),
      getDevicePerf(window),
      getKeyboardUsage(window),
      getPersonaDistribution(window),
      getScoreBuckets(window),
      getScoreConfig(),
    ]);
  // 점수 구간 분포 — 1,000점 버킷을 현재 경계(score_config.thresholds)로 접는다. 라벨 = 구간 + 등급 라벨.
  const scoreBands = bandScoreBuckets(scoreBuckets, (s) => scoreTier(s, scoreCfg.thresholds), TIER_COUNT);
  const bandLabels = scoreCfg.grades.map(
    (g, i) => `${tierBandLabel(i, scoreCfg.thresholds)} · ${g.label}`,
  );

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
          <h2 className="mb-2 text-sm font-bold text-zinc-500">
            키보드 사용 <span className="font-normal text-zinc-400">(PC 스페이스·방향키 조작 — device_class별)</span>
          </h2>
          <KeyboardUsagePanel data={keyboardUsage} />
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
          <h2 className="mb-2 text-sm font-bold text-zinc-500">점수 구간 분포 <span className="font-normal text-zinc-400">(제출 게임 단위 · 현재 경계 기준)</span></h2>
          <ScoreBandBars stats={scoreBands} labels={bandLabels} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">플레이내 퍼널 · 이탈</h2>
          <FunnelView funnel={funnel} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">
            회원 플레이 빈도 <span className="font-normal text-zinc-400">(회원만 · 세션 = 게임 한 판)</span>
          </h2>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="회원 세션" value={member.sessions.toLocaleString()} />
            <Stat label="플레이 회원" value={member.members.toLocaleString()} />
            <Stat label="2세션+ 회원" value={member.twoPlus.toLocaleString()} />
          </div>
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
