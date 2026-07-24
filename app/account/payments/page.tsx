import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGrowthLevers } from "@/lib/config/getters";
import { won } from "@/lib/admin-format";
import { CreditsSummaryCard } from "@/components/account/CreditsSummaryCard";

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
};

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

/** KST 일자 — 결제기록은 수년 보존이라 연 표기 필수(fmtKst 는 월일시분만이라 미사용). */
function fmtKstDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return "—";
  }
}

/**
 * 결제내역(마이페이지) — 본인 주문 목록 + 크레딧 3분류 카드 + 영수증(PortOne receiptUrl) 링크.
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
  // 최신순(paid_at desc nulls last → created_at desc → order_uuid tiebreaker) — 리스트 정렬 규약.
  const [{ data, error }, growth] = await Promise.all([
    admin
      .from("orders")
      .select(
        "order_uuid, product_id, amount, credits, status, paid_at, refunded_credits, refunded_amount, receipt_url, created_at"
      )
      .eq("user_id", userId)
      .order("paid_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
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

        <CreditsSummaryCard />

        {rows.length === 0 ? (
          <p className="text-sm text-zinc-400">아직 결제 내역이 없어요.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-foreground/10">
            <table className="w-full text-left text-xs">
              <thead className="ui-surface text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5">상품</th>
                  <th className="px-2 py-1.5 text-right">금액</th>
                  <th className="px-2 py-1.5 text-right">크레딧</th>
                  <th className="px-2 py-1.5">상태</th>
                  <th className="px-2 py-1.5">영수증</th>
                  <th className="px-2 py-1.5">일시</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const label = orderStateLabel(r);
                  return (
                    <tr key={r.order_uuid} className="border-t border-foreground/5">
                      <td className="px-2 py-1.5">{goodnameById.get(r.product_id) ?? r.product_id}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {won(r.amount)}
                        {r.refunded_amount > 0 && (
                          <span className="block text-[10px] text-zinc-400">
                            환불 {won(r.refunded_amount)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.credits}</td>
                      <td className={`px-2 py-1.5 font-semibold ${LABEL_COLOR[label] ?? ""}`}>
                        {label}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.receipt_url ? (
                          <a
                            href={r.receipt_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-600 underline-offset-2 hover:underline"
                          >
                            보기
                          </a>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                        {fmtKstDate(r.paid_at ?? r.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
