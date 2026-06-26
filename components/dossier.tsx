import type { ReactNode } from "react";

/**
 * 도시에(인사기록부) 디자인 키트 — 텍스트 없는 시각 모티프 프리미티브.
 * 새 문구를 추가하지 않고(요구사항: 문구 변경 0) 종이/잉크/도장/클립 질감만 제공한다.
 * 색은 globals.css @theme 토큰(paper/ink/steel/stamp/gold/line) 사용.
 */

/** 크림 종이 패널 — 잉크 헤어라인 + 살짝 떠 보이는 종이 그림자. 카드/섹션 컨테이너. */
export function PaperPanel({
  children,
  className = "",
  folded = false,
}: {
  children: ReactNode;
  className?: string;
  folded?: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border border-line bg-paper-2 shadow-[3px_4px_0_rgba(17,35,58,0.07)] ${className}`}
    >
      {folded && <CornerFold />}
      {children}
    </div>
  );
}

/** 접힌 종이 모서리(우상단) — 순수 장식. */
export function CornerFold() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-0 top-0 h-6 w-6 rounded-tr-xl"
      style={{
        background:
          "linear-gradient(225deg, var(--color-paper-3) 0 50%, transparent 50%)",
        borderLeft: "1px solid var(--color-line)",
        borderBottom: "1px solid var(--color-line)",
        borderBottomLeftRadius: "6px",
      }}
    />
  );
}

/** 종이 클립(좌상단 등) — 순수 장식 SVG. 부모는 relative + 위쪽 여백 필요. */
export function Paperclip({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 64"
      className={`absolute -top-2 h-12 w-6 text-steel/70 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M12 6 v40 a6 6 0 0 1-12 0 V14" transform="translate(6 2)" />
      <path d="M12 6 v40" transform="translate(6 2)" />
    </svg>
  );
}

/** 고무도장 래퍼 — 기존 텍스트/배지를 회전·테두리·디스트레스로 도장처럼. (children = 기존 문구) */
export function RubberStamp({
  children,
  className = "",
  tone = "stamp",
}: {
  children: ReactNode;
  className?: string;
  tone?: "stamp" | "gold" | "steel";
}) {
  const color =
    tone === "gold"
      ? "border-gold text-gold"
      : tone === "steel"
        ? "border-steel text-steel"
        : "border-stamp text-stamp";
  return (
    <span
      className={`inline-flex -rotate-6 items-center rounded border-[2.5px] px-2.5 py-0.5 font-bold leading-none tracking-wide opacity-90 ${color} ${className}`}
      style={{ boxShadow: "inset 0 0 0 2px color-mix(in srgb, currentColor 14%, transparent)" }}
    >
      {children}
    </span>
  );
}

/** 점선 구분선(서류 양식 느낌). */
export function DashedDivider({ className = "" }: { className?: string }) {
  return <hr className={`border-0 border-t border-dashed border-line ${className}`} aria-hidden />;
}

/** 폴더 탭 셰이프 — 컨테이너 상단에 끼우는 탭. children 은 아이콘/기존 텍스트만(새 문구 금지). */
export function FolderTab({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-t-lg bg-ink px-3 py-1.5 text-xs font-bold tracking-wider text-paper ${className}`}
    >
      {children}
    </span>
  );
}
