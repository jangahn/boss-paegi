import type { LegalSection } from "@/lib/legal/types";

// 법무 문서 본문 렌더 — **plain text only**. body 는 React 텍스트 노드 + whitespace-pre-wrap 로만.
// dangerouslySetInnerHTML·markdown/html 파서 금지(주입 차단). 공개 페이지와 어드민 미리보기 공용.
type Badge = "current" | "upcoming" | "past";
const BADGE: Record<Badge, { label: string; cls: string }> = {
  current: { label: "현재 시행본", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" },
  upcoming: { label: "시행 예정본", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  past: { label: "과거 시행본", cls: "bg-foreground/10 text-zinc-500" },
};

export function LegalDocView({
  title,
  effectiveDate,
  version,
  sections,
  publicNote,
  badge,
}: {
  title: string;
  effectiveDate?: string | null;
  version?: number;
  sections: LegalSection[];
  publicNote?: string | null;
  badge?: Badge;
}) {
  return (
    <article className="flex flex-col gap-6">
      <header className="border-b border-foreground/10 pb-4">
        {badge && (
          <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${BADGE[badge].cls}`}>
            {BADGE[badge].label}
          </span>
        )}
        <h1 className="mt-2 font-bold text-3xl tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-xs text-zinc-500">
          {effectiveDate ? `시행일 ${effectiveDate}` : "미발행(초안)"}
          {version ? ` · 버전 ${version}` : ""}
        </p>
        {publicNote && (
          <p className="mt-2 rounded-lg bg-foreground/5 p-2 text-xs text-zinc-500">
            개정 사유: {publicNote}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-6">
        {sections.map((s, i) => (
          <section key={i} className="flex flex-col gap-1.5">
            <h2 className="text-base font-bold">{s.heading}</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              {s.body}
            </p>
          </section>
        ))}
      </div>
    </article>
  );
}
