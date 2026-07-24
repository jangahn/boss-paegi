import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import {
  getUserMemberInfo,
  getUserOrders,
  getUserGenerations,
  getUserDolls,
  getUserCreditLedger,
  getUserLots,
  getUserRefundActivity,
} from "@/lib/admin-users";
import { getLedger } from "@/lib/admin-ledger";
import { CreditLedgerTable } from "@/components/admin/CreditLedgerTable";
import { getRoleConfig } from "@/lib/config/getters";
import { OrdersTable } from "@/components/admin/OrdersTable";
import { LedgerTable } from "@/components/admin/LedgerTable";
import { GenerationsTable, DollsList } from "@/components/admin/UserSections";
import { CreditAdjustForm } from "@/components/admin/CreditAdjustForm";
import { ReactivateAccountForm } from "@/components/admin/ReactivateAccountForm";
import { Pagination } from "@/components/Pagination";
import {
  LOT_SOURCE_LABELS,
  LOT_EXPIRATION_LABELS,
  REQUEST_STATE_META,
  ISSUE_TYPE_LABELS,
} from "@/components/admin/refund-saga-ui";
import type { UserLotRow, RefundRequestRow, ReconIssueRow } from "@/lib/admin-types";
import { fmtKst, shortId, firstParam, won } from "@/lib/admin-format";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pageOf = (v: string | string[] | undefined) => Math.max(1, Number(firstParam(v)) || 1);

/** 로트 잔여 = 부여 − 소비 − 환불 − 환불 예약(refund_reserved). 0062 카운터 규약. */
const lotRemaining = (l: UserLotRow) => l.qty - l.consumed - l.refunded - l.refund_reserved;

/** 진행 중 환불 요청 1건 — 환불 큐(/admin/refunds)에서 조치. 경고 행(WarningRow) 토큰 재사용. */
function RefundRequestItem({ req }: { req: RefundRequestRow }) {
  const meta = REQUEST_STATE_META[req.state] ?? {
    label: req.state,
    cls: "bg-foreground/10 text-zinc-500",
  };
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-background/60 p-2 text-xs">
      <span className={`rounded-full px-2 py-0.5 font-semibold ${meta.cls}`}>{meta.label}</span>
      <span className="text-zinc-500">환불 요청 {req.requested_qty}개</span>
      {req.approved_amount !== null && <span>{won(req.approved_amount)}</span>}
      {req.scope_order_uuid && (
        <span className="font-mono text-zinc-400">주문 {shortId(req.scope_order_uuid)}</span>
      )}
      <span className="max-w-[12rem] truncate text-zinc-400" title={req.reason}>
        {req.reason}
      </span>
      <span className="ml-auto tabular-nums text-zinc-400">{fmtKst(req.created_at)}</span>
    </li>
  );
}

/** open 대사 이슈 1건 — 환불 큐에서 화해. blocked 토큰(bg-red-500/15) 재사용. */
function ReconIssueItem({ issue }: { issue: ReconIssueRow }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-background/60 p-2 text-xs">
      <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-semibold text-red-500">
        {ISSUE_TYPE_LABELS[issue.type] ?? issue.type}
      </span>
      <span className="font-mono text-zinc-400">주문 {shortId(issue.order_uuid)}</span>
      <span className="ml-auto tabular-nums text-zinc-400">{fmtKst(issue.created_at)}</span>
    </li>
  );
}

