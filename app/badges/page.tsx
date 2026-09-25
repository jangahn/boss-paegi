"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import {
  familyGroups,
  activeBadges,
  nextCumulativeBadges,
  type BadgeFamilyKey,
  type CatalogBadge,
  type NextBadge,
} from "@/lib/config/domains/badges";
import { useBadgeCatalog } from "@/components/BadgeCatalogProvider";
import { resolveOwnedBadgeRead, resolvePlayTotalsRead } from "@/lib/badge-owned";
import type { PlayTotals } from "@/lib/play-totals";
import { playWiggle } from "@/lib/motion";
import { runBoundedClientOperation } from "@/lib/client-operation";
import { PAGE_LOADING_PROPS } from "@/lib/page-loading";

/**
 * 뱃지 수집 페이지 — 프로필 메뉴("내 뱃지")에서 진입. 익명/회원 공통(self-RLS).
 * 패밀리별 섹션: 획득=이모지+임계라벨, 미획득=🔒/"?"(조건 숨김). 상단 N/총·섹션 k/n.
 */
export default function BadgesPage() {
  const [owned, setOwned] = useState<Set<string> | null>(null);
  // 누적 합계(v1.65) — 누적 카테고리 머리의 「다음 단계까지」 막대. 못 읽으면 막대만 없다(보유 목록과 별개, 추정 금지).
  const [totals, setTotals] = useState<PlayTotals | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const catalog = useBadgeCatalog();
  const families = familyGroups(catalog);
  const total = activeBadges(catalog).length;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        await ensureAuth(controller.signal);
        // self-RLS: 본인 owner_id 행만 반환. 구 badge_id 고아는 BADGE_FAMILIES 에 없어 자동 미표시.
        const result = await runBoundedClientOperation(
          (signal) =>
            createClient()
              .from("user_badges")
              .select("badge_id")
              .abortSignal(signal),
          { signal: controller.signal },
        );
        const nextOwned = resolveOwnedBadgeRead(result);
        if (!cancelled) setOwned(nextOwned);
        try {
          const totalsResult = await runBoundedClientOperation(
            (signal) => createClient().rpc("get_my_play_totals").abortSignal(signal),
            { signal: controller.signal },
          );
          if (!cancelled) setTotals(resolvePlayTotalsRead(totalsResult));
        } catch {
          // 합계를 못 읽으면 다음 단계 막대만 뺀다.
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort(new Error("badges_page_disposed"));
    };
  }, [loadAttempt]);

  const collected = owned
    ? families.reduce(
        (n, f) => n + f.badges.filter((d) => owned.has(d.slug)).length,
        0
      )
    : 0;
  const nextByFamily = totals ? nextCumulativeBadges(catalog, totals) : null;

  return (
    <>
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

          {loadFailed ? (
            <div
              role="alert"
              className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm"
            >
              <p className="font-semibold text-red-500">
                보유 뱃지를 불러오지 못했어요.
              </p>
              <p className="mt-1 text-zinc-500">
                미보유로 처리하지 않았습니다. 연결 상태를 확인하고 다시 시도해 주세요.
              </p>
              <button
                type="button"
                onClick={() => {
                  setOwned(null);
                  setLoadFailed(false);
                  setLoadAttempt((value) => value + 1);
                }}
                className="mt-3 font-semibold text-sky-600 underline underline-offset-2"
              >
                다시 시도
              </button>
            </div>
          ) : owned === null ? (
            <BadgeSkeleton />
          ) : (
            families.map((f) => (
              <FamilySection
                key={f.key}
                family={f}
                owned={owned}
                next={nextByFamily?.get(f.key as BadgeFamilyKey) ?? null}
              />
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
  next,
}: {
  family: { key: string; name: string; emoji: string; badges: CatalogBadge[] };
  owned: Set<string>;
  /** 누적 카테고리의 다음 단계(v1.65) — 없으면(한 판 · 유형 카테고리, 다 받음, 합계 모름) 막대 없음 */
  next: NextBadge | null;
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
        {next && (
          <span className="ml-auto truncate text-[11px] text-zinc-500 tabular-nums">
            「{next.badge.label}」까지 <b>{next.remaining.toLocaleString()}</b>
            {next.unit}
          </span>
        )}
      </div>
      {next && (
        // 직전 단계부터 온 만큼 — 폭이 아니라 scale 로 채우고 처음 볼 때 0 에서 차오른다(motion-fill, 배치 불변).
        <div aria-hidden className="mb-2 h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="motion-fill h-full origin-left rounded-full bg-amber-400"
            style={{ scale: `${next.progress.toFixed(3)} 1` }}
          />
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {family.badges.map((d, i) =>
          owned.has(d.slug) ? (
            // 처음 볼 때 차례로 살짝 올라온다(v1.65, motion-rise — transform 만).
            <div
              key={d.slug}
              title={d.desc}
              style={{ "--i": i } as CSSProperties}
              className="motion-rise flex flex-col items-center gap-1 rounded-xl border border-foreground/10 ui-surface p-2 text-center"
            >
              <span className="text-xl">{family.emoji}</span>
              <span className="text-[10px] font-semibold leading-tight">
                {d.label}
              </span>
            </div>
          ) : (
            // 잠긴 뱃지 — 누르면 자물쇠가 살짝 흔들린다(무엇인지는 알려 주지 않는다, v1.65).
            <div
              key={d.slug}
              onPointerDown={(e) => playWiggle(e.currentTarget.querySelector("[data-lock]"))}
              className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-foreground/15 p-2 text-center"
            >
              <span data-lock className="text-xl opacity-40">
                🔒
              </span>
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
    <div {...PAGE_LOADING_PROPS} className="flex flex-col gap-5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-4 w-20 animate-pulse rounded bg-foreground/10" />
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, j) => (
              <div
                key={j}
                className="aspect-square animate-pulse rounded-xl border border-foreground/10 ui-surface"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
