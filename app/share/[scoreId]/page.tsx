import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVICE_NAME } from "@/lib/policy";

type Score = {
  id: string;
  score: number;
  weapon: string;
  created_at: string;
  profiles: { display_name: string } | null;
  dolls: { image_url: string | null } | null;
};

async function fetchScore(scoreId: string): Promise<Score | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("scores")
    .select("id, score, weapon, created_at, profiles(display_name), dolls(image_url)")
    .eq("id", scoreId)
    .single();
  return (data as unknown as Score) ?? null;
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
  const title = `${name}님이 ${score.score.toLocaleString()}점 패고 옴`;
  const ogUrl = `${PUBLIC_ENV.SITE_URL}/share/${scoreId}/opengraph-image`;
  return {
    title,
    description: `${SERVICE_NAME} — 직장인 스트레스 해소 게임`,
    openGraph: {
      title,
      description: SERVICE_NAME,
      images: [{ url: ogUrl, width: 1200, height: 630 }],
      locale: "ko_KR",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: SERVICE_NAME,
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

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex max-w-md flex-col items-center gap-6">
        {score.dolls?.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={score.dolls.image_url}
            alt=""
            className="aspect-square w-48 rounded-3xl object-cover shadow-lg"
          />
        )}
        <div>
          <p className="text-sm text-zinc-500">{name} 님이</p>
          <p className="my-2 text-5xl font-extrabold tabular-nums">
            {score.score.toLocaleString()}
          </p>
          <p className="text-sm text-zinc-500">점 패고 가셨어요</p>
        </div>

        <div className="flex w-full flex-col gap-3 pt-4">
          <Link
            href="/generate"
            className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-background"
          >
            나도 내 부장님 만들기
          </Link>
          <Link
            href="/play"
            className="rounded-full border border-foreground/15 px-6 py-4 text-base font-medium"
          >
            기본 부장님으로 시작
          </Link>
        </div>
      </div>
    </main>
  );
}
