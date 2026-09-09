import { fmtKst } from "@/lib/admin-format";
import {
  ANALYTICS_EVENT_KIND_KO,
  CONVERSION_STEP_KO,
  MEMBER_KO,
  SOURCE_SCOPE_KO,
  SURFACE_KO,
  TARGET_KO,
  landingLabel,
  sourceLabel,
} from "@/lib/admin-acquisition-labels";
import type { AnalyticsEventRow } from "@/lib/admin-acquisition-events";

// 원본 이벤트 목록(v1.31) — 표 대신 행 카드: UA·레퍼러가 길어 375px 에서 가로 스크롤 없이 break-all 로 접힌다.
// 레퍼러는 링크가 아닌 텍스트(모르는 주소로 이동하지 않게). 조회 전용(presentational, RSC).

function summary(e: AnalyticsEventRow): string {
  if (e.kind === "visit") {
    return [
      SOURCE_SCOPE_KO[e.source_scope ?? ""] ?? e.source_scope ?? "—",
      landingLabel(e.landing ?? ""),
      sourceLabel(e.source_kind ?? "", e.source_value ?? ""),
    ].join(" · ");
  }
  if (e.kind === "share") {
    const tier = e.score_tier === null ? "" : ` · 점수 구간 ${e.score_tier}`;
    return `${SURFACE_KO[e.surface ?? ""] ?? e.surface ?? "—"} · ${TARGET_KO[e.target ?? ""] ?? e.target ?? "—"}${tier}`;
  }
  return `${CONVERSION_STEP_KO[e.conversion_step ?? ""] ?? e.conversion_step ?? "—"} · ${sourceLabel(
    e.source_kind ?? "",
    e.source_value ?? "",
  )}`;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="w-12 shrink-0 text-zinc-500">{label}</span>
      <span className={`min-w-0 break-all font-mono ${value ? "text-foreground/80" : "text-zinc-600"}`}>{value ?? "—"}</span>
    </div>
  );
}

export function AnalyticsEventList({ rows }: { rows: AnalyticsEventRow[] }) {
  if (!rows.length) {
    return <p className="text-sm text-zinc-400">조건에 맞는 이벤트가 없어요.</p>;
  }
  return (
    <ul className="space-y-2">
      {rows.map((e) => (
        <li key={e.id} className="rounded-2xl border border-foreground/10 ui-surface p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="tabular-nums text-zinc-500">{fmtKst(e.created_at)}</span>
            <span className="rounded-md bg-foreground px-1.5 py-0.5 text-xs font-semibold text-paper-2">
              {ANALYTICS_EVENT_KIND_KO[e.kind] ?? e.kind}
            </span>
            <span className="text-xs text-zinc-500">{MEMBER_KO[e.member_state] ?? e.member_state}</span>
            <span className="min-w-0 break-keep text-foreground/80">{summary(e)}</span>
          </div>
          <div className="mt-2 space-y-1">
            <Field label="UA" value={e.ua} />
            {e.kind === "visit" && <Field label="레퍼러" value={e.referrer_url} />}
          </div>
        </li>
      ))}
    </ul>
  );
}
