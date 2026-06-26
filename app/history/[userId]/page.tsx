import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AppNav } from "@/components/AppNav";
import { FadeImg } from "@/components/FadeImg";
import { Pagination } from "@/components/Pagination";
import { PaperPanel } from "@/components/dossier";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDuration, gradeFor, timeAgo, weaponLabel } from "@/lib/report";
import { getScoreConfig } from "@/lib/config/getters";

const DEFAULT_AVATAR = "/avatars/default.png";
const PAGE_SIZE = 10;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  max_combo: number | null;
  created_at: string;
};

async function fetchProfile(userId: string) {
  if (!UUID_RE.test(userId)) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("display_name, avatar_url")
    .eq("id", userId)
    .maybeSingle();
  return data as { display_name: string | null; avatar_url: string | null } | null;
}

async function fetchGames(userId: string, page: number) {
  const admin = createAdminClient();
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const { data, count } = await admin
    .from("scores")
    .select("id, score, weapon, duration_ms, max_combo, created_at", {
      count: "exact",
    })
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .range(from, to);
  return { rows: (data ?? []) as Row[], total: count ?? 0 };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ userId: string }>;
}): Promise<Metadata> {
  const { userId } = await params;
  const profile = await fetchProfile(userId);
  const name = profile?.display_name ?? "익명";
  return { title: `${name}님의 기록` };
}

export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { userId } = await params;
  const sp = await searchParams;

  const profile = await fetchProfile(userId);
  if (!profile) notFound();

  const page = Math.max(1, Number(sp.page) || 1);
  const { rows, total } = await fetchGames(userId, page);
  const scoreGrades = (await getScoreConfig()).grades;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const name = profile.display_name ?? "익명";

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <PaperPanel className="flex items-center gap-3 px-5 py-4">
            <FadeImg
              src={profile.avatar_url ?? DEFAULT_AVATAR}
              className="h-11 w-11 shrink-0 rounded-full border border-line"
              loading="eager"
              fallbackSrc={DEFAULT_AVATAR}
            />
            <div className="min-w-0">
              <h1 className="truncate font-display text-3xl tracking-tight text-ink">{name}님의 기록</h1>
              <p className="text-sm text-steel">총 {total.toLocaleString()}게임</p>
            </div>
          </PaperPanel>

          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-12 text-center text-steel">
              {page > 1
                ? "이 페이지에는 기록이 없어요."
                : "아직 게임 기록이 없어요."}
            </p>
          ) : (
            <ol className="space-y-2">
              {rows.map((g) => (
                <li key={g.id}>
                  <Link
                    href={`/history/${userId}/${g.id}`}
                    className="flex items-center gap-4 rounded-lg border border-line bg-paper-2 p-3 transition hover:bg-paper-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-ink">{gradeFor(g.score, scoreGrades).label}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-steel">
                        <span>{weaponLabel(g.weapon)}</span>
                        {g.max_combo !== null && g.max_combo > 0 && (
                          <span>· 콤보 x{g.max_combo}</span>
                        )}
                        <span>· {formatDuration(g.duration_ms)}</span>
                        <span>· {timeAgo(g.created_at)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-display text-2xl tabular-nums text-gold">
                        {g.score.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-steel">점</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          )}

          <Pagination
            page={page}
            totalPages={totalPages}
            hrefFor={(p) => `/history/${userId}?page=${p}`}
          />
        </div>
      </main>
    </>
  );
}
