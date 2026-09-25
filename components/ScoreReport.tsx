import { formatDuration, weaponLabel } from "@/lib/report";
import type { BadgeCatalog } from "@/lib/config/domains/badges";
import type { Persona } from "@/lib/persona";
import { PersonaCard } from "@/components/PersonaCard";
import { BadgeStrip } from "@/components/BadgeStrip";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { GradeRow, ReportApprovalTable, ReportRow } from "@/components/ReportParts";

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
  onRetrySubmit,
  pending,
  previousBest,
  timeBonus,
  nextGrade,
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
  onRetrySubmit?: () => void;
  /** 어뷰징 의심으로 운영자 검토 대기(pending/voided) — 안내+경고 문구. null=정상. */
  pending?: { notice: string; warning: string } | null;
  /** 이전 최고 기록(v1.54, 서버) — undefined = 모름(응답 전이면 「계산 중」, 실패면 줄 숨김), null = 첫 기록 */
  previousBest?: number | null;
  /** 이번 판에 받은 추가 시간(제한 시간) — 0 이면 줄 숨김 */
  timeBonus?: { ms: number; count: number } | null;
  /** 다음 등급과 남은 점수 — 최고 등급이면 null */
  nextGrade?: { label: string; gap: number } | null;
}) {
  const isNewBest = previousBest === null || (typeof previousBest === "number" && score > previousBest);
  return (
    <div className="rounded-lg ui-surface p-5 text-zinc-900 shadow-2xl">
      {/* 헤더 */}
      <div className="border-b-2 border-zinc-800 pb-3 text-center">
        <p className="text-[10px] tracking-[0.3em] text-zinc-500">{docNo}</p>
        <h2 className="mt-1 text-xl font-extrabold tracking-tight">
          스트레스 해소 결과 보고서
        </h2>
      </div>

      {/* 오늘의 패기 유형 (페르소나 해석 리빌) — 보고서의 하이라이트 */}
      {persona && (
        <div className="mt-3">
          <PersonaCard persona={persona} />
        </div>
      )}

      {/* 캐릭터 + 결재란 */}
      <div className="mt-3 flex items-start justify-between gap-3">
        <FadeImg
          src={dollImageUrl ?? "/sprites/boss-default.png"}
          alt={`맞은 ${roleLabel}`}
          className="aspect-square w-20 shrink-0 rounded-xl border border-zinc-300 bg-zinc-100"
          fit="contain"
          placeholder="shimmer"
          errorText="캐릭터 이미지를 불러오지 못했어요."
        />
        <ReportApprovalTable author={nickname || "—"} />
      </div>

      {/* 본문 항목 */}
      <dl className="mt-3 space-y-1.5 text-sm">
        <ReportRow label="총 정산 점수">
          <span className="text-2xl font-extrabold tabular-nums">
            {score.toLocaleString()}
          </span>
          <span className="ml-1 text-xs text-zinc-500">점</span>
          {previousBest !== undefined && isNewBest && (
            <span className="ml-1.5 inline-block -translate-y-1 rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-extrabold text-white">
              {previousBest === null ? "첫 기록!" : "신기록!"}
            </span>
          )}
        </ReportRow>
        {(previousBest !== undefined || submitting) && (
          <ReportRow label="내 최고 기록">
            {previousBest === undefined ? (
              <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
                <Spinner className="h-3 w-3" /> 계산 중
              </span>
            ) : (
              // 최고 점수 하나만(v1.57 사용자 결정) — 이번 판을 포함한 최고. 신기록 · 첫 기록은 총 정산 점수 옆 칩이 알린다.
              <span className="tabular-nums">{Math.max(score, previousBest ?? score).toLocaleString()}점</span>
            )}
          </ReportRow>
        )}
        {(percentile != null || submitting) && (
          <ReportRow label="전체 상위">
            {percentile != null ? (
              <span className="font-bold text-amber-600">상위 {percentile}%</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
                <Spinner className="h-3 w-3" /> 계산 중
              </span>
            )}
          </ReportRow>
        )}
        <ReportRow label="최대 콤보">x{maxCombo}</ReportRow>
        <ReportRow label="총 타격">{hitCount.toLocaleString()}회</ReportRow>
        <ReportRow label="주력 무기">{weaponLabel(mainWeapon)}</ReportRow>
        <ReportRow label="소요 시간">{formatDuration(durationMs)}</ReportRow>
        {timeBonus && timeBonus.ms > 0 && (
          <ReportRow label="추가 시간">
            <span className="font-semibold tabular-nums">+{Math.round(timeBonus.ms / 1000)}초</span>
            <span className="ml-1 text-xs text-zinc-500">(궁극기 {timeBonus.count}회)</span>
          </ReportRow>
        )}
        <GradeRow grade={grade} />
        {nextGrade && (
          <ReportRow label="다음 등급">
            <span className="text-xs text-zinc-600 tabular-nums">
              「{nextGrade.label}」까지 <b>{nextGrade.gap.toLocaleString()}</b>점
            </span>
          </ReportRow>
        )}
      </dl>

      {/* 부장님 피드백 */}
      <div className="mt-4 rounded-md border border-dashed border-zinc-400 bg-zinc-50 p-3">
        <p className="text-[10px] font-semibold text-zinc-500">피격자 의견</p>
        <p className="mt-0.5 text-sm font-medium">&ldquo;{reaction}&rdquo;</p>
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
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-500">
          <Spinner className="h-3.5 w-3.5" /> 랭킹 등록 중...
        </p>
      )}
      {submitError && (
        <div className="mt-3 rounded-md bg-red-500/10 p-2 text-center text-xs text-red-500">
          <p>점수 등록 실패: {submitError}</p>
          {onRetrySubmit && !submitting && (
            <button
              type="button"
              onClick={onRetrySubmit}
              className="mt-2 rounded-full border border-red-500/40 px-3 py-1 font-semibold hover:bg-red-500/10"
            >
              다시 시도
            </button>
          )}
        </div>
      )}
      {pending && !submitting && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-center">
          <p className="text-xs font-semibold text-amber-700">⏳ 랭킹 검토 중</p>
          {/* 어절 단위로만 끊고 두 줄을 고르게(v1.58) — 375px 에서 「…반영됩 / 니다」처럼 꺾이던 발행 문구 */}
          <p className="mt-1 text-balance break-keep text-[11px] leading-relaxed text-amber-800">{pending.notice}</p>
          <p className="mt-1 text-balance break-keep text-[11px] font-medium leading-relaxed text-red-600">
            {pending.warning}
          </p>
        </div>
      )}
    </div>
  );
}
