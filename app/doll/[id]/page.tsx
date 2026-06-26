import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { FadeImg } from "@/components/FadeImg";
import { signedDollUrl } from "@/lib/storage";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVICE_NAME } from "@/lib/policy";
import { dollDepartment, dollRank, dollTrait, reportNo } from "@/lib/report";
import { asRole } from "@/lib/roles";
import { getRoleConfig, getMarketingCopy } from "@/lib/config/getters";
import { roleFrom } from "@/lib/config/domains/roles";
import { resolveCopy } from "@/lib/config/template";
import { ReportButton } from "@/components/ReportButton";
import { PaperPanel, Paperclip, RubberStamp } from "@/components/dossier";

const DEFAULT_BOSS = "/sprites/boss-default.png";

// signed URL(TTL 600) 박히는 페이지 — ISR ≤60s 로 만료 URL/삭제(takedown) staleness 최소화.
//   takedown/restore/permanent 라우트가 이 path 를 명시 revalidatePath(즉시 반영).
export const revalidate = 60;

type DollRow = {
  id: string;
  image_url: string;
  created_at: string;
  role: string | null;
  deleted_at: string | null;
  profiles: { display_name: string } | null;
};

async function fetchDoll(id: string): Promise<DollRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dolls")
    .select("id, image_url, created_at, role, deleted_at, profiles(display_name)")
    .eq("id", id)
    .single();
  if (!data) return null;
  // image_url=경로(raw) 유지. 서명/삭제 분기는 렌더에서(deleted→기본보스, 아니면 signedDollUrl).
  // invisible takedown(0034): 삭제 인형도 404 안 하고 캐릭터 영역만 기본 부장님으로 대체.
  return data as unknown as DollRow;
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
  const mk = await getMarketingCopy();
  const title = resolveCopy(mk.share.dollOgTitle, rc.label, { 제작자: name });
  const description = resolveCopy(mk.share.dollOgDesc, rc.label, {
    특이사항: dollTrait(doll.id, role, cfg),
  });
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
  const mk = await getMarketingCopy();
  const rlabel = rc.label;
  const trait = dollTrait(doll.id, role, cfg);
  const joined = new Date(doll.created_at);
  // 삭제(takedown)면 기본 부장님(public sprite, 서명 X), 아니면 private 버킷 서명.
  const imgSrc = doll.deleted_at
    ? DEFAULT_BOSS
    : (await signedDollUrl(doll.image_url, 600, { thumb: true })) ?? DEFAULT_BOSS;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* ── 인사기록카드 (종이) ─────────────────────────── */}
        <PaperPanel folded className="relative px-5 pb-5 pt-8 text-ink">
          <Paperclip className="left-6" />
          <div className="border-b-2 border-line pb-3 text-center">
            <p className="text-[10px] tracking-[0.3em] text-steel">
              {reportNo(doll.id, doll.created_at)}
            </p>
            <h1 className="mt-1 font-bold text-2xl tracking-tight text-ink sm:text-3xl">
              인사기록카드
            </h1>
          </div>

          <div className="mt-4 flex gap-4">
            {/* 증명사진란 */}
            <div className="shrink-0">
              <FadeImg
                src={imgSrc}
                alt={`${rlabel} 증명사진`}
                className="aspect-[3/4] w-28 rounded-md border-2 border-line bg-paper-3"
                fit="contain"
                placeholder="pulse"
                fallbackSrc="/sprites/boss-default.png"
              />
              <p className="mt-1 text-center text-[10px] text-steel">
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

          <div className="mt-4 rounded-md border border-dashed border-line bg-paper-3/50 p-3">
            <p className="text-[10px] font-semibold text-steel">특이사항</p>
            <p className="mt-0.5 text-sm font-medium text-ink">&ldquo;{trait}&rdquo;</p>
          </div>

          <div className="mt-3 flex justify-end">
            <RubberStamp tone="stamp" className="text-[10px]">
              관리대상
            </RubberStamp>
          </div>
        </PaperPanel>

        {/* ── 후킹 CTA ───────────────────────────────────── */}
        <div className="mt-6 text-center">
          <p className="text-sm text-steel">{resolveCopy(mk.share.dollHook, rlabel)}</p>
          <div className="mt-3 flex flex-col gap-2.5">
            <Link
              href="/generate"
              className="rounded-lg bg-foreground px-6 py-4 text-base font-bold text-background transition hover:opacity-90"
            >
              {resolveCopy(mk.share.dollCtaMake, rlabel)}
            </Link>
            <Link
              href="/play"
              className="rounded-lg border-2 border-line px-6 py-3.5 text-sm font-semibold text-ink transition hover:bg-paper-3/60"
            >
              {mk.share.dollCtaDefault}
            </Link>
          </div>
        </div>

        <div className="mt-5 text-center">
          <ReportButton dollId={doll.id} />
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
    <div className="flex items-baseline gap-3 border-b border-line pb-1.5">
      <dt className="w-12 shrink-0 text-xs font-semibold text-steel">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-ink">{children}</dd>
    </div>
  );
}
