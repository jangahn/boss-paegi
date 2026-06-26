import Link from "next/link";
import { getBadgeCatalogWithMeta } from "@/lib/config/getters";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadgeCatalogEditor } from "@/components/admin/content/BadgeCatalogEditor";

export const dynamic = "force-dynamic";

export default async function BadgeCatalogPage() {
  const { value, version, source, invalid } = await getBadgeCatalogWithMeta();

  // slug 별 과거 획득 영향도(user_badges·score_stats) — 삭제/키변경 경고용. 어드민 전용·소량.
  const admin = createAdminClient();
  const [{ data: ub }, { data: ss }] = await Promise.all([
    admin.from("user_badges").select("badge_id"),
    admin.from("score_stats").select("badge_ids"),
  ]);
  const impact: Record<string, { users: number; scores: number }> = {};
  const bump = (slug: string, k: "users" | "scores") => {
    const cur = (impact[slug] ??= { users: 0, scores: 0 });
    cur[k] += 1;
  };
  for (const r of ub ?? []) if (r.badge_id) bump(r.badge_id as string, "users");
  for (const r of ss ?? [])
    for (const s of ((r.badge_ids as string[] | null) ?? [])) bump(s, "scores");
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
        <h1 className="mt-2 font-bold text-2xl sm:text-3xl">뱃지</h1>
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
