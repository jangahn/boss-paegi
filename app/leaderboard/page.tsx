import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";

type Period = "daily" | "weekly";

type RankRow = {
  id: string;
  owner_id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  created_at: string;
  display_name: string | null;
  doll_image_url: string | null;
};

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  const period: Period = sp.period === "weekly" ? "weekly" : "daily";

  const supabase = await createClient();
  // RPC: 사용자별 최고점 1개씩만, score desc, 일간/주간 모두 최대 10명
  const { data } = await supabase.rpc("get_leaderboard", {
    period,
    max_limit: 10,
  });
  const rows = (data ?? []) as RankRow[];

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">랭킹</h1>
          <Link
            href="/play"
            className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background"
          >
            패러 가기
          </Link>
        </div>

        <div className="flex gap-2 rounded-full bg-foreground/5 p-1 text-sm">
          <TabLink active={period === "daily"} href="/leaderboard?period=daily">
            오늘
          </TabLink>
          <TabLink active={period === "weekly"} href="/leaderboard?period=weekly">
            이번 주
          </TabLink>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            아직 등록된 점수가 없어요. 첫 1등의 기회.
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li
                key={r.id}
                className="flex items-center gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-3"
              >
                <span className={`w-8 text-center text-lg font-bold ${rankColor(i)}`}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">
                    {r.display_name ?? "익명"}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {timeAgo(r.created_at)}
                  </div>
                </div>
                <div className="text-xl font-extrabold tabular-nums">
                  {r.score.toLocaleString()}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      </main>
    </>
  );
}

function TabLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`flex-1 rounded-full py-2 text-center transition ${
        active ? "bg-foreground text-background" : "text-zinc-500 hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

function rankColor(i: number) {
  if (i === 0) return "text-amber-400";
  if (i === 1) return "text-zinc-300";
  if (i === 2) return "text-orange-400";
  return "text-zinc-500";
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}
