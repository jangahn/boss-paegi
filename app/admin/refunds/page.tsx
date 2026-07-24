import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getRefundQueue } from "@/lib/admin-data";
import type { RefundAttemptRow, RefundRequestRow, ReconIssueRow } from "@/lib/admin-types";
import {
  ATTEMPT_STATE_META,
  REQUEST_STATE_META,
  ISSUE_TYPE_LABELS,
} from "@/components/admin/refund-saga-ui";
import { RefundQueueActions } from "@/components/admin/RefundQueueActions";
import { won, shortId, fmtKst } from "@/lib/admin-format";

// 실시간 운영 큐 — 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 미매핑 상태·타입 폴백 배지 스타일(refund-saga-ui 어휘 밖의 값 방어). */
const FALLBACK_BADGE = { label: "", cls: "bg-foreground/10 text-zinc-500" };

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

/** 회원 표기 = /admin/users/{id} 링크(신규 표면 규약). display_name 없으면 shortId 폴백. */
function MemberLink({ userId, displayName }: { userId: string; displayName: string | null }) {
  return (
    <Link
      href={`/admin/users/${userId}`}
      className="max-w-[8rem] truncate text-sky-600 underline-offset-2 hover:underline"
      title="회원 상세로 이동"
    >
      {displayName ?? shortId(userId)}
    </Link>
  );
}

function EmptyState() {
  return (
    <p className="mt-3 rounded-2xl border border-dashed border-foreground/15 p-6 text-center text-sm text-zinc-500">
      처리할 항목이 없습니다.
    </p>
  );
}

function IssueRow({ issue: i }: { issue: ReconIssueRow }) {
  return (
    <li className="rounded-2xl border border-foreground/10 ui-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge label={ISSUE_TYPE_LABELS[i.type] ?? i.type} cls="bg-amber-500/15 text-amber-600" />
            <span className="text-[11px] text-zinc-400">· {fmtKst(i.created_at)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="font-mono text-zinc-400">{shortId(i.order_uuid)}</span>
            <MemberLink userId={i.user_id} displayName={i.display_name} />
            {i.cancellation_id && (
              <span className="font-mono text-zinc-400">취소 {shortId(i.cancellation_id)}</span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <RefundQueueActions kind="issue" issueId={i.id} cancellationId={i.cancellation_id} />
        </div>
      </div>
    </li>
  );
}

function RequestRow({ request: r }: { request: RefundRequestRow }) {
  const meta = REQUEST_STATE_META[r.state] ?? { ...FALLBACK_BADGE, label: r.state };
  return (
    <li className="rounded-2xl border border-foreground/10 ui-surface p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge label={meta.label} cls={meta.cls} />
        <span className="text-[11px] text-zinc-400">· {fmtKst(r.created_at)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        {r.scope_order_uuid ? (
          <span className="font-mono text-zinc-400">{shortId(r.scope_order_uuid)}</span>
        ) : (
          <span className="text-zinc-400">집계</span>
        )}
        <MemberLink userId={r.user_id} displayName={r.display_name} />
        <span className="text-zinc-500">요청 {r.requested_qty}개</span>
        {r.approved_amount != null && <span className="text-zinc-500">승인 {won(r.approved_amount)}</span>}
      </div>
      {r.reason && <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{r.reason}</p>}
    </li>
  );
}

function AttemptRow({ attempt: a }: { attempt: RefundAttemptRow }) {
  const meta = ATTEMPT_STATE_META[a.state] ?? { ...FALLBACK_BADGE, label: a.state };
  return (
    <li className="rounded-2xl border border-foreground/10 ui-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge label={meta.label} cls={meta.cls} />
            <span className="text-[11px] text-zinc-400">· {fmtKst(a.created_at)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="font-mono text-zinc-400">{shortId(a.order_uuid)}</span>
            <MemberLink userId={a.user_id} displayName={a.display_name} />
            <span className="text-zinc-500">
              {a.qty}개 · {won(a.amount)} (환급률 {a.rate_bps / 100}%)
            </span>
          </div>
          {a.pg_requested_at && (
            <p className="mt-1 text-[11px] text-zinc-400">PG 요청 {fmtKst(a.pg_requested_at)}</p>
          )}
        </div>
        <div className="shrink-0">
          <RefundQueueActions kind="attempt" attemptId={a.id} state={a.state} />
        </div>
      </div>
    </li>
  );
}

export default async function AdminRefundsPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const { openIssues, activeRequests, openAttempts } = await getRefundQueue();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-xl font-bold">환불 운영 큐</h1>
      <p className="mt-1 text-sm text-zinc-500">
        대사 이슈·진행 중 환불 요청·미종결 환불 시도를 확인하고 처리합니다. 자동/수동 지급·해제·화해는 각 행에서 실행합니다.
      </p>

      {/* 대사 이슈 — 전 타입 open(최신순). */}
      <section className="mt-6">
        <h2 className="text-sm font-bold">
          대사 이슈 <span className="font-normal text-zinc-500">{openIssues.length}건</span>
        </h2>
        {openIssues.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="mt-3 space-y-2">
            {openIssues.map((i) => (
              <IssueRow key={i.id} issue={i} />
            ))}
          </ul>
        )}
      </section>

      {/* 환불 요청 — 비종단(building·prepared·processing·blocked, 최신순). 조치는 시도 단위. */}
      <section className="mt-6">
        <h2 className="text-sm font-bold">
          환불 요청 <span className="font-normal text-zinc-500">{activeRequests.length}건</span>
        </h2>
        {activeRequests.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="mt-3 space-y-2">
            {activeRequests.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </ul>
        )}
      </section>

      {/* 환불 시도 — 미종결(open) 6종(최신순). */}
      <section className="mt-6">
        <h2 className="text-sm font-bold">
          환불 시도 <span className="font-normal text-zinc-500">{openAttempts.length}건</span>
        </h2>
        {openAttempts.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="mt-3 space-y-2">
            {openAttempts.map((a) => (
              <AttemptRow key={a.id} attempt={a} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
