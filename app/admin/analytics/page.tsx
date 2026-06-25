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
} from "@/lib/admin-analytics";
import {
  BalanceBars,
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
  const days = sp.days === "30" ? 30 : 7;

  const [weapons, maps, funnel, member, weaponConc, throughput, mapStick, devicePerf] =
    await Promise.all([
      getWeaponBalance(days),
      getMapBalance(days),
      getFunnel(days),
      getMemberActivity(days),
      getWeaponConcentration(days),
      getWeaponThroughput(days),
      getMapStickiness(days),
      getDevicePerf(days),
    ]);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">게임플레이 분석</h1>
          <div className="flex gap-1 text-xs">
            {[7, 30].map((d) => (
              <Link
                key={d}
                href={`/admin/analytics?days=${d}`}
                className={`rounded-full px-3 py-1.5 font-medium transition ${
                  days === d ? "bg-foreground text-background" : "text-zinc-500 hover:bg-foreground/5"
                }`}
              >
                {d}일
              </Link>
            ))}
          </div>
        </div>
        <p className="-mt-4 text-xs text-zinc-400">
          최근 {days}일(KST 자정 기준). 익명+회원 합산. 비-회원은 요약만 집계(타임라인 없음).
          <br />
          무기·맵 밸런스와 퍼널은 일 1회 집계라 당일 수치가 최대 ~1일 지연될 수 있어요.
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
    <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums">{value}</p>
    </div>
  );
}
