import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGrowthLevers } from "@/lib/config/getters";
import { won } from "@/lib/admin-format";
import { CHANNEL_LABELS, type PayChannelMethod } from "@/lib/pay-channels";

// 본인 결제·환불 실시간 조회 — 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "결제내역" };

type OrderRow = {
  order_uuid: string;
  product_id: string;
  amount: number;
  credits: number;
  status: string;
  paid_at: string | null;
  refunded_credits: number;
  refunded_amount: number;
  receipt_url: string | null;
  created_at: string;
  pay_channel: string | null;
  is_test: boolean;
};

/** 결제수단 표기 — pay_channel(0059) → 사용자 라벨(카드/토스페이/카카오페이). null=표시 생략. */
function payChannelLabel(pay_channel: string | null): string | null {
  if (!pay_channel) return null;
  return CHANNEL_LABELS[pay_channel as PayChannelMethod] ?? pay_channel;
}

const STATUS_LABEL: Record<string, string> = {
  paid: "결제완료",
  pending: "대기",
  canceled: "취소",
  failed: "실패",
};

const LABEL_COLOR: Record<string, string> = {
  결제완료: "text-emerald-600",
  대기: "text-amber-600",
  취소: "text-zinc-400",
  실패: "text-red-500",
  부분환불: "text-amber-600",
  전액환불: "text-zinc-400",
};

/** 표시 상태 — 크레딧 전량 회수=전액환불(요율로 현금<amount 일 수 있음: 7일후 90%·만료후 90%),
 *  일부만=부분환불, 그 외 주문 status. 판정 기준은 크레딧(회수 완료 여부)이지 현금액이 아니다. */
function orderStateLabel(o: OrderRow): string {
  if (o.refunded_credits >= o.credits && o.refunded_amount > 0) return "전액환불";
  if (o.refunded_credits > 0) return "부분환불";
  return STATUS_LABEL[o.status] ?? o.status;
}

/** KST 일시 — 결제기록은 수년 보존이라 연 표기 필수 + 시:분(admin fmtKst 는 연 없이 월일시분이라 미사용). */
function fmtKstDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

/**
 * 결제내역(마이페이지) — 결제완료(paid_at 존재) 주문만 + 결제수단·영수증(PortOne receiptUrl) 링크.
 * 대기/취소/실패(paid_at null) 는 비노출; 결제 후 환불건은 paid_at 이 남아 계속 표시. 크레딧 개수는
 * 헤더 드롭다운(AccountMenu '생성권 N')에 있어 이 페이지엔 요약 카드 없음.
 * 게이트: proxy 가 /account/* 를 회원 전용으로 선차단 — 여기 requireMember 는 백스톱(레이스 방어).
 * 환불 산정·수치의 정본은 이용약관 제10조 단일 소스 — 여기엔 참조 안내만(수치 재기입 금지, v0.75).
 */
export default async function AccountPaymentsPage() {
  const gate = await requireMember();
  if (!gate.ok) {
    if (gate.error === "consent_required") redirect("/consent?next=/account/payments");
    if (gate.error === "account_deleted") redirect("/login?error=account_deleted");
    redirect("/login?next=/account/payments");
  }
  const userId = gate.user.id;

  const admin = createAdminClient();
  // 결제완료만(paid_at not null) + 최신순(paid_at desc → order_uuid tiebreaker) — 표시 일시(paid_at)와 정렬키 일치.
  const [{ data, error }, growth] = await Promise.all([
    admin
      .from("orders")
      .select(
        "order_uuid, product_id, amount, credits, status, paid_at, refunded_credits, refunded_amount, receipt_url, created_at, pay_channel, is_test"
      )
      .eq("user_id", userId)
      .not("paid_at", "is", null)
      .order("paid_at", { ascending: false })
      .order("order_uuid", { ascending: false })
      .limit(100),
    getGrowthLevers(),
  ]);
  const rows = error ? [] : ((data ?? []) as OrderRow[]);
  // 상품명은 config 상품 목록(비활성 포함)으로 표기 — 과거 주문의 productId 도 매핑, 미지값은 id 그대로.
  const goodnameById = new Map(growth.products.map((p) => [p.productId, p.goodname]));

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">결제내역</h1>

        {rows.length === 0 ? (
          <p className="text-sm text-zinc-400">아직 결제 내역이 없어요.</p>
        ) : (
          // 모바일 우선 카드 리스트 — 소형폰(iPhone SE 375px)에서도 상품명/금액/상태가 한눈에.
          <ul className="flex flex-col gap-2.5">
            {rows.map((r) => {
              const label = orderStateLabel(r);
              const channelLabel = payChannelLabel(r.pay_channel);
              const remaining = r.credits - r.refunded_credits;
              return (
                <li
                  key={r.order_uuid}
                  className="ui-surface flex flex-col gap-2.5 rounded-xl border border-foreground/10 p-4"
                >
                  {/* 상품명 + 상태 */}
                  <div className="flex items-start justify-between gap-2.5">
                    <span className="text-sm font-semibold leading-snug text-foreground">
                      {goodnameById.get(r.product_id) ?? r.product_id}
                    </span>
                    <span className={`shrink-0 text-sm font-bold ${LABEL_COLOR[label] ?? "text-zinc-500"}`}>
                      {label}
                    </span>
                  </div>

                  {/* 금액 · 크레딧 · 결제수단 (좁으면 자연 래핑) */}
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
                    <span className="font-medium tabular-nums text-foreground">
                      {won(r.amount)}
                      {r.refunded_amount > 0 && (
                        <span className="ml-1 text-xs text-zinc-400">환불 {won(r.refunded_amount)}</span>
                      )}
                    </span>
                    <span aria-hidden className="text-zinc-300">·</span>
                    <span className="tabular-nums text-foreground">
                      크레딧 {r.credits}개
                      {r.refunded_credits > 0 && (
                        <span className="ml-1 text-xs text-zinc-400">잔여 {remaining}개</span>
                      )}
                    </span>
                    {(channelLabel || r.is_test) && (
                      <>
                        <span aria-hidden className="text-zinc-300">·</span>
                        <span className="flex items-center gap-1 text-zinc-500">
                          {channelLabel}
                          {r.is_test && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[10px] font-semibold text-amber-500">
                              테스트
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </div>

                  {/* 일시 + 영수증 */}
                  <div className="flex items-center justify-between border-t border-foreground/5 pt-2 text-xs text-zinc-400">
                    <span className="tabular-nums">{fmtKstDateTime(r.paid_at ?? r.created_at)}</span>
                    {r.receipt_url ? (
                      <a
                        href={r.receipt_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-sky-600 underline-offset-2 hover:underline"
                      >
                        영수증 보기 →
                      </a>
                    ) : (
                      <span className="text-zinc-300">영수증 없음</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* 환불 안내 — 약관 참조형만(산정 기준·수치의 정본은 이용약관 제10조, 재기입 금지). */}
        <div className="flex flex-col gap-1.5 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5 text-[11px] leading-relaxed text-zinc-500">
          <p>
            · 환불 기준은{" "}
            <Link href="/terms" className="underline underline-offset-2">
              이용약관 제10조
            </Link>
            를 따릅니다.
          </p>
          <p>· 유료로 구매한 미사용 생성권은 탈퇴 전에 환불을 요청할 수 있어요(이용약관 참조).</p>
        </div>
      </div>
    </main>
  );
}
