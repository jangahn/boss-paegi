import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import Link from "next/link";
import {
  getAdminFunnelWindow,
  getOrderSummaryWindow,
  getStalePending,
  getRefundWarnings,
} from "@/lib/admin-data";
import { parseStatWindow, statWindowLabel } from "@/lib/admin-period";
import { PeriodTabs } from "@/components/admin/PeriodTabs";
import { StalePendingTable } from "@/components/admin/StalePendingTable";
import { DashboardWarnings } from "@/components/admin/DashboardWarnings";

// 관리자 대시보드는 매출/운영 실시간이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const won = (n: number) => `${(n ?? 0).toLocaleString()}원`;
const pct = (num: number, den: number) =>
  den > 0 ? `${Math.round((num / den) * 100)}%` : "—";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  // proxy 가 로그인은 보장 — 여기서 is_admin 최종 판정.
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const window = parseStatWindow(sp.days);

  const [funnel, summary, stale, refundWarnings] = await Promise.all([
    getAdminFunnelWindow(window),
    getOrderSummaryWindow(window),
    getStalePending(),
    getRefundWarnings(),
  ]);

  const byStatus = summary.by_status;

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">운영 대시보드</h1>
          <PeriodTabs basePath="/admin" current={window} />
        </div>
        <p className="-mt-4 text-xs text-zinc-400">
          {statWindowLabel(window)} · KST 달력일 기준. 오늘은 실시간, 어제까지의 퍼널은 일 단위 확정
          집계예요.
        </p>

        <DashboardWarnings
          attentionAttempts={refundWarnings.attentionAttempts}
          blockedRequests={refundWarnings.blockedRequests}
          openIssues={refundWarnings.openIssues}
          unreconciled={refundWarnings.unreconciled}
        />

          {/* 매출·주문 — 직조회(환불·대사 소급 교정 즉시 반영) */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-zinc-500">
              매출 · 주문{" "}
              <span className="font-normal">(매출=결제완료 기준, 건수·상태=주문 생성 기준)</span>
            </h2>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="매출" value={won(summary.revenue)} />
              <Stat label="주문" value={`${summary.orders.toLocaleString()}건`} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {(["pending", "paid", "canceled", "failed"] as const).map((s) => (
                <span key={s} className="rounded-full border border-foreground/15 px-2.5 py-1">
                  {s} <b className="tabular-nums">{byStatus[s] ?? 0}</b>
                </span>
              ))}
            </div>
          </section>

          {/* 가입·구매 퍼널 — 윈도우 코호트(그 기간에 처음 달성한 수) */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-zinc-500">
              가입·구매 퍼널{" "}
              <span className="font-normal">(기간 내 최초 달성 코호트)</span>
            </h2>
            <div className="grid grid-cols-5 gap-1 text-center">
              <FunnelStep label="방문(익명)" value={funnel.anon_users} />
              <FunnelStep label="플레이" value={funnel.players} rate={pct(funnel.players, funnel.anon_users)} />
              <FunnelStep label="가입" value={funnel.members} rate={pct(funnel.members, funnel.players)} />
              <FunnelStep label="첫 생성" value={funnel.first_gen} rate={pct(funnel.first_gen, funnel.members)} />
              <FunnelStep label="첫 구매" value={funnel.first_purchase} rate={pct(funnel.first_purchase, funnel.members)} />
            </div>
            {window === "all" && (
              <p className="mt-1 text-[11px] text-zinc-400">
                일별 동결(2026-08-29 도입) 이전 과거는 현재 잔존 데이터 기준 근사예요 — 정리된 익명
                계정·탈퇴 회원은 소급되지 않아요.
              </p>
            )}
          </section>

          {/* 오래된 결제요청 (확인 필요) + 운영 액션 */}
          <section>
            <h2 className="mb-1 text-sm font-bold text-amber-600">
              오래된 결제요청 — 확인 필요
            </h2>
            <p className="mb-2 text-xs leading-relaxed text-zinc-500">
              결제 시도 후 2시간+ pending. 대사 cron 이 포트원 조회로 자동 해소하며,
              남은 건은 &lsquo;지급&rsquo; 시 서버가 포트원 결제상태(PAID·금액)를 검증한 뒤 지급해요.
            </p>
            <StalePendingTable rows={stale} />
          </section>

        {/* 환불 운영은 전용 큐, 회원별 CS 크레딧 조정은 회원 상세에서 */}
        <p className="text-xs text-zinc-500">
          진행 중 환불·대사 이슈는{" "}
          <Link href="/admin/refunds" className="text-sky-600 underline">
            환불 큐
          </Link>
          에서 처리하세요. 회원별 CS 크레딧 조정·수량 환불은{" "}
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
    <div className="rounded-xl border border-foreground/10 ui-surface p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-zinc-400">{sub}</p>}
    </div>
  );
}

function FunnelStep({ label, value, rate }: { label: string; value: number; rate?: string }) {
  return (
    <div className="rounded-lg border border-foreground/10 ui-surface p-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="text-base font-bold tabular-nums">{value.toLocaleString()}</p>
      {rate && <p className="text-[10px] text-amber-600">{rate}</p>}
    </div>
  );
}
