import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import Link from "next/link";
import {
  getAdminFunnelWindow,
  getOrderSummaryWindow,
  getStalePending,
  getRefundWarnings,
  getUserCompositionWindow,
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

  const [funnel, composition, summary, stale, refundWarnings] = await Promise.all([
    getAdminFunnelWindow(window),
    getUserCompositionWindow(window),
    getOrderSummaryWindow(window),
    getStalePending(),
    getRefundWarnings(),
  ]);

  const byStatus = summary.by_status;

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h1 className="text-2xl font-bold">운영 대시보드</h1>
          <PeriodTabs basePath="/admin" current={window} />
        </div>
        <p className="-mt-4 text-xs text-zinc-400">
          {statWindowLabel(window)} · KST 달력일 기준. 오늘은 실시간, 어제까지의 &lsquo;처음&rsquo; 행은 일 단위
          확정 집계예요(전체·다시 행은 기간 내 유저 수 직조회).
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

          {/* 유저 퍼널(v1.17) — 기간 내 활동 유저(전체) 5단계 가로 연속. 전체=raw RPC(0117), 가입=롤업 members.
              전환율은 이전 단계 대비. 방문=상호작용·봇 게이트 통과 방문(uid 단위). */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-zinc-500">
              유저 퍼널{" "}
              <span className="font-normal">(기간 내 활동 유저 · 전환율은 이전 단계 대비)</span>
            </h2>
            <div className="grid grid-cols-5 gap-1 text-center">
              <FunnelStep label="방문" value={composition.visit.total} members={composition.visit.members} />
              <FunnelStep
                label="플레이"
                value={composition.play.total}
                members={composition.play.members}
                rate={pct(composition.play.total, composition.visit.total)}
              />
              <FunnelStep label="가입" value={funnel.members} rate={pct(funnel.members, composition.play.total)} />
              <FunnelStep
                label="생성"
                value={composition.generation.total}
                rate={pct(composition.generation.total, funnel.members)}
              />
              <FunnelStep
                label="결제"
                value={composition.purchase.total}
                rate={pct(composition.purchase.total, composition.generation.total)}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
              유저 단위(비회원=브라우저 익명 계정, 회원=계정). 방문 = 첫 터치·스크롤 등 상호작용이 있었던
              방문(봇 제외, 2026-09-03 수집 시작). 플레이 = 점수 제출(진입→제출은 게임 분석). 생성 = 캐릭터
              생성. 결제 = 결제 완료(테스트 제외).
            </p>
          </section>

          {/* 유저 구성(v1.17) — 단계별 처음/다시. 처음=일별 롤업+오늘 라이브(0112 단일 소스, first_visit 추가),
              다시=raw RPC(0117). 가입은 계정당 1회라 다시 없음. */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-zinc-500">
              유저 구성{" "}
              <span className="font-normal">(처음 = 기간 안에 처음 함 · 다시 = 전에 한 적 있는 상태로 기간 안에 또 함)</span>
            </h2>
            {(() => {
              // 퍼널과 같은 5열(단계) × 2행(처음/다시) — 위 퍼널 카드와 열이 맞아 세로로 읽힌다.
              const stages: { label: string; total: number; first: number; again: number | null }[] = [
                { label: "방문", total: composition.visit.total, first: funnel.first_visit, again: composition.visit.again },
                { label: "플레이", total: composition.play.total, first: funnel.players, again: composition.play.again },
                { label: "가입", total: funnel.members, first: funnel.members, again: null },
                { label: "생성", total: composition.generation.total, first: funnel.first_gen, again: composition.generation.again },
                { label: "결제", total: composition.purchase.total, first: funnel.first_purchase, again: composition.purchase.again },
              ];
              return (
                <div className="grid grid-cols-5 gap-1 text-center">
                  {stages.map((st) => (
                    <p key={`h-${st.label}`} className="text-[10px] text-zinc-500">
                      {st.label}
                    </p>
                  ))}
                  {stages.map((st) => (
                    <CompositionCard key={`first-${st.label}`} label="처음" value={st.first.toLocaleString()} />
                  ))}
                  {stages.map((st) => (
                    <CompositionCard
                      key={`again-${st.label}`}
                      label="다시"
                      value={st.again === null ? "—" : st.again.toLocaleString()}
                      sub={st.again !== null && st.total > 0 ? pct(st.again, st.total) : undefined}
                    />
                  ))}
                </div>
              );
            })()}
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
              다시 카드의 % = 그 단계 전체 대비. 기간 안에서 처음 하고 또 한 유저는 둘 다에 세요(오늘 탭은 겹침
              없음). 가입은 계정당 1회라 다시가 없어요. 결제의 다시 = 재구매. 가입 시 익명 시절 기록은 회원 계정에
              합쳐요.
              {window === "all" &&
                " 전체 탭에서는 처음 = 전체이고, 일별 동결(2026-08-29 도입) 이전 과거는 현재 잔존 데이터 기준 근사예요 — 정리된 익명 계정·탈퇴 회원은 소급되지 않아요."}
            </p>
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
    <div className="h-full rounded-xl border border-foreground/10 ui-surface p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-zinc-400">{sub}</p>}
    </div>
  );
}

/** 유저 구성 카드(처음/다시) — 퍼널 카드와 같은 폭·토큰, 세 줄(라벨/값/전체 대비 %). */
function CompositionCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-foreground/10 ui-surface p-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="text-base font-bold tabular-nums">{value}</p>
      <p className="text-[10px] tabular-nums text-zinc-400">{sub ?? "\u00a0"}</p>
    </div>
  );
}

/** 퍼널 카드(구 FunnelStep + 회원 병기 줄) — 5열 고정이라 라벨은 짧게, 줄 수를 맞춰 카드 높이를 정렬한다. */
function FunnelStep({ label, value, members, rate }: { label: string; value: number; members?: number; rate?: string }) {
  return (
    <div className="rounded-lg border border-foreground/10 ui-surface p-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="text-base font-bold tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[10px] tabular-nums text-zinc-400">
        {members === undefined ? "\u00a0" : `회원 ${members.toLocaleString()}`}
      </p>
      <p className="text-[10px] text-amber-600">{rate ?? "\u00a0"}</p>
    </div>
  );
}
