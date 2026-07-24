import Link from "next/link";
import type { ReactNode } from "react";
import type {
  AdminOrder,
  RefundAttemptRow,
  RefundRequestRow,
  ReconIssueRow,
} from "@/lib/admin-types";
import { won, shortId } from "@/lib/admin-format";
import { TestBadge } from "@/components/admin/TestBadge";
import {
  ATTEMPT_STATE_META,
  REQUEST_STATE_META,
  ISSUE_TYPE_LABELS,
} from "@/components/admin/refund-saga-ui";

// 카드 톤 — 기존 대시보드 경고 색 토큰 재사용(빨강=개입 급함, 주황=레거시 화해, 노랑=검토).
const TONE = {
  red: { card: "border-red-400/40 bg-red-400/5", title: "text-red-500" },
  orange: { card: "border-orange-500/40 bg-orange-500/5", title: "text-orange-600" },
  amber: { card: "border-amber-500/40 bg-amber-500/5", title: "text-amber-600" },
} as const;

const ROW_CLS = "flex flex-wrap items-center gap-2 rounded-lg bg-background/60 p-2 text-xs";

/** 상태/이슈 뱃지 — CreditLedgerTable·refund-saga-ui 와 동일 pill 토큰(bg-<색>/15 + text-<색>). */
function StateBadge({ label, cls }: { label: string; cls: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

/** 회원 표기 — 항상 /admin/users/{id} 링크(display_name 없으면 shortId 폴백). OrdersTable 와 동일 규약. */
function MemberLink({ userId, name }: { userId: string; name: string | null }) {
  return (
    <Link
      href={`/admin/users/${userId}`}
      className="max-w-[8rem] truncate text-sky-600 underline-offset-2 hover:underline"
      title="회원 상세로 이동"
    >
      {name ?? shortId(userId)}
    </Link>
  );
}

/** 경고 섹션 — 카드 + 헤더(제목 · 환불 큐 링크) + 설명 + 행 목록. 행동은 /admin/refunds 큐로 라우팅. */
function WarnSection({
  tone,
  title,
  desc,
  children,
}: {
  tone: keyof typeof TONE;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <section className={`rounded-xl border p-3 ${t.card}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 className={`text-sm font-bold ${t.title}`}>{title}</h2>
        <Link
          href="/admin/refunds"
          className="text-xs text-sky-600 underline-offset-2 hover:underline"
        >
          환불 큐에서 처리 →
        </Link>
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{desc}</p>
      <ul className="mt-2 flex flex-col gap-1.5">{children}</ul>
    </section>
  );
}

/**
 * 환불 saga(v0.76) 운영 경고 — 대시보드 최상단(stale pending 보다 우선).
 * getRefundWarnings 의 4목록을 그대로 렌더한다:
 *  - attentionAttempts: 개입 필요 미종결 환불 시도(manual_review + stale pg_requested)
 *  - blockedRequests: 수동 검토로 차단된 환불 요청
 *  - openIssues: open 대사 이슈 3종(늦은 결제 확정·미귀속 취소·재관측 불일치)
 *  - unreconciled: 레거시 화해(PG 취소 선도착·크레딧 미회수) — AdminOrder[]
 * 모든 행동은 /admin/refunds 큐로 라우팅(개별 항목은 회원 상세 링크만 노출).
 * invariant_violation 은 여기서 렌더하지 않는다(Sentry 경보 전용, open issue 로 저장 안 됨).
 */
export function DashboardWarnings({
  attentionAttempts,
  blockedRequests,
  openIssues,
  unreconciled,
}: {
  attentionAttempts: RefundAttemptRow[];
  blockedRequests: RefundRequestRow[];
  openIssues: ReconIssueRow[];
  unreconciled: AdminOrder[];
}) {
  if (
    attentionAttempts.length === 0 &&
    blockedRequests.length === 0 &&
    openIssues.length === 0 &&
    unreconciled.length === 0
  )
    return null;

  return (
    <div className="flex flex-col gap-3">
      {attentionAttempts.length > 0 && (
        <WarnSection
          tone="red"
          title={`개입 필요 환불 시도: ${attentionAttempts.length}건`}
          desc="수동 검토 대상이거나 PG 요청 후 오래 멈춘(재시도 기한 경과) 환불 시도예요. 환불 큐에서 상태를 확인해 마무리하세요."
        >
          {attentionAttempts.map((a) => {
            const meta = ATTEMPT_STATE_META[a.state] ?? {
              label: a.state,
              cls: "bg-foreground/10 text-zinc-500",
            };
            return (
              <li key={a.id} className={ROW_CLS}>
                <StateBadge label={meta.label} cls={meta.cls} />
                <span className="font-mono text-zinc-400">{shortId(a.order_uuid)}</span>
                <span className="text-zinc-500">크레딧 {a.qty}</span>
                <span>{won(a.amount)}</span>
                <MemberLink userId={a.user_id} name={a.display_name} />
              </li>
            );
          })}
        </WarnSection>
      )}

      {blockedRequests.length > 0 && (
        <WarnSection
          tone="red"
          title={`차단된 환불 요청: ${blockedRequests.length}건`}
          desc="수동 검토로 막힌 환불 요청이에요. 환불 큐에서 재개하거나 수동 지급으로 처리하세요."
        >
          {blockedRequests.map((r) => {
            const meta = REQUEST_STATE_META[r.state] ?? {
              label: r.state,
              cls: "bg-foreground/10 text-zinc-500",
            };
            return (
              <li key={r.id} className={ROW_CLS}>
                <StateBadge label={meta.label} cls={meta.cls} />
                <span className="font-mono text-zinc-400">
                  {r.scope_order_uuid ? shortId(r.scope_order_uuid) : "—"}
                </span>
                <span className="text-zinc-500">요청 {r.requested_qty}개</span>
                <MemberLink userId={r.user_id} name={r.display_name} />
              </li>
            );
          })}
        </WarnSection>
      )}

      {openIssues.length > 0 && (
        <WarnSection
          tone="amber"
          title={`대사 이슈: ${openIssues.length}건`}
          desc="자동 대사가 사람 확인을 요청한 항목이에요(늦은 결제 확정·미귀속 취소·재관측 불일치). 환불 큐에서 화해하세요."
        >
          {openIssues.map((i) => (
            <li key={i.id} className={ROW_CLS}>
              <StateBadge
                label={ISSUE_TYPE_LABELS[i.type] ?? i.type}
                cls="bg-amber-500/15 text-amber-600"
              />
              <span className="font-mono text-zinc-400">{shortId(i.order_uuid)}</span>
              <MemberLink userId={i.user_id} name={i.display_name} />
            </li>
          ))}
        </WarnSection>
      )}

      {unreconciled.length > 0 && (
        <WarnSection
          tone="orange"
          title={`PG 취소됨 · 크레딧 미회수(레거시): ${unreconciled.length}건`}
          desc="saga 이전에 PG 취소 웹훅이 먼저 도착해 크레딧이 아직 회수되지 않은 주문이에요. 환불 큐 또는 회원 상세에서 화해하세요."
        >
          {unreconciled.map((o) => (
            <li key={o.order_uuid} className={ROW_CLS}>
              <span className="font-mono text-zinc-400">{shortId(o.order_uuid)}</span>
              {o.is_test && <TestBadge />}
              <span>{won(o.amount)}</span>
              <span className="text-zinc-500">크레딧 {o.credits}</span>
              <MemberLink userId={o.user_id} name={o.display_name} />
            </li>
          ))}
        </WarnSection>
      )}
    </div>
  );
}
