"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { FadeImg } from "@/components/FadeImg";
import { PaperPanel } from "@/components/dossier";
import { timeAgo } from "@/lib/report";

type Period = "daily" | "weekly" | "monthly";

type RankRow = {
  id: string;
  owner_id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
};

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 랭킹 — 클라 컴포넌트. 진입 즉시 셸+스켈레톤(서버 await 차단 없음), 오늘/이번주는 클라 상태(풀네비 X).
 * 데이터는 캐시된 public API(/api/leaderboard, Vercel Edge 30s)에서 로드 → 서울 PoP 서빙.
 */
export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("daily");
  const [rows, setRows] = useState<RankRow[] | null>(null); // null = 로딩(스켈레톤)

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetch(`/api/leaderboard?period=${period}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setRows((d?.rows ?? []) as RankRow[]);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="font-bold text-3xl tracking-tight text-ink sm:text-4xl">랭킹</h1>
            <Link
              href="/play"
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background"
            >
              패러 가기
            </Link>
          </div>

          <div className="flex gap-2 rounded-lg border border-line bg-paper-2 p-1 text-sm">
            <Tab active={period === "daily"} onClick={() => setPeriod("daily")}>
              오늘
            </Tab>
            <Tab active={period === "weekly"} onClick={() => setPeriod("weekly")}>
              이번 주
            </Tab>
            <Tab active={period === "monthly"} onClick={() => setPeriod("monthly")}>
              이번 달
            </Tab>
          </div>

          {rows === null ? (
            <RankSkeleton />
          ) : rows.length === 0 ? (
            <PaperPanel className="p-12 text-center text-zinc-500">
              아직 등록된 점수가 없어요. 첫 1등의 기회.
            </PaperPanel>
          ) : (
            <PaperPanel className="px-2 py-1">
              <ol className="divide-y divide-line">
                {rows.map((r, i) => (
                  <li key={r.id}>
                    <Link
                      href={`/history/${r.owner_id}`}
                      className="flex items-center gap-4 rounded-lg px-3 py-3 transition hover:bg-paper-2"
                    >
                      <span
                        className={`w-8 text-center font-bold text-xl ${rankColor(i)}`}
                      >
                        {i + 1}
                      </span>
                      <FadeImg
                        src={r.avatar_url ?? DEFAULT_AVATAR}
                        className="h-9 w-9 shrink-0 rounded-full border border-line"
                        fallbackSrc={DEFAULT_AVATAR}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium text-ink">
                          {r.display_name ?? "익명"}
                        </div>
                        <div className="text-xs text-zinc-500">{timeAgo(r.created_at)}</div>
                      </div>
                      <div
                        className={`font-bold text-2xl tabular-nums ${
                          i === 0 ? "text-gold" : "text-ink"
                        }`}
                      >
                        {r.score.toLocaleString()}
                      </div>
                    </Link>
                  </li>
                ))}
              </ol>
            </PaperPanel>
          )}
        </div>
      </main>
    </>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md py-2 text-center font-semibold transition ${
        active ? "bg-foreground text-background" : "text-zinc-500 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function RankSkeleton() {
  return (
    <PaperPanel className="px-2 py-1">
      <ol className="divide-y divide-line">
        {Array.from({ length: 8 }).map((_, i) => (
          <li key={i} className="flex items-center gap-4 px-3 py-3">
            <span className="w-8 text-center font-bold text-xl text-zinc-600">
              {i + 1}
            </span>
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-foreground/10" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="h-3.5 w-24 animate-pulse rounded bg-foreground/10" />
              <div className="h-2.5 w-12 animate-pulse rounded bg-foreground/10" />
            </div>
            <div className="h-5 w-14 animate-pulse rounded bg-foreground/10" />
          </li>
        ))}
      </ol>
    </PaperPanel>
  );
}

function rankColor(i: number) {
  if (i === 0) return "text-gold";
  if (i === 1) return "text-steel";
  if (i === 2) return "text-stamp";
  return "text-zinc-500";
}
