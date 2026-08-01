import Link from "next/link";
import { PendingLinkLabel } from "@/components/PendingLinkLabel";

/**
 * 공용 페이지네이션 — 맨앞 / 이전 / page·total / 다음 / 맨뒤.
 * 서버 렌더 가능(Link 기반). 끝 경계에선 비활성(span). totalPages<=1 이면 미표시.
 * hrefFor(page) 로 각 호출부가 자신의 쿼리(다른 필터 보존)를 만들어 넘긴다.
 */
type Props = {
  page: number;
  totalPages: number;
  hrefFor: (page: number) => string;
};

// 소형 화면(iPhone SE)에서 5셀이 줄폭을 넘치면 라벨이 세로로 쪼개진다 —
// 셀은 절대 줄바꿈·수축하지 않고, 모바일에선 패딩·글자만 줄인다.
const BASE =
  "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-2 text-xs transition sm:px-3 sm:text-sm";
const ENABLED = "border-foreground/15 hover:bg-foreground/5";
const DISABLED = "pointer-events-none border-foreground/10 text-zinc-600";

export function Pagination({ page, totalPages, hrefFor }: Props) {
  if (totalPages <= 1) return null;
  const atFirst = page <= 1;
  const atLast = page >= totalPages;
  return (
    <nav
      className="flex items-center justify-center gap-1.5 text-sm sm:gap-2"
      aria-label="페이지 이동"
    >
      <Cell href={hrefFor(1)} disabled={atFirst} label="« 맨앞" />
      <Cell href={hrefFor(page - 1)} disabled={atFirst} label="‹ 이전" />
      <span className="shrink-0 whitespace-nowrap px-1 tabular-nums text-zinc-500">
        {page} / {totalPages}
      </span>
      <Cell href={hrefFor(page + 1)} disabled={atLast} label="다음 ›" />
      <Cell href={hrefFor(totalPages)} disabled={atLast} label="맨뒤 »" />
    </nav>
  );
}

function Cell({ href, disabled, label }: { href: string; disabled: boolean; label: string }) {
  if (disabled) return <span className={`${BASE} ${DISABLED}`}>{label}</span>;
  return (
    <Link href={href} className={`${BASE} ${ENABLED}`}>
      <PendingLinkLabel>{label}</PendingLinkLabel>
    </Link>
  );
}
