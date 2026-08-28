"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FadeImg } from "@/components/FadeImg";
import { EventBanner } from "@/components/events/EventBanner";
import { timeAgo } from "@/lib/report";
import {
  parseLeaderboardRows,
  type LeaderboardRow as RankRow,
} from "@/lib/leaderboard-response";
import { runBoundedClientJsonFetch } from "@/lib/client-mutation";

type Period = "daily" | "weekly" | "monthly";

const PERIODS: readonly Period[] = ["daily", "weekly", "monthly"];
const DEFAULT_PERIOD: Period = "monthly";

function parsePeriod(value: string | null): Period {
  return PERIODS.includes(value as Period) ? (value as Period) : DEFAULT_PERIOD;
}

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 랭킹 — 클라 컴포넌트. 진입 즉시 셸+스켈레톤(서버 await 차단 없음), 오늘/이번주는 클라 상태(풀네비 X).
 * 탭(period)은 URL 쿼리로도 유지 — /history 상세를 다녀온 뒤로가기 재마운트에서 선택이 복원된다.
 * 개인정보 scrub 직후에도 stale 공개행을 재노출하지 않도록 no-store public API를 매번 새로 조회한다.
 */
function LeaderboardPageInner() {
  const searchParams = useSearchParams();
  const [period, setPeriod] = useState<Period>(() =>
    parsePeriod(searchParams.get("period")),
  );
  const [rows, setRows] = useState<RankRow[] | null>(null); // null = 로딩(스켈레톤)
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // state 가 단일 소스, URL 은 복원용 기록 — replaceState 라 탭 전환이 히스토리를 쌓지 않는다.
  const selectPeriod = (next: Period) => {
    setPeriod(next);
    window.history.replaceState(
      null,
      "",
      next === DEFAULT_PERIOD ? "/leaderboard" : `/leaderboard?period=${next}`,
    );
  };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // period 변경 시 스켈레톤으로 리셋 후 재조회 — 의도적 로딩 상태 동기화.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(null);
    setLoadError(false);
    void runBoundedClientJsonFetch({
      input: `/api/leaderboard?period=${period}`,
      signal: controller.signal,
      deadlineMs: 12_000,
      attemptMs: 8_000,
    })
      .then((delivery) => {
        if (delivery.kind !== "confirmed") {
          throw new Error("leaderboard_response_unconfirmed");
        }
        const { response, body: rawBody } = delivery.value;
        const body = rawBody as {
          rows?: unknown;
        } | null;
        const parsed = response.ok
          ? parseLeaderboardRows(body?.rows)
          : null;
        if (!parsed) {
          throw new Error("leaderboard_unavailable");
        }
        return parsed;
      })
      .then((d) => {
        if (!cancelled) setRows(d);
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [period, retryToken]);

  return (
    <>
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold">랭킹</h1>
            <Link
              href="/play"
              className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-paper-2"
            >
              패러 가기
            </Link>
          </div>
          {/* 공지 배너 — 제목 아래(갤러리 '내 캐릭터들' 아래와 일관). */}
          <EventBanner surface="leaderboard" />

          <div className="flex gap-2 rounded-full bg-foreground/5 p-1 text-sm">
            <Tab active={period === "monthly"} onClick={() => selectPeriod("monthly")}>
              이번 달
            </Tab>
            <Tab active={period === "weekly"} onClick={() => selectPeriod("weekly")}>
              이번 주
            </Tab>
            <Tab active={period === "daily"} onClick={() => selectPeriod("daily")}>
              오늘
            </Tab>
          </div>

          {loadError ? (
            <div
              role="alert"
              className="rounded-2xl border border-red-500/30 bg-red-500/5 p-8 text-center"
            >
              <p className="text-sm text-red-500">
                랭킹을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
              </p>
              <button
                type="button"
                onClick={() => setRetryToken((value) => value + 1)}
                className="mt-3 rounded-full border border-red-500/30 px-4 py-2 text-sm font-semibold"
              >
                다시 불러오기
              </button>
            </div>
          ) : rows === null ? (
            <RankSkeleton />
          ) : rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
              아직 등록된 점수가 없어요. 첫 1등의 기회.
            </p>
          ) : (
            <ol className="space-y-2">
              {rows.map((r, i) => (
                <li key={r.id}>
                  <Link
                    href={`/history/${r.owner_id}`}
                    className="flex items-center gap-4 rounded-2xl border border-foreground/10 ui-surface p-3 transition hover:bg-foreground/10"
                  >
                    <span className={`w-8 text-center text-lg font-bold ${rankColor(i)}`}>
                      {i + 1}
                    </span>
                    <FadeImg
                      src={r.avatar_url ?? DEFAULT_AVATAR}
                      className="h-9 w-9 shrink-0 rounded-full border border-foreground/10"
                      fallbackSrc={DEFAULT_AVATAR}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">
                        {r.display_name ?? "익명"}
                      </div>
                      <div className="text-xs text-zinc-500">{timeAgo(r.created_at)}</div>
                    </div>
                    <div className="text-xl font-extrabold tabular-nums">
                      {r.score.toLocaleString()}
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
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
      aria-pressed={active}
      onClick={onClick}
      className={`flex-1 rounded-full py-2 text-center transition ${
        active ? "bg-foreground text-paper-2" : "text-zinc-500 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function RankSkeleton() {
  return (
    <ol className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-4 rounded-2xl border border-foreground/10 ui-surface p-3"
        >
          <span className="w-8 text-center text-lg font-bold text-zinc-600">{i + 1}</span>
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-foreground/10" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3.5 w-24 animate-pulse rounded bg-foreground/10" />
            <div className="h-2.5 w-12 animate-pulse rounded bg-foreground/10" />
          </div>
          <div className="h-5 w-14 animate-pulse rounded bg-foreground/10" />
        </li>
      ))}
    </ol>
  );
}

function rankColor(i: number) {
  if (i === 0) return "text-amber-400";
  if (i === 1) return "text-zinc-300";
  if (i === 2) return "text-orange-400";
  return "text-zinc-500";
}

// useSearchParams 는 Suspense 경계 필요 (Next 16).
export default function LeaderboardPage() {
  return (
    <Suspense fallback={<div className="flex flex-1" />}>
      <LeaderboardPageInner />
    </Suspense>
  );
}
