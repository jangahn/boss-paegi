import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/auth-server";
import { getCreditHistory, USER_PAGE_SIZE, type CreditHistoryRow } from "@/lib/admin-users";
import { firstParam } from "@/lib/admin-format";
import { fmtKstDateTime } from "@/lib/format";
import { Pagination } from "@/components/Pagination";

// 본인 생성권 변동 실시간 조회 — 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "생성권 내역" };

/** 유저용 라벨 — 어드민 jargon 금지, kind(+delta 부호) → 사람이 읽는 표현. */
function creditLabel(row: CreditHistoryRow): string {
  switch (row.kind) {
    case "signup_bonus":
      return "가입 보너스";
    case "purchase":
      return "구매";
    case "gen_consume":
      return "캐릭터 생성";
    case "gen_refund":
      return "생성 환불";
    case "cs_adjust":
      return row.delta > 0 ? "운영자 지급" : "운영자 조정";
    case "refund":
      return "환불";
    case "refund_policy_close":
      return "환불(마감)";
    case "expire":
      return "만료";
    default:
      return row.kind;
  }
}

/**
 * 생성권 내역(마이페이지) — 가입 보너스·구매·캐릭터 생성/환불·운영자 조정·만료 등 모든 생성권 변동을
 * 한 타임라인으로(getCreditHistory 3소스 병합, 읽기 전용). ref/사유 등 어드민 식별자는 비노출.
 * 게이트: proxy 가 /account/* 를 회원 전용으로 선차단 — 여기 requireMember 는 백스톱(payments 와 동일 패턴).
 */
export default async function AccountCreditsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireMember();
  if (!gate.ok) {
    if (gate.error === "consent_required") redirect("/consent?next=/account/credits");
    if (gate.error === "account_deleted") redirect("/login?error=account_deleted");
    redirect("/login?next=/account/credits");
  }
  const userId = gate.user.id;

  const sp = await searchParams;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);
  const history = await getCreditHistory(userId, page);
  // overshoot(존재 행보다 큰 page) → 1페이지로(빈 화면·페이저 소실 방지).
  if (history.rows.length === 0 && page > 1) redirect("/account/credits");

  const totalPages = Math.max(1, Math.ceil(history.total / USER_PAGE_SIZE));
  const hrefFor = (p: number) => (p > 1 ? `/account/credits?page=${p}` : "/account/credits");

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">생성권 내역</h1>

        {history.rows.length === 0 ? (
          <p className="text-sm text-zinc-400">아직 생성권 변동 내역이 없어요.</p>
        ) : (
          // 결제내역과 같은 카드 톤(ui-surface·rounded-xl·border-foreground/10) — 라벨·증감·잔액·일시.
          <ul className="flex flex-col gap-2.5">
            {history.rows.map((r) => (
              <li
                key={r.id}
                className="ui-surface flex items-center gap-3 rounded-xl border border-foreground/10 p-4"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-semibold leading-snug text-foreground">
                    {creditLabel(r)}
                  </span>
                  <span className="tabular-nums text-xs text-zinc-400">
                    {fmtKstDateTime(r.createdAt)}
                  </span>
                </div>
                <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={`tabular-nums text-sm font-bold ${
                      r.delta >= 0 ? "text-emerald-600" : "text-red-500"
                    }`}
                  >
                    {r.delta >= 0 ? `+${r.delta}` : r.delta}
                  </span>
                  {r.balanceAfter !== null && (
                    <span className="tabular-nums text-xs text-zinc-400">
                      {r.balanceBefore !== null && <>{r.balanceBefore}개 </>}
                      →{" "}
                      <span className="font-semibold text-foreground/70">
                        {r.balanceAfter}개
                      </span>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <Pagination page={history.page} totalPages={totalPages} hrefFor={hrefFor} />
      </div>
    </main>
  );
}
