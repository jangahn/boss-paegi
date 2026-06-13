import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVICE_NAME } from "@/lib/policy";
import {
  bossReaction,
  formatDuration,
  gradeFor,
  ogDescription,
  reportNo,
  weaponLabel,
} from "@/lib/report";

type Score = {
  id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  max_combo: number | null;
  created_at: string;
  profiles: { display_name: string } | null;
  dolls: { image_url: string | null } | null;
};

async function fetchScore(scoreId: string): Promise<Score | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("scores")
    .select(
      "id, score, weapon, duration_ms, max_combo, created_at, profiles(display_name), dolls(image_url)"
    )
    .eq("id", scoreId)
    .single();
  if (data) return data as unknown as Score;
  // migration 0003 미적용 fallback
  const { data: legacy } = await admin
    .from("scores")
    .select(
      "id, score, weapon, duration_ms, created_at, profiles(display_name), dolls(image_url)"
    )
    .eq("id", scoreId)
    .single();
  return legacy ? ({ ...legacy, max_combo: null } as unknown as Score) : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ scoreId: string }>;
}): Promise<Metadata> {
  const { scoreId } = await params;
  const score = await fetchScore(scoreId);
  if (!score) {
    return { title: SERVICE_NAME };
  }
  const name = score.profiles?.display_name ?? "익명";
  const grade = gradeFor(score.score);
  const title = `[결재완료] ${name} — ${score.score.toLocaleString()}점 (${grade.label})`;
  const description = ogDescription(score.score, score.id);
  const ogUrl = `${PUBLIC_ENV.SITE_URL}/share/${scoreId}/opengraph-image`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: ogUrl, width: 1200, height: 630 }],
      locale: "ko_KR",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogUrl],
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ scoreId: string }>;
}) {
  const { scoreId } = await params;
  const score = await fetchScore(scoreId);
  if (!score) notFound();

  const name = score.profiles?.display_name ?? "익명";
  const grade = gradeFor(score.score);
  const reaction = bossReaction(score.score, score.id);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* ── 보고서 (종이) ───────────────────────────────── */}
        <div className="rounded-lg bg-[#fbfaf6] p-5 text-zinc-900 shadow-2xl">
          <div className="border-b-2 border-zinc-800 pb-3 text-center">
            <p className="text-[10px] tracking-[0.3em] text-zinc-500">
              {reportNo(score.id, score.created_at)}
            </p>
            <h1 className="mt-1 text-xl font-extrabold tracking-tight">
              스트레스 해소 결과 보고서
            </h1>
          </div>

          <div className="mt-3 flex items-start justify-between gap-3">
            {/* 커스텀 인형 없으면 기본 부장님 이미지 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={score.dolls?.image_url ?? "/sprites/boss-default.png"}
              alt="맞은 부장님"
              className="aspect-square w-24 rounded-xl border border-zinc-300 bg-zinc-100 object-contain"
            />
            <table className="border-collapse text-center text-[10px]">
              <tbody>
                <tr>
                  <td className="w-16 border border-zinc-400 bg-zinc-100 py-0.5">
                    작성자
                  </td>
                  <td className="w-16 border border-zinc-400 py-0.5">결재</td>
                </tr>
                <tr>
                  <td className="border border-zinc-400 px-1 py-2 text-[11px] font-medium">
                    {name}
                  </td>
                  <td className="border border-zinc-400 py-2">
                    <span className="inline-block -rotate-12 rounded-full border-2 border-red-500 px-1.5 py-1 text-[9px] font-bold text-red-500">
                      해소완료
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <dl className="mt-3 space-y-1.5 text-sm">
            <Row label="총 정산 점수">
              <span className="text-2xl font-extrabold tabular-nums">
                {score.score.toLocaleString()}
              </span>
              <span className="ml-1 text-xs text-zinc-500">점</span>
            </Row>
            {score.max_combo !== null && score.max_combo > 0 && (
              <Row label="최대 콤보">x{score.max_combo}</Row>
            )}
            <Row label="주력 무기">{weaponLabel(score.weapon)}</Row>
            <Row label="소요 시간">{formatDuration(score.duration_ms)}</Row>
            <Row label="판정 등급">
              <span className="font-bold">{grade.label}</span>
              <span className="ml-1.5 text-xs text-zinc-500">
                {grade.comment}
              </span>
            </Row>
          </dl>

          <div className="mt-4 rounded-md border border-dashed border-zinc-400 bg-zinc-50 p-3">
            <p className="text-[10px] font-semibold text-zinc-500">
              피격자(부장님) 의견
            </p>
            <p className="mt-0.5 text-sm font-medium">&ldquo;{reaction}&rdquo;</p>
          </div>
        </div>

        {/* ── 후킹 CTA ───────────────────────────────────── */}
        <div className="mt-6 text-center">
          <p className="text-sm text-zinc-400">
            당신의 부장님은 무사하십니까?
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            <Link
              href="/generate"
              className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-background transition hover:opacity-90"
            >
              우리 부장님도 패러 가기
            </Link>
            <Link
              href="/play"
              className="rounded-full border border-foreground/15 px-6 py-3.5 text-sm font-medium transition hover:bg-foreground/5"
            >
              기본 부장님으로 바로 풀기
            </Link>
            <Link
              href="/leaderboard"
              className="pt-1 text-sm text-zinc-500 underline-offset-4 hover:underline"
            >
              이 점수, 랭킹 몇 등인지 보기 →
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-200 pb-1.5">
      <dt className="shrink-0 text-xs font-semibold text-zinc-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
