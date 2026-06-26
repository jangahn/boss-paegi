import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { HighlightPlayer } from "@/components/HighlightPlayer";
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
import { PaperPanel, Paperclip, RubberStamp, DashedDivider } from "@/components/dossier";

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
        <PaperPanel folded className="relative p-5 pt-7 text-zinc-900">
          <Paperclip className="left-6" />
          <div className="border-b-2 border-line pb-3 text-center">
            <p className="text-[10px] tracking-[0.3em] text-steel">
              {reportNo(score.id, score.created_at)}
            </p>
            <h1 className="mt-1 font-display text-2xl tracking-tight text-ink sm:text-3xl">
              스트레스 해소 결과 보고서
            </h1>
          </div>

          {persona && (
            <div className="mt-3">
              <PersonaCard persona={persona} heading={`${name}님의 패기 유형`} />
            </div>
          )}

          <div className="mt-3 flex items-start justify-between gap-3">
            {/* 커스텀 인형 없으면 기본 부장님 이미지 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={dollImg ?? "/sprites/boss-default.png"}
              alt={`맞은 ${rlabel}`}
              className="aspect-square w-24 shrink-0 rounded-lg border border-line bg-paper-3 object-contain"
            />
            <table className="shrink-0 border-collapse text-center text-[10px]">
              <tbody>
                <tr>
                  <td className="w-16 border border-line bg-paper-3 py-0.5 text-steel">
                    작성자
                  </td>
                  <td className="w-16 border border-line py-0.5 text-steel">결재</td>
                </tr>
                <tr>
                  <td className="border border-line px-1 py-2 text-[11px] font-medium text-ink">
                    {name}
                  </td>
                  <td className="border border-line py-2">
                    <RubberStamp tone="stamp" className="text-[9px]">
                      해소완료
                    </RubberStamp>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <dl className="mt-3 space-y-1.5 text-sm">
            <Row label="총 정산 점수">
              <span className="font-display text-3xl text-gold tabular-nums sm:text-4xl">
                {score.score.toLocaleString()}
              </span>
              <span className="ml-1 text-xs text-steel">점</span>
            </Row>
            {score.percentile != null && (
              <Row label="전체 상위">
                <span className="font-bold text-gold">
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
              <span className="font-display font-bold text-ink">{grade.label}</span>
              <span className="ml-1.5 text-xs text-steel">
                {grade.comment}
              </span>
            </Row>
          </dl>

          <div className="mt-4 rounded-lg border border-dashed border-line bg-paper-3/50 p-3">
            <p className="text-[10px] font-semibold text-steel">
              피격자({rlabel}) 의견
            </p>
            <p className="mt-0.5 text-sm font-medium text-ink">&ldquo;{reaction}&rdquo;</p>
          </div>

          {score.badge_ids && score.badge_ids.length > 0 && (
            <BadgeStrip badgeIds={score.badge_ids} catalog={badgeCatalog} />
          )}
        </PaperPanel>

        {/* ── 후킹 CTA ───────────────────────────────────── */}
        <div className="mt-6 text-center">
          <p className="text-sm text-steel">
            {resolveCopy(mk.share.scoreHook, rlabel)}
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            <Link
              href="/generate"
              className="rounded-lg bg-foreground px-6 py-4 text-base font-bold text-background transition hover:opacity-90"
            >
              {resolveCopy(mk.share.scoreCtaPlay, rlabel)}
            </Link>
            <Link
              href="/play"
              className="rounded-lg border-2 border-line px-6 py-3.5 text-sm font-semibold text-ink transition hover:bg-paper-3/60"
            >
              {resolveCopy(mk.share.scoreCtaPersona, rlabel)}
            </Link>
            <Link
              href="/leaderboard"
              className="pt-1 text-sm text-steel underline-offset-4 hover:text-stamp hover:underline"
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
