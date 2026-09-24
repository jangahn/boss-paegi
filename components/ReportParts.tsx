import type { CSSProperties, ReactNode } from "react";
import { fitOneLineWeight } from "@/lib/fit-one-line";

/**
 * 결과 보고서 공용 조각(v1.57) — 게임 종료 화면(ScoreReport) · 공유(/share) · 내 기록 상세(/history) 가 같은 마크업을 쓴다.
 * 소형폰(iPhone SE 375)에서 의도치 않은 두 줄을 막는 규칙을 한곳에 둔다. 서버 컴포넌트에서도 쓴다(훅 없음).
 */

/** 보고서 한 줄 — 왼쪽 항목 이름, 오른쪽 값. */
export function ReportRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-200 pb-1.5">
      <dt className="shrink-0 text-xs font-semibold text-zinc-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/**
 * 판정 등급 — 등급 이름은 값 자리, 한 줄 평은 그 아래 줄 전체 폭(오른쪽 정렬). 값 칸 하나에 둘을 같이 넣으면 375px 에서
 * 발행 문구 다섯 중 넷이 「…시작됐습 / 니다」처럼 꺾였다. 한 줄 평이 줄 전체 폭보다 길면(어드민 발행 문구) 한두 글자만
 * 떨어지지 않게 고르게 두 줄(text-balance). 한 줄 평은 같은 등급 이름(dt)의 두 번째 설명(dd)이다.
 */
export function GradeRow({ grade }: { grade: { label: string; comment: string } }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-zinc-200 pb-1.5">
      <dt className="shrink-0 text-xs font-semibold text-zinc-500">판정 등급</dt>
      <dd className="text-right font-bold">{grade.label}</dd>
      <dd className="basis-full text-balance text-right text-xs text-zinc-500">
        {/* 화면에선 줄로 나뉘고, 스크린 리더엔 등급 이름과 이어 읽히지 않게 구분자(종전 「— 」)를 남긴다 */}
        <span className="sr-only">— </span>
        {grade.comment}
      </dd>
    </div>
  );
}

/**
 * 결재란 — 작성자(닉네임) · 결재(도장). 캐릭터 이미지 옆 남은 폭을 전부 쓰고(결재 칸만 64px 고정) 닉네임은 한 줄.
 * 칸 폭이 64px 고정이던 v1.56 까지는 한글 6자부터 꺾였다(랜덤 기본 닉네임이 9자). 부모는 이미지와 이 표를 담은 flex 행.
 */
export function ReportApprovalTable({ author }: { author: string }) {
  return (
    <table className="w-full min-w-0 flex-1 table-fixed border-collapse text-center text-[10px]">
      <tbody>
        <tr>
          <td className="border border-zinc-400 bg-zinc-100 py-0.5">작성자</td>
          <td className="w-16 border border-zinc-400 bg-zinc-100 py-0.5">결재</td>
        </tr>
        <tr>
          <td className="border border-zinc-400 px-1 py-2 text-[11px] font-medium">
            <div className="@container">
              <span className="fit-one-line" style={{ "--fit-weight": fitOneLineWeight(author) } as CSSProperties}>
                {author}
              </span>
            </div>
          </td>
          <td className="border border-zinc-400 py-2">
            <span className="inline-block -rotate-12 rounded-full border-2 border-red-500 px-1.5 py-1 text-[9px] font-bold text-red-500">
              해소완료
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
