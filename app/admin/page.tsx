import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import Link from "next/link";
import {
  getAdminFunnel,
  getOrderSummary,
  getStalePending,
  getRefundWarnings,
} from "@/lib/admin-data";
import { StalePendingTable } from "@/components/admin/StalePendingTable";
import { DashboardWarnings } from "@/components/admin/DashboardWarnings";

// 관리자 대시보드는 매출/운영 실시간이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const won = (n: number) => `${(n ?? 0).toLocaleString()}원`;
const pct = (num: number, den: number) =>
  den > 0 ? `${Math.round((num / den) * 100)}%` : "—";

export default async function AdminPage() {
  // proxy 가 로그인은 보장 — 여기서 is_admin 최종 판정.
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const [funnel, summary, stale, refundWarnings] = await Promise.all([
    getAdminFunnel(),
    getOrderSummary(),
    getStalePending(),
    getRefundWarnings(),
  ]);

  const byStatus = summary?.by_status ?? {};

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <h1 className="text-2xl font-bold">운영 대시보드</h1>

        <DashboardWarnings
          commitFail={refundWarnings.commitFail}
          unreconciled={refundWarnings.unreconciled}
          stuckCount={refundWarnings.stuckCount}
        />

          {/* 매출·주문 (KST today / rolling 7d·30d) */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-zinc-500">
              매출 · 주문{" "}
              <span className="font-normal">(오늘=KST 자정 기준, 7d/30d=현재 기준)</span>
            </h2>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="오늘 매출" value={won(summary?.revenue_today ?? 0)} sub={`${summary?.orders_today ?? 0}건`} />
              <Stat label="7일 매출" value={won(summary?.revenue_7d ?? 0)} sub={`${summary?.orders_7d ?? 0}건`} />
              <Stat label="30일 매출" value={won(summary?.revenue_30d ?? 0)} sub={`${summary?.orders_30d ?? 0}건`} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {(["pending", "paid", "canceled", "failed"] as const).map((s) => (
                <span key={s} className="rounded-full border border-foreground/15 px-2.5 py-1">
                  {s} <b className="tabular-nums">{byStatus[s] ?? 0}</b>
                </span>
              ))}
            </div>
          </section>

          {/* 가입·구매 퍼널 */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-zinc-500">가입·구매 퍼널</h2>
            {funnel ? (
              <div className="grid grid-cols-5 gap-1 text-center">
                <FunnelStep label="방문(익명)" value={funnel.anon_users} />
                <FunnelStep label="플레이" value={funnel.players} rate={pct(funnel.players, funnel.anon_users)} />
                <FunnelStep label="가입" value={funnel.members} rate={pct(funnel.members, funnel.players)} />
                <FunnelStep label="첫 생성" value={funnel.first_gen} rate={pct(funnel.first_gen, funnel.members)} />
                <FunnelStep label="첫 구매" value={funnel.first_purchase} rate={pct(funnel.first_purchase, funnel.members)} />
              </div>
            ) : (
              <p className="text-sm text-zinc-400">퍼널 데이터를 불러오지 못했어요.</p>
            )}
          </section>

          {/* 오래된 결제요청 (확인 필요) + 운영 액션 */}
          <section>
            <h2 className="mb-1 text-sm font-bold text-amber-600">
              오래된 결제요청 — 확인 필요
            </h2>
            <p className="mb-2 text-xs leading-relaxed text-zinc-500">
              결제 시도(mul_no) 후 2시간+ pending. <b>결제완료 미지급으로 단정 금지</b> —
              페이앱 관리자에서 결제완료 여부를 확인한 뒤 처리하세요.
            </p>
            <StalePendingTable rows={stale} />
          </section>

        {/* CS 크레딧 조정은 회원 검색 → 유저 상세로 이전됨 */}
        <p className="text-xs text-zinc-500">
          CS 크레딧 조정·환불은{" "}
          <Link href="/admin/users" className="text-sky-600 underline">
            회원 관리
          </Link>
          에서 유저를 찾아 진행하세요.
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-foreground/10 bg-paper-2 p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-zinc-400">{sub}</p>}
    </div>
  );
}

function FunnelStep({ label, value, rate }: { label: string; value: number; rate?: string }) {
  return (
    <div className="rounded-lg border border-foreground/10 bg-paper-2 p-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="text-base font-bold tabular-nums">{value.toLocaleString()}</p>
      {rate && <p className="text-[10px] text-amber-600">{rate}</p>}
    </div>
  );
}