/** 크레딧 로트 현황 표(0062) — 소스·잔여·상태(만료/quarantine)·부여/만료. 조회 전용 RSC. */
function LotsTable({ rows }: { rows: UserLotRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-foreground/15 p-4 text-center text-xs text-zinc-500">
        크레딧 로트가 없어요. (로트 원장 적용 후 신규 부여분부터 쌓여요.)
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-foreground/10">
      <table className="w-full text-left text-xs">
        <thead className="ui-surface text-zinc-500">
          <tr>
            <th className="px-2 py-1.5">소스</th>
            <th className="px-2 py-1.5 text-right">잔여</th>
            <th className="px-2 py-1.5 text-right">부여량</th>
            <th className="px-2 py-1.5">상태</th>
            <th className="px-2 py-1.5">주문</th>
            <th className="px-2 py-1.5">부여(KST)</th>
            <th className="px-2 py-1.5">만료(KST)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const remaining = lotRemaining(l);
            return (
              <tr key={l.id} className="border-t border-foreground/5">
                <td className="px-2 py-1.5">{LOT_SOURCE_LABELS[l.source] ?? l.source}</td>
                <td
                  className={`px-2 py-1.5 text-right tabular-nums font-bold ${
                    remaining > 0 ? "text-foreground" : "text-zinc-400"
                  }`}
                >
                  {remaining}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{l.qty}</td>
                <td className="px-2 py-1.5">
                  {l.expired_at ? (
                    <span className="text-red-500">
                      {LOT_EXPIRATION_LABELS[l.expiration_reason ?? ""] ?? l.expiration_reason}
                    </span>
                  ) : (
                    <span className="text-emerald-600">유효</span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-zinc-400">
                  {l.order_uuid ? shortId(l.order_uuid) : "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-400">
                  {fmtKst(l.granted_at)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-400">
                  {l.expired_at ? fmtKst(l.expired_at) : fmtKst(l.expires_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdminUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const { id } = await params;
  const member = await getUserMemberInfo(id);

  // 섹션별 독립 페이지 파라미터.
  const sp = await searchParams;
  const pages = {
    ordersPage: pageOf(sp.ordersPage),
    adjPage: pageOf(sp.adjPage),
    creditPage: pageOf(sp.creditPage),
    genPage: pageOf(sp.genPage),
    dollsPage: pageOf(sp.dollsPage),
  };
  const hrefFor = (key: keyof typeof pages) => (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(pages)) {
      const val = k === key ? p : v;
      if (val > 1) u.set(k, String(val));
    }
    return `/admin/users/${id}${u.toString() ? `?${u}` : ""}`;
  };

  if (!member) {
    return (
      <main className="flex flex-1 flex-col px-5 py-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <h1 className="text-2xl font-bold">유저 상세</h1>
          <p className="text-sm text-zinc-500">
            회원(member_accounts)이 아니거나 존재하지 않는 유저예요. (id: {shortId(id)})
          </p>
          <Link href={`/history/${id}`} className="text-sm text-sky-600 underline">
            플레이 내역 보기 →
          </Link>
        </div>
      </main>
    );
  }

  const [orders, adjustments, creditLedger, generations, dolls, lots, refundActivity, roleCfg] =
    await Promise.all([
      getUserOrders(id, pages.ordersPage),
      getLedger({ targetUserId: id, page: pages.adjPage }),
      getUserCreditLedger(id, pages.creditPage),
      getUserGenerations(id, pages.genPage),
      getUserDolls(id, pages.dollsPage),
      getUserLots(id), // 로트 현황 — 페이징 없음(상한 100).
      getUserRefundActivity(id), // 진행 중 request + open issue.
      getRoleConfig(), // 어드민 유저표 역할 호칭 = DB 발행값(roleFrom)
    ]);

  // overshoot(존재 행보다 큰 섹션 page) → 1페이지로(빈 화면·페이저 소실 방지). 한 번에 하나씩 수렴.
  if (orders.rows.length === 0 && pages.ordersPage > 1) redirect(hrefFor("ordersPage")(1));
  if (adjustments.rows.length === 0 && pages.adjPage > 1) redirect(hrefFor("adjPage")(1));
  if (creditLedger.rows.length === 0 && pages.creditPage > 1) redirect(hrefFor("creditPage")(1));
  if (generations.rows.length === 0 && pages.genPage > 1) redirect(hrefFor("genPage")(1));
  if (dolls.rows.length === 0 && pages.dollsPage > 1) redirect(hrefFor("dollsPage")(1));

  const pp = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

  const hasRefundActivity =
    refundActivity.requests.length > 0 || refundActivity.issues.length > 0;

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        {/* 회원 기본정보 */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold">{member.displayName ?? "(닉네임 없음)"}</h1>
            {member.isAdmin && (
              <span className="rounded-full border border-emerald-600/40 px-2 py-0.5 text-xs text-emerald-600">
                admin
              </span>
            )}
            {member.deletedAt && (
              <span className="rounded-full border border-red-500/40 px-2 py-0.5 text-xs text-red-500">
                탈퇴함 · {fmtKst(member.deletedAt)}
              </span>
            )}
            {member.abuseStatus === "banned" && (
              <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                정지된 유저
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>{member.email ?? "이메일 없음"}</span>
            <span>
              보유 크레딧 <b className="tabular-nums text-foreground">{member.genCredits}</b>개
            </span>
            <span>가입 {fmtKst(member.memberSince)}</span>
            <span className="font-mono">{member.userId}</span>
          </div>
          <Link href={`/history/${id}`} className="text-sm text-sky-600 underline">
            플레이 내역 보기 →
          </Link>
        </section>

        {/* 탈퇴 계정 재활성 — 탈퇴 상태에서만 노출(0037) */}
        {member.deletedAt && (
          <section>
            <ReactivateAccountForm
              target={{ userId: member.userId, originalEmail: member.email }}
            />
          </section>
        )}

        {/* 진행 중 환불 · 대사 이슈 — 활동이 있을 때만(조치는 /admin/refunds). */}
        {hasRefundActivity && (
          <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
            <h2 className="text-sm font-bold text-amber-600">진행 중 환불 · 대사 이슈</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              아래 환불 요청·대사 이슈는 처리 중이에요. 조치는{" "}
              <Link
                href="/admin/refunds"
                className="text-sky-600 underline underline-offset-2"
              >
                환불 큐
              </Link>
              에서 진행하세요.
            </p>
            {refundActivity.requests.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {refundActivity.requests.map((req) => (
                  <RefundRequestItem key={req.id} req={req} />
                ))}
              </ul>
            )}
            {refundActivity.issues.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {refundActivity.issues.map((issue) => (
                  <ReconIssueItem key={issue.id} issue={issue} />
                ))}
              </ul>
            )}
          </section>
        )}

        {/* CS 크레딧 조정 */}
        <section>
          <h2 className="mb-2 text-sm font-bold text-zinc-500">CS 크레딧 조정</h2>
          <CreditAdjustForm
            target={{
              userId: member.userId,
              displayName: member.displayName,
              genCredits: member.genCredits,
            }}
          />
        </section>

        {/* 결제 · 크레딧 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-zinc-500">결제 내역 ({orders.total})</h2>
          <OrdersTable rows={orders.rows} />
          <Pagination
            page={orders.page}
            totalPages={pp(orders.total, orders.pageSize)}
            hrefFor={hrefFor("ordersPage")}
          />
          <h2 className="mt-2 text-sm font-bold text-zinc-500">크레딧 조정/환불 이력 ({adjustments.total})</h2>
          <LedgerTable rows={adjustments.rows} />
          <Pagination
            page={adjustments.page}
            totalPages={pp(adjustments.total, adjustments.pageSize)}
            hrefFor={hrefFor("adjPage")}
          />
          <h2 className="mt-2 text-sm font-bold text-zinc-500">
            크레딧 사용 내역 · 생성 차감/환불 ({creditLedger.total})
          </h2>
          <p className="-mt-1 text-[11px] text-zinc-400">충전(구매)은 위 결제 내역, 운영자 조정은 크레딧 조정 이력에 있어요.</p>
          <CreditLedgerTable rows={creditLedger.rows} />
          <Pagination
            page={creditLedger.page}
            totalPages={pp(creditLedger.total, creditLedger.pageSize)}
            hrefFor={hrefFor("creditPage")}
          />
          <h2 className="mt-2 text-sm font-bold text-zinc-500">크레딧 로트 현황 ({lots.length})</h2>
          <p className="-mt-1 text-[11px] text-zinc-400">잔여 = 부여 − 소비 − 환불 − 환불 예약. 만료·회수된 로트는 상태에 사유가 표시돼요.</p>
          <LotsTable rows={lots} />
        </section>

        {/* 콘텐츠 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-zinc-500">AI 생성 내역 ({generations.total})</h2>
          <GenerationsTable rows={generations.rows} cfg={roleCfg} />
          <Pagination
            page={generations.page}
            totalPages={pp(generations.total, generations.pageSize)}
            hrefFor={hrefFor("genPage")}
          />
          <h2 className="mt-2 text-sm font-bold text-zinc-500">보유 캐릭터 ({dolls.total})</h2>
          <DollsList rows={dolls.rows} cfg={roleCfg} />
          <Pagination
            page={dolls.page}
            totalPages={pp(dolls.total, dolls.pageSize)}
            hrefFor={hrefFor("dollsPage")}
          />
        </section>
      </div>
    </main>
  );
}
