import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ReviewerAccountsPanel,
  type ReviewerJobRow,
  type ReviewerRow,
} from "@/components/admin/ReviewerAccountsPanel";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  readSupabaseRowsPaginated,
  requireSupabaseRows,
  SupabaseOperationError,
} from "@/lib/supabase-operation";

// 심사 계정 관리 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminReviewersPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const admin = createAdminClient();
  const [rowsUnknown, jobsUnknown] = await Promise.all([
    readSupabaseRowsPaginated<unknown>(
      "admin.reviewers_page",
      (offset, limit) =>
        admin
          .from("reviewer_accounts")
          .select(
            "user_id, email, active, auth_sync_pending, note, created_at",
          )
          .order("created_at", { ascending: true })
          .order("user_id", { ascending: true })
          .range(offset, offset + limit - 1),
    ),
    requireSupabaseRows<unknown>(
      "admin.reviewer_jobs_page",
      () =>
        admin.rpc("admin_list_reviewer_jobs", {
          p_admin_id: gate.user.id,
          p_limit: 50,
      }),
    ),
  ]);
  const data = validateAdminRows<ReviewerRow>(
    "admin.reviewers_page",
    rowsUnknown,
    {
      user_id: "uuid",
      email: "string",
      active: "boolean",
      auth_sync_pending: "boolean",
      note: "nullableText",
      created_at: "timestamp",
    },
  );
  const jobs = validateAdminRows<ReviewerJobRow>(
    "admin.reviewer_jobs_page",
    jobsUnknown,
    {
      job_id: "uuid",
      action: "string",
      status: "string",
      user_id: "nullableUuid",
      email: "string",
      desired_active: "nullableBoolean",
      attempt_count: "nonnegativeInteger",
      last_error: "nullableText",
      created_at: "timestamp",
      updated_at: "timestamp",
    },
  );
  const actions = new Set(["provision", "set_active", "reset_password", "delete"]);
  const statuses = new Set(["pending", "leased", "failed"]);
  if (
    jobs.some(
      (job) => !actions.has(job.action) || !statuses.has(job.status),
    )
  ) {
    throw new SupabaseOperationError(
      "admin.reviewer_jobs_page",
      new Error("invalid reviewer job enum"),
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-8">
      <div>
        <h1 className="text-xl font-bold">PG 심사·테스트 계정</h1>
        <p className="mt-1 text-sm text-zinc-500">
          ID/PW 로 로그인하는 심사 전용 계정이에요. <code>/login?reviewer=1</code> 로 진입하며,
          결제는 항상 <b>테스트 채널</b>(실청구 없음, 주문에 TEST 표시)로 나가요. 구글·카카오로
          가입한 심사관은 콘텐츠 콘솔의 성장 레버 → &lsquo;테스트 결제 계정 이메일&rsquo;에
          등록하세요(같은 효력).
        </p>
      </div>
      <ReviewerAccountsPanel initialRows={data} initialJobs={jobs} />
    </main>
  );
}
