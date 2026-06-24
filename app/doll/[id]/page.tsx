import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVICE_NAME } from "@/lib/policy";
import { dollDepartment, dollRank, dollTrait, reportNo } from "@/lib/report";
import { asRole } from "@/lib/roles";
import { getRoleConfig } from "@/lib/config/getters";
import { roleFrom } from "@/lib/config/domains/roles";

type DollRow = {
  id: string;
  image_url: string;
  created_at: string;
  role: string | null;
  profiles: { display_name: string } | null;
};

async function fetchDoll(id: string): Promise<DollRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dolls")
    .select("id, image_url, created_at, role, profiles(display_name)")
    .eq("id", id)
    .single();
  return (data as unknown as DollRow) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const doll = await fetchDoll(id);
  if (!doll) return { title: SERVICE_NAME };
  const name = doll.profiles?.display_name ?? "익명";
  const role = asRole(doll.role);
  const cfg = await getRoleConfig();
  const rc = roleFrom(role, cfg);
  const title = `[인사기록] ${name}님의 ${rc.label}`;
  const description = `특이사항: ${dollTrait(doll.id, role, cfg)} — ${rc.ctaSafe}`;
  const ogUrl = `${PUBLIC_ENV.SITE_URL}/doll/${id}/opengraph-image`;
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

export default async function DollPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doll = await fetchDoll(id);
  if (!doll) notFound();

  const name = doll.profiles?.display_name ?? "익명";
  const role = asRole(doll.role);
  const cfg = await getRoleConfig();
  const rc = roleFrom(role, cfg);
  const rlabel = rc.label;
  const trait = dollTrait(doll.id, role, cfg);
  const joined = new Date(doll.created_at);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* ── 인사기록카드 (종이) ─────────────────────────── */}
        <div className="rounded-lg bg-[#fbfaf6] p-5 text-zinc-900 shadow-2xl">
          <div className="border-b-2 border-zinc-800 pb-3 text-center">
            <p className="text-[10px] tracking-[0.3em] text-zinc-500">
              {reportNo(doll.id, doll.created_at)}
            </p>
            <h1 className="mt-1 text-xl font-extrabold tracking-tight">
              인사기록카드
            </h1>
          </div>

          <div className="mt-4 flex gap-4">
            {/* 증명사진란 */}
            <div className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={doll.image_url}
                alt={`${rlabel} 증명사진`}
                className="aspect-[3/4] w-28 rounded-md border-2 border-zinc-400 bg-zinc-100 object-contain"
              />
              <p className="mt-1 text-center text-[10px] text-zinc-400">
                (증명사진)
              </p>
            </div>

            <dl className="flex-1 space-y-2 text-sm">
              <CardRow label="성명">{rlabel}</CardRow>
              <CardRow label="직급">{dollRank(doll.id, role, cfg)}</CardRow>
              <CardRow label="소속">{dollDepartment(doll.id, role, cfg)}</CardRow>
              <CardRow label="제작자">{name}</CardRow>
              <CardRow label="등록일">
                {joined.getFullYear()}.
                {String(joined.getMonth() + 1).padStart(2, "0")}.
                {String(joined.getDate()).padStart(2, "0")}
              </CardRow>
            </dl>
          </div>

          <div className="mt-4 rounded-md border border-dashed border-zinc-400 bg-zinc-50 p-3">
            <p className="text-[10px] font-semibold text-zinc-500">특이사항</p>
            <p className="mt-0.5 text-sm font-medium">&ldquo;{trait}&rdquo;</p>
          </div>

          <div className="mt-3 flex justify-end">
            <span className="inline-block -rotate-12 rounded-full border-2 border-red-500 px-2 py-1.5 text-[10px] font-bold text-red-500">
              관리대상
            </span>
          </div>
        </div>

        {/* ── 후킹 CTA ───────────────────────────────────── */}
        <div className="mt-6 text-center">
          <p className="text-sm text-zinc-400">{rc.ctaSafe}</p>
          <div className="mt-3 flex flex-col gap-2.5">
            <Link
              href="/generate"
              className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-background transition hover:opacity-90"
            >
              나도 우리 {rlabel} 만들기
            </Link>
            <Link
              href="/play"
              className="rounded-full border border-foreground/15 px-6 py-3.5 text-sm font-medium transition hover:bg-foreground/5"
            >
              기본 부장님으로 바로 풀기
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

function CardRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-zinc-200 pb-1.5">
      <dt className="w-12 shrink-0 text-xs font-semibold text-zinc-500">
        {label}
      </dt>
      <dd className="flex-1">{children}</dd>
    </div>
  );
}
