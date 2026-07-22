import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ReviewerAccountsPanel, type ReviewerRow } from "@/components/admin/ReviewerAccountsPanel";

// 심사 계정 관리 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminReviewersPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const admin = createAdminClient();
  const { data } = await admin
    .from("reviewer_accounts")
    .select("user_id, email, active, note, created_at")
    .order("created_at", { ascending: true });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-8">
      <div>
        <h1 className="text-xl font-bold">PG 심사·테스트 계정</h1>
        <p className="mt-1 text-sm text-zinc-500">
          ID/PW 로 로그인하는 심사 전용 계정이에요. <code>/login?reviewer=1</code> 로 진입하며,
          결제는 항상 <b>테스트 채널</b>(실청구 없음, 주문에 TEST 표시)로 나가요. 구글·카카오로
          가입한 심사관은 콘텐츠 콘솔의 성장 레버 → &lsquo;PG 심사용 계정 이메일&rsquo;에
          등록하세요(같은 효력).
        </p>
      </div>
      <ReviewerAccountsPanel initialRows={(data ?? []) as ReviewerRow[]} />
    </main>
  );
}
