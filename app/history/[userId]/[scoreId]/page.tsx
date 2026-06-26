import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AppNav } from "@/components/AppNav";
import { FadeImg } from "@/components/FadeImg";
import { fetchScoreDetail, clipSignedUrl } from "@/lib/score-detail";
import { signedDollUrl } from "@/lib/storage";
import { asRole } from "@/lib/roles";
import { roleFrom } from "@/lib/config/domains/roles";
import { resolveCopy } from "@/lib/config/template";
import { formatDuration, gradeFor, reportNo, weaponLabel } from "@/lib/report";
import { getScoreConfig, getBadgeCatalog, getRoleConfig, getMarketingCopy } from "@/lib/config/getters";
import { matchPersona } from "@/lib/persona";
import { PersonaCard } from "@/components/PersonaCard";
import { BadgeStrip } from "@/components/BadgeStrip";
import { ShareReportButton } from "@/components/ShareReportButton";
import { ReportButton } from "@/components/ReportButton";

// signed doll/clip URL(TTL 600/900) 박히는 페이지 — ISR ≤60s 로 만료/삭제 staleness 최소화.
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ userId: string; scoreId: string }>;
}): Promise<Metadata> {
  const { userId, scoreId } = await params;
  const score = await fetchScoreDetail(scoreId);
  if (!score || score.owner_id !== userId) return { title: "게임 기록" };
  const name = score.profiles?.display_name ?? "익명";
  return { title: `${name}님의 기록 — ${score.score.toLocaleString()}점` };
}

/**
 * 지난 게임 상세 — "기록 회고" 역할. /share(바이럴 자랑) 의 축약판으로,
 * 부장님 멘트·하단 CTA·OG·하이라이트 임베드는 제외(그건 /share 의 몫).
 * 하이라이트가 살아있으면 /share 로 가는 링크만 둔다.
 */
export default async function HistoryDetailPage({
  params,
}: {
  params: Promise<{ userId: string; scoreId: string }>;
}) {
  const { userId, scoreId } = await params;
  const score = await fetchScoreDetail(scoreId);
  if (!score) notFound();
  // URL 변조 방지 — userId 경로와 점수 소유자 일치 검증.
  if (score.owner_id !== userId) notFound();

  const name = score.profiles?.display_name ?? "익명";
  const [scoreCfg, badgeCatalog, roleCfg, mk] = await Promise.all([
    getScoreConfig(),
    getBadgeCatalog(),
    getRoleConfig(),
    getMarketingCopy(),
  ]);
  const rlabel = roleFrom(asRole(score.dolls?.role), roleCfg).label; // DB 발행 호칭(roleFrom)
  const grade = gradeFor(score.score, scoreCfg.grades);
  const persona = score.gameplay_stats ? matchPersona(score.gameplay_stats) : null;
  const hitCount = score.gameplay_stats?.hitCount ?? null;
  // 라벨/영상첨부는 실제 클립(attached·라이브)이 있을 때만 — card(영상 없는 stat 폴백)는 '보고서 공유'.
  const shareClipUrl = await clipSignedUrl(score); // attached & 라이브만, card/none 은 null
  const hasClip = !!shareClipUrl;
  // 공유 문구·버튼 라벨은 어드민 발행 config(이전기록 전용).
  const shareText = resolveCopy(mk.share.historyShareText, rlabel, {
    제작자: name,
    점수: score.score.toLocaleString(),
  });
  const shareLabel = hasClip
    ? mk.share.historyShareBtnHighlight
    : mk.share.historyShareBtn;
  const dollImg = await signedDollUrl(score.dolls?.image_url, 600, { thumb: true }); // 384px 썸네일

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col items-center px-4 py-8">
        <div className="w-full max-w-sm">
          <Link
            href={`/history/${userId}`}
            className="mb-3 inline-block text-sm text-zinc-400 underline-offset-4 hover:underline"
          >
            ← {name}님의 기록
          </Link>

          {/* ── 보고서 (종이) — 회고용 축약판 ───────────────── */}
          <div className="rounded-lg bg-[#fbfaf6] p-5 text-zinc-900 shadow-2xl">
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
              <FadeImg
                src={dollImg ?? "/sprites/boss-default.png"}
                alt={`맞은 ${rlabel}`}
                className="aspect-square w-24 rounded-xl border border-zinc-300 bg-zinc-100"
                fit="contain"
                placeholder="pulse"
                fallbackSrc="/sprites/boss-default.png"
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
              {hitCount !== null && (
                <Row label="총 타격">{hitCount.toLocaleString()}회</Row>
              )}
              <Row label="주력 무기">{weaponLabel(score.weapon)}</Row>
              <Row label="소요 시간">{formatDuration(score.duration_ms)}</Row>
              <Row label="판정 등급">
                <span className="font-bold">{grade.label}</span>
                <span className="ml-1.5 text-xs text-zinc-500">{grade.comment}</span>
              </Row>
            </dl>

            {score.badge_ids && score.badge_ids.length > 0 && (
              <BadgeStrip badgeIds={score.badge_ids} catalog={badgeCatalog} />
            )}
          </div>

          <ShareReportButton
            scoreId={scoreId}
            score={score.score}
            highlight={hasClip}
            label={shareLabel}
            text={shareText}
            clipUrl={shareClipUrl}
          />

          {score.dolls?.id && score.dolls.image_url && (
            <div className="mt-5 text-center">
              <ReportButton dollId={score.dolls.id} />
            </div>
          )}
        </div>
      </main>
    </>
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
