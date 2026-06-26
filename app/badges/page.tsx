"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import { AppNav } from "@/components/AppNav";
import {
  familyGroups,
  activeBadges,
  type CatalogBadge,
} from "@/lib/config/domains/badges";
import { useBadgeCatalog } from "@/components/BadgeCatalogProvider";

/**
 * 뱃지 수집 페이지 — 프로필 메뉴("내 뱃지")에서 진입. 익명/회원 공통(self-RLS).
 * 패밀리별 섹션: 획득=이모지+임계라벨, 미획득=🔒/"?"(조건 숨김). 상단 N/총·섹션 k/n.
 */
export default function BadgesPage() {
  const [owned, setOwned] = useState<Set<string> | null>(null);
  const catalog = useBadgeCatalog();
  const families = familyGroups(catalog);
  const total = activeBadges(catalog).length;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureAuth();
        const sb = createClient();
        // self-RLS: 본인 owner_id 행만 반환. 구 badge_id 고아는 BADGE_FAMILIES 에 없어 자동 미표시.
        const { data } = await sb.from("user_badges").select("badge_id");
        if (!cancelled)
          setOwned(new Set((data ?? []).map((r) => r.badge_id as string)));
      } catch {
        if (!cancelled) setOwned(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const collected = owned
    ? families.reduce(
        (n, f) => n + f.badges.filter((d) => owned.has(d.slug)).length,
        0
      )
    : 0;

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className="flex items-end justify-between gap-3">
            <h1 className="text-2xl font-bold">내 뱃지</h1>
            {owned && (
              <p className="text-sm text-zinc-500">
                <span className="text-lg font-extrabold text-foreground tabular-nums">
                  {collected}
                </span>{" "}
                / {total} 수집
              </p>
            )}
          </div>

          {owned === null ? (
            <BadgeSkeleton />
          ) : (
            families.map((f) => (
              <FamilySection key={f.key} family={f} owned={owned} />
            ))
          )}
        </div>
      </main>
    </>
  );
}

function FamilySection({
  family,
  owned,
}: {
  family: { key: string; name: string; emoji: string; badges: CatalogBadge[] };
  owned: Set<string>;
}) {
  const got = family.badges.filter((d) => owned.has(d.slug)).length;
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-lg">{family.emoji}</span>
        <h2 className="text-sm font-bold">{family.name}</h2>
        <span className="text-xs text-zinc-500 tabular-nums">
          {got}/{family.badges.length}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {family.badges.map((d) =>
          owned.has(d.slug) ? (
            <div
              key={d.slug}
              title={d.desc}
              className="flex flex-col items-center gap-1 rounded-xl border border-foreground/10 bg-foreground/5 p-2 text-center"
            >
              <span className="text-xl">{family.emoji}</span>
              <span className="text-[10px] font-semibold leading-tight">
                {d.label}
              </span>
            </div>
          ) : (
            <div
              key={d.slug}
              className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-foreground/15 p-2 text-center"
            >
              <span className="text-xl opacity-40">🔒</span>
              <span className="text-[10px] font-bold text-zinc-500">?</span>
            </div>
          )
        )}
      </div>
    </section>
  );
}

function BadgeSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-4 w-20 animate-pulse rounded bg-foreground/10" />
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, j) => (
              <div
                key={j}
                className="aspect-square animate-pulse rounded-xl bg-foreground/10"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
