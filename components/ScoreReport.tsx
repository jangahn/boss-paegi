import { formatDuration, weaponLabel } from "@/lib/report";
import { Spinner } from "@/components/Spinner";

/**
 * 게임 결과 "보고서(종이)" 표현 — 점수/콤보/등급/부장님 반응 + 결재란.
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
  submitting: boolean;
  submitError: string | null;
}) {
  return (
    <div className="rounded-lg bg-[#fbfaf6] p-5 text-zinc-900 shadow-2xl">
      {/* 헤더 */}
      <div className="border-b-2 border-zinc-800 pb-3 text-center">
        <p className="text-[10px] tracking-[0.3em] text-zinc-500">{docNo}</p>
        <h2 className="mt-1 text-xl font-extrabold tracking-tight">
          스트레스 해소 결과 보고서
        </h2>
      </div>

      {/* 인형 + 결재란 */}
      <div className="mt-3 flex items-start justify-between gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dollImageUrl ?? "/sprites/boss-default.png"}
          alt="맞은 부장님"
          className="aspect-square w-20 rounded-xl border border-zinc-300 bg-zinc-100 object-contain"
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
                {nickname || "—"}
              </td>
              <td className="relative border border-zinc-400 py-2">
                <span className="inline-block -rotate-12 rounded-full border-2 border-red-500 px-1.5 py-1 text-[9px] font-bold text-red-500">
                  해소완료
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 본문 항목 */}
      <dl className="mt-3 space-y-1.5 text-sm">
        <ReportRow label="총 정산 점수">
          <span className="text-2xl font-extrabold tabular-nums">
            {score.toLocaleString()}
          </span>
          <span className="ml-1 text-xs text-zinc-500">점</span>
        </ReportRow>
        <ReportRow label="최대 콤보">x{maxCombo}</ReportRow>
        <ReportRow label="총 타격">{hitCount.toLocaleString()}회</ReportRow>
        <ReportRow label="주력 무기">{weaponLabel(mainWeapon)}</ReportRow>
        <ReportRow label="소요 시간">{formatDuration(durationMs)}</ReportRow>
        <ReportRow label="판정 등급">
          <span className="font-bold">{grade.label}</span>
          <span className="ml-1.5 text-xs text-zinc-500">{grade.comment}</span>
        </ReportRow>
      </dl>

      {/* 부장님 피드백 */}
      <div className="mt-4 rounded-md border border-dashed border-zinc-400 bg-zinc-50 p-3">
        <p className="text-[10px] font-semibold text-zinc-500">피격자 의견</p>
        <p className="mt-0.5 text-sm font-medium">&ldquo;{reaction}&rdquo;</p>
      </div>

      {submitting && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-500">
          <Spinner className="h-3.5 w-3.5" /> 랭킹 등록 중...
        </p>
      )}
      {submitError && (
        <p className="mt-3 rounded-md bg-red-500/10 p-2 text-xs text-red-500">
          점수 등록 실패: {submitError}
        </p>
      )}
    </div>
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
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-200 pb-1.5">
      <dt className="shrink-0 text-xs font-semibold text-zinc-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
