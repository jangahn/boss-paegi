import { formatDuration, weaponLabel } from "@/lib/report";
import type { BadgeCatalog } from "@/lib/config/domains/badges";
import type { Persona } from "@/lib/persona";
import { PersonaCard } from "@/components/PersonaCard";
import { BadgeStrip } from "@/components/BadgeStrip";
import { Spinner } from "@/components/Spinner";
import { PaperPanel, Paperclip, RubberStamp, DashedDivider } from "@/components/dossier";

/**
 * 게임 결과 "보고서(종이)" 표현 — 패기 유형(페르소나) 해석 + 점수/콤보/등급/부장님 반응.
 * 점수 계산/제출/공유 로직은 GameOverModal 이 담당, 여긴 순수 프레젠테이션.
 */
export function ScoreReport({
  docNo,
  score,
  maxCombo,
  hitCount,
  mainWeapon,
  durationMs,
  grade,
  reaction,
  nickname,
  dollImageUrl,
  roleLabel = "부장님",
  persona,
  percentile,
  badges,
  newBadges,
  collectedCount,
  badgeCatalog,
  submitting,
  submitError,
}: {
  docNo: string;
  score: number;
  maxCombo: number;
  hitCount: number;
  mainWeapon: string;
  durationMs: number;
  grade: { label: string; comment: string };
  reaction: string;
  nickname: string;
  dollImageUrl?: string;
  /** 맞는 캐릭터 호칭 (alt 등) — 기본 "부장님" */
  roleLabel?: string;
  persona?: Persona;
  /** 전체 상위 N% — 서버 응답 전 null */
  percentile?: number | null;
  /** 이번 판 획득 뱃지 id (클라 즉시) */
  badges?: string[];
  /** 새로 획득한 뱃지 id (서버) */
  newBadges?: string[];
  /** 누적 수집 수 (서버) */
  collectedCount?: number;
  /** 뱃지 카탈로그(라벨·이모지·압축) — 부모 주입(클라 useBadgeCatalog). */
  badgeCatalog: BadgeCatalog;
  submitting: boolean;
  submitError: string | null;
}) {
  return (
    <PaperPanel folded className="relative px-5 pb-5 pt-7 text-ink">
      <Paperclip className="left-6" />
      {/* 헤더 */}
      <div className="border-b-2 border-line pb-3 text-center">
        <p className="text-[10px] tracking-[0.3em] text-steel">{docNo}</p>
        <h2 className="mt-1 font-display text-2xl tracking-tight text-ink sm:text-3xl">
          스트레스 해소 결과 보고서
        </h2>
      </div>

      {/* 오늘의 패기 유형 (페르소나 해석 리빌) — 보고서의 하이라이트 */}
      {persona && (
        <div className="mt-3">
          <PersonaCard persona={persona} />
        </div>
      )}

      {/* 인형 + 결재란 */}
      <div className="mt-3 flex items-start justify-between gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dollImageUrl ?? "/sprites/boss-default.png"}
          alt={`맞은 ${roleLabel}`}
          className="aspect-square w-20 shrink-0 rounded-lg border border-line bg-paper-3 object-contain"
        />
        <table className="border-collapse text-center text-[10px]">
          <tbody>
            <tr>
              <td className="w-16 border border-line bg-paper-3 py-0.5 text-steel">
                작성자
              </td>
              <td className="w-16 border border-line py-0.5 text-steel">결재</td>
            </tr>
            <tr>
              <td className="border border-line px-1 py-2 text-[11px] font-medium text-ink">
                {nickname || "—"}
              </td>
              <td className="relative border border-line py-2">
                <RubberStamp tone="stamp" className="text-[9px]">
                  해소완료
                </RubberStamp>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <DashedDivider className="mt-3" />

      {/* 본문 항목 */}
      <dl className="mt-3 space-y-1.5 text-sm">
        <ReportRow label="총 정산 점수">
          <span className="font-display text-2xl tabular-nums text-gold sm:text-3xl">
            {score.toLocaleString()}
          </span>
          <span className="ml-1 text-xs text-steel">점</span>
        </ReportRow>
        {(percentile != null || submitting) && (
          <ReportRow label="전체 상위">
            {percentile != null ? (
              <span className="font-display text-gold">상위 {percentile}%</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-steel">
                <Spinner className="h-3 w-3" /> 계산 중
              </span>
            )}
          </ReportRow>
        )}
        <ReportRow label="최대 콤보">x{maxCombo}</ReportRow>
        <ReportRow label="총 타격">{hitCount.toLocaleString()}회</ReportRow>
        <ReportRow label="주력 무기">{weaponLabel(mainWeapon)}</ReportRow>
        <ReportRow label="소요 시간">{formatDuration(durationMs)}</ReportRow>
        <ReportRow label="판정 등급">
          <span className="font-display text-ink">{grade.label}</span>
          <span className="ml-1.5 text-xs text-steel">{grade.comment}</span>
        </ReportRow>
      </dl>

      {/* 부장님 피드백 */}
      <div className="mt-4 rounded-lg border border-dashed border-line bg-paper p-3">
        <p className="text-[10px] font-semibold tracking-wide text-steel">피격자 의견</p>
        <p className="mt-0.5 text-sm font-medium text-ink">&ldquo;{reaction}&rdquo;</p>
      </div>

      {/* 획득 뱃지 (이번 판 + NEW + 누적 수집) */}
      {badges && badges.length > 0 && (
        <BadgeStrip
          badgeIds={badges}
          catalog={badgeCatalog}
          newIds={newBadges}
          collected={collectedCount}
        />
      )}

      {submitting && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-steel">
          <Spinner className="h-3.5 w-3.5" /> 랭킹 등록 중...
        </p>
      )}
      {submitError && (
        <p className="mt-3 rounded-md bg-red-500/10 p-2 text-xs text-red-500">
          점수 등록 실패: {submitError}
        </p>
      )}
    </PaperPanel>
  );
}

function ReportRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
      <dt className="min-w-0 shrink-0 text-xs font-semibold text-steel">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}
