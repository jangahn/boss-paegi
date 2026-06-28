import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { HighlightPlayer } from "@/components/HighlightPlayer";
import { FadeImg } from "@/components/FadeImg";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVICE_NAME } from "@/lib/policy";
import {
  bossReaction,
  formatDuration,
  gradeFor,
  reportNo,
  weaponLabel,
} from "@/lib/report";
import { matchPersona } from "@/lib/persona";
import { PersonaCard } from "@/components/PersonaCard";
import { BadgeStrip } from "@/components/BadgeStrip";
import {
  fetchScoreDetail,
  clipSignedUrl,
  highlightDelta,
} from "@/lib/score-detail";
import { signedDollUrl } from "@/lib/storage";
import { asRole } from "@/lib/roles";
import { getRoleConfig, getScoreConfig, getBadgeCatalog, getMarketingCopy } from "@/lib/config/getters";
import { roleFrom } from "@/lib/config/domains/roles";
import { resolveCopy } from "@/lib/config/template";
import { ReportButton } from "@/components/ReportButton";

// signed doll/clip URL(TTL 600/900) 박히는 페이지 — ISR ≤60s 로 만료/삭제(takedown) staleness 최소화.
//   takedown/restore/permanent 라우트가 이 doll 을 쓰는 share path 들을 명시 revalidatePath(즉시).
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ scoreId: string }>;
}): Promise<Metadata> {
  const { scoreId } = await params;
  const score = await fetchScoreDetail(scoreId);
  if (!score) {
    return { title: SERVICE_NAME };
  }
  const name = score.profiles?.display_name ?? "익명";
  const role = asRole(score.dolls?.role);
  const [cfg, scoreCfg, mk] = await Promise.all([
    getRoleConfig(),
    getScoreConfig(),
    getMarketingCopy(),
  ]);
  const grade = gradeFor(score.score, scoreCfg.grades);
  const title = resolveCopy(mk.share.scoreOgTitle, roleFrom(role, cfg).label, {
    제작자: name,
    점수: score.score.toLocaleString(),
    등급: grade.label,
  });
  const description = resolveCopy(mk.share.scoreOgDesc, roleFrom(role, cfg).label, {
    점수: score.score.toLocaleString(),
    상위: score.percentile ?? "",
    등급: grade.label,
  });
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
  const score = await fetchScoreDetail(scoreId);
  if (!score) notFound();

  const name = score.profiles?.display_name ?? "익명";
  const role = asRole(score.dolls?.role);
  const [cfg, scoreCfg, badgeCatalog, mk] = await Promise.all([
    getRoleConfig(),
    getScoreConfig(),
    getBadgeCatalog(),
    getMarketingCopy(),
  ]);
  const rlabel = roleFrom(role, cfg).label;
  const grade = gradeFor(score.score, scoreCfg.grades);
  const reaction = bossReaction(score.score, score.id, role, cfg);
  const persona = score.gameplay_stats ? matchPersona(score.gameplay_stats) : null;
  const clipUrl = await clipSignedUrl(score);
  const dollImg = await signedDollUrl(score.dolls?.image_url, 600, { thumb: true }); // 384px 썸네일(삭제/없음=null→기본보스)
  const posterUrl = `${PUBLIC_ENV.SITE_URL}/share/${scoreId}/opengraph-image`;
  const hlDelta = highlightDelta(score); // clip 있으면 clip delta, card-only 면 card delta (만료/삭제 X)

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* ── 하이라이트 영상(클립 있을 때) / 카드-only 배지(클립 없을 때) ── */}
        {clipUrl ? (
          <HighlightPlayer
            clipUrl={clipUrl}
            posterUrl={posterUrl}
            shareUrl={`${PUBLIC_ENV.SITE_URL}/share/${scoreId}`}
            delta={hlDelta}
          />
        ) : hlDelta ? (
          <div className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm font-semibold text-red-300">
            🔥 점수 급상승 하이라이트 · +{hlDelta.toLocaleString()}점
          </div>
        ) : null}

        {/* ── 보고서 (종이) ───────────────────────────────── */}
        <div className="rounded-lg ui-surface p-5 text-zinc-900 shadow-2xl">
          <div className="border-b-2 border-zinc-800 pb-3 text-center">
            <p className="text-[10px] tracking-[0.3em] text-zinc-500">
              {reportNo(score.id, score.created_at)}
            </p>
            <h1 className="mt-1 text-xl font-extrabold tracking-tight">
              스트레스 해소 결과 보고서
            </h1>
          </div>

          {persona && (
            <div className="mt-3">
              <PersonaCard persona={persona} heading={`${name}님의 패기 유형`} />
            </div>
          )}

          <div className="mt-3 flex items-start justify-between gap-3">
            {/* 커스텀 캐릭터 없으면 기본 부장님 이미지 */}
            <FadeImg
              src={dollImg ?? "/sprites/boss-default.png"}
              alt={`맞은 ${rlabel}`}
              className="aspect-square w-24 rounded-xl border border-zinc-300 bg-zinc-100"
              fit="contain"
              placeholder="shimmer"
              fallbackSrc="/sprites/boss-default.png"
            />
            <table className="border-collapse text-center text-[10px]">
              <tbody>
                <tr>
                  <td className="w-16 border border-zinc-400 bg-zinc-100 py-0.5">
                    작성자
                  </td>
                  <td className="w-16 border border-zinc-400 bg-zinc-100 py-0.5">결재</td>
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
            {score.percentile != null && (
              <Row label="전체 상위">
                <span className="font-bold text-amber-600">
                  상위 {score.percentile}%
                </span>
              </Row>
            )}
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
              피격자({rlabel}) 의견
            </p>
            <p className="mt-0.5 text-sm font-medium">&ldquo;{reaction}&rdquo;</p>
          </div>

          {score.badge_ids && score.badge_ids.length > 0 && (
            <BadgeStrip badgeIds={score.badge_ids} catalog={badgeCatalog} />
          )}
        </div>

        {/* ── 후킹 CTA ───────────────────────────────────── */}
        <div className="mt-6 text-center">
          <p className="text-sm text-zinc-400">
            {resolveCopy(mk.share.scoreHook, rlabel)}
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            <Link
              href="/generate"
              className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-paper-2 transition hover:opacity-90"
            >
              {resolveCopy(mk.share.scoreCtaPlay, rlabel)}
            </Link>
            <Link
              href="/play"
              className="rounded-full border border-foreground/15 ui-surface px-6 py-3.5 text-sm font-medium transition hover:bg-foreground/5"
            >
              {resolveCopy(mk.share.scoreCtaPersona, rlabel)}
            </Link>
            <Link
              href="/leaderboard"
              className="pt-1 text-sm text-zinc-500 underline-offset-4 hover:underline"
            >
              {mk.share.scoreRankLink} →
            </Link>
          </div>
        </div>

        {score.dolls?.id && score.dolls.image_url && (
          <div className="mt-5 text-center">
            <ReportButton dollId={score.dolls.id} />
          </div>
        )}
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
