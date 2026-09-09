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
// 1줄 시각·종류·회원여부 / 2줄 판정 칩 / 아래 UA·레퍼러 원문.
// 레퍼러는 링크가 아닌 텍스트(모르는 주소로 이동하지 않게). 조회 전용(presentational, RSC).

type Part = { label: string; value: string };

/** 판정 결과를 칩으로 — 종류 옆에 이어 쓰면 좁은 화면에서 어색하게 꺾여 2줄로 분리(lottogen 뷰어와 같은 규약). */
function parts(e: AnalyticsEventRow): Part[] {
  if (e.kind === "visit") {
    return [
      { label: "스코프", value: SOURCE_SCOPE_KO[e.source_scope ?? ""] ?? e.source_scope ?? "—" },
      { label: "랜딩", value: landingLabel(e.landing ?? "") },
      { label: "소스", value: sourceLabel(e.source_kind ?? "", e.source_value ?? "") },
    ];
  }
  if (e.kind === "share") {
    const out: Part[] = [
      { label: "표면", value: SURFACE_KO[e.surface ?? ""] ?? e.surface ?? "—" },
      { label: "대상", value: TARGET_KO[e.target ?? ""] ?? e.target ?? "—" },
    ];
    if (e.score_tier !== null) out.push({ label: "점수 구간", value: String(e.score_tier) });
    return out;
  }
  return [
    { label: "단계", value: CONVERSION_STEP_KO[e.conversion_step ?? ""] ?? e.conversion_step ?? "—" },
    { label: "소스", value: sourceLabel(e.source_kind ?? "", e.source_value ?? "") },
  ];
}

function Chip({ label, value }: Part) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1 rounded-md bg-foreground/5 px-1.5 py-0.5 text-xs text-foreground/80">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </span>
  );
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
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {parts(e).map((p) => (
              <Chip key={p.label} {...p} />
            ))}
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
