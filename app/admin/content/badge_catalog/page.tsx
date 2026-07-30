import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getBadgeCatalogWithMeta } from "@/lib/config/getters";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { requireSupabaseRows } from "@/lib/supabase-operation";
import { BadgeCatalogEditor } from "@/components/admin/content/BadgeCatalogEditor";

export const dynamic = "force-dynamic";

export default async function BadgeCatalogPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect(gate.error === "consent_required" ? "/consent?next=/admin" : "/");

  const { value, version, source, invalid } = await getBadgeCatalogWithMeta();

  // slug 별 과거 획득 영향도. Raw rows를 읽으면 PostgREST max-rows에서
  // 조용히 잘려 운영자가 "영향 0건"으로 오판할 수 있으므로 DB 전체 집계만
  // 사용한다. 오류/손상 success는 throw해 위험한 편집기를 렌더하지 않는다.
  const admin = createAdminClient();
  const impactRowsUnknown = await requireSupabaseRows(
    "admin.badge_catalog.impact",
    () => admin.rpc("get_admin_badge_impact"),
  );
  const impactRows = validateAdminRows<{
    badge_id: string;
    users: number;
    scores: number;
  }>("admin.badge_catalog.impact", impactRowsUnknown, {
    badge_id: "string",
    users: "nonnegativeInteger",
    scores: "nonnegativeInteger",
  });
  const impact: Record<string, { users: number; scores: number }> = {};
  for (const row of impactRows) {
    impact[row.badge_id] = {
      users: row.users,
      scores: row.scores,
    };
  }
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/badge_catalog" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">뱃지</h1>
        <p className="mt-1 text-sm text-zinc-500">
          카테고리(7종 고정)별 이름·이모지와 뱃지 임계값·개수·라벨을 편집해요. 비활성화하면 신규 획득에서 빠지지만
          이미 받은 사람의 뱃지는 보존됩니다. (달성 기준 자체는 코드 — 임계값만 조정.)
        </p>
        <BadgeCatalogEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
          impact={impact}
        />
      </div>
    </main>
  );
}
