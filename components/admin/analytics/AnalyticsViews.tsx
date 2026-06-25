import { WEAPONS } from "@/lib/weapons";
import { BACKGROUNDS } from "@/lib/backgrounds";
import type {
  DimStat,
  Funnel,
  WeaponConcentration,
  WeaponThroughput,
  MapStickiness,
} from "@/lib/admin-analytics";

/** 게임플레이 분석 표시 컴포넌트 — 차트 라이브러리 없이 CSS 바 + 카드. */

const WEAPON_LABEL: Record<string, string> = Object.fromEntries(WEAPONS.map((w) => [w.key, `${w.emoji} ${w.label}`]));
const MAP_LABEL: Record<string, string> = Object.fromEntries(BACKGROUNDS.map((b) => [b.key, b.label]));

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

/**
 * 무기/맵 밸런스 — 타격 비중 바(+무기는 점수 비중·갭). 정렬 hits desc(입력 순서 유지).
 * 무기: 갭=점수비중−타격비중(빈도정규화된 점수 기여 불균형, 밸런스 의심 신호이지 확정 아님).
 * 맵: per-hit 효율은 무의미하므로 비중·전환만.
 */
export function BalanceBars({ stats, kind }: { stats: DimStat[]; kind: "weapon" | "map" }) {
  const labels = kind === "weapon" ? WEAPON_LABEL : MAP_LABEL;
  const total = stats.reduce((s, x) => s + x.hits, 0);
  const totalScore = stats.reduce((s, x) => s + x.score, 0);
  const max = Math.max(1, ...stats.map((x) => x.hits));
  if (!stats.length || total === 0) {
    return <p className="text-sm text-zinc-400">아직 데이터가 없어요.</p>;
  }
  const weapon = kind === "weapon";
  return (
    <div className="flex flex-col gap-1.5">
      {stats.map((s) => {
        const hitShare = s.hits / total;
        const scoreShare = totalScore > 0 ? s.score / totalScore : 0;
        const gapPts = (scoreShare - hitShare) * 100; // 퍼센트포인트
        const dominant = hitShare >= 0.5;
        return (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-zinc-600 dark:text-zinc-300">{labels[s.key] ?? s.key}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-foreground/5">
              <div
                className={`h-full rounded ${dominant ? "bg-red-400/80" : "bg-sky-400/70"}`}
                style={{ width: `${Math.max(2, (s.hits / max) * 100)}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right tabular-nums font-medium" title="타격 비중">{pct(s.hits, total)}</span>
            {weapon && (
              <>
                <span className="w-12 shrink-0 text-right tabular-nums text-zinc-400" title="점수 비중">{pct(s.score, totalScore)}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-zinc-400" title="점수 비중 − 타격 비중(퍼센트포인트)">
                  {`${gapPts >= 0 ? "+" : "−"}${Math.abs(gapPts).toFixed(1)}%p`}
                </span>
              </>
            )}
            <span className="w-16 shrink-0 text-right tabular-nums text-zinc-400" title="전환/시도">
              {s.switches}↔/{s.attempts}
            </span>
          </div>
        );
      })}
      <p className="mt-1 text-[11px] text-zinc-400">
        {weapon
          ? `바·첫% = 타격 비중(빨강=50%+ 독점), 둘째% = 점수 비중, gap = 점수−타격(+면 빈도 대비 점수 기여 큼 — 밸런스 의심 신호이지 확정 아님). ↔/시도 = 전환/선택. 총 ${total.toLocaleString()}타.`
          : `바·% = 타격 비중(맵 점유, 빨강=50%+ 독점), ↔/시도 = 전환/선택. 총 ${total.toLocaleString()}타.`}
      </p>
    </div>
  );
}

/** 플레이내 펀널 — 진입→첫타→첫전환→궁극→완료. */
export function FunnelView({ funnel }: { funnel: Funnel }) {
  const entered = funnel.entered ?? 0;
  const steps: { key: string; label: string }[] = [
    { key: "entered", label: "진입" },
    { key: "first_hit", label: "첫 타격" },
    { key: "first_switch", label: "첫 전환" },
    { key: "first_ult", label: "첫 궁극기" },
    { key: "completed", label: "정상 완료" },
  ];
  if (entered === 0) return <p className="text-sm text-zinc-400">아직 데이터가 없어요.</p>;
  return (
    <>
      <div className="grid grid-cols-5 gap-1 text-center">
        {steps.map((st) => (
          <div key={st.key} className="rounded-lg border border-foreground/10 p-2">
            <p className="text-[10px] text-zinc-500">{st.label}</p>
            <p className="text-base font-bold tabular-nums">{(funnel[st.key] ?? 0).toLocaleString()}</p>
            {st.key !== "entered" && <p className="text-[10px] text-amber-600">{pct(funnel[st.key] ?? 0, entered)}</p>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-foreground/15 px-2.5 py-1">강제종료 <b>{funnel.forced ?? 0}</b></span>
        <span className="rounded-full border border-foreground/15 px-2.5 py-1">이탈 <b>{funnel.abandoned ?? 0}</b></span>
        <span className="rounded-full border border-foreground/15 px-2.5 py-1">맵전환(2곳+) <b>{funnel.multi_map ?? 0}</b> ({pct(funnel.multi_map ?? 0, entered)})</span>
      </div>
    </>
  );
}

/* ── 세션 단위 분석(편중/효율/맵고착) — telemetry_sessions 직접 집계 결과 표시 ── */

const EMPTY = <p className="text-sm text-zinc-400">아직 분석할 세션이 없어요.</p>;

function wLabel(k: string): string {
  return k === "unknown" ? "알 수 없음" : WEAPON_LABEL[k] ?? k;
}
function mLabel(k: string): string {
  return k === "unknown" ? "알 수 없음" : MAP_LABEL[k] ?? k;
}

/** 표본수 임계: n<5 숨김, 5≤n<20 '표본 적음', n≥20 정상 */
function sampleTag(n: number): { hide: boolean; badge: string | null } {
  if (n < 5) return { hide: true, badge: null };
  if (n < 20) return { hide: false, badge: "표본 적음" };
  return { hide: false, badge: null };
}

function MetaNote({ size, truncated, limit, suffix }: { size: number; truncated: boolean; limit: number; suffix?: string }) {
  return (
    <p className="mt-1 text-[10px] text-zinc-400">
      표본 {size.toLocaleString()}세션{suffix ? ` · ${suffix}` : ""}
      {truncated ? ` · 최대 ${limit.toLocaleString()} 표본 제한 적용` : ""}
    </p>
  );
}

/** 분포 막대 목록(메인무기·시작맵) — 값 desc, 표본 적은 항목 배지. */
function DistBars({ dist, label }: { dist: Record<string, number>; label: (k: string) => string }) {
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (!entries.length || total === 0) return <p className="text-xs text-zinc-400">—</p>;
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => {
        const tag = sampleTag(v);
        return (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-zinc-600 dark:text-zinc-300">{label(k)}</span>
            <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-foreground/5">
              <div className="h-full rounded bg-sky-400/70" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right tabular-nums font-medium">{v.toLocaleString()} ({pct(v, total)})</span>
            {tag.badge && <span className="w-12 shrink-0 text-right text-[10px] text-amber-600">{tag.badge}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ConcBar({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-zinc-400">—</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-foreground/5">
        <div className="h-full rounded bg-red-400/70" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums text-xs font-medium">{value.toFixed(2)}</span>
    </div>
  );
}

/** 무기 편중·다양성. */
export function WeaponConcentrationCard({ data }: { data: WeaponConcentration }) {
  if (data.weaponSessions === 0) return EMPTY;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="단일무기 세션" value={pct01(data.singleWeaponPct)} />
        <MiniStat label="평균 무기 종수" value={data.avgDistinctWeapons.toFixed(1)} />
        <MiniStat label="tap 카테고리" value={pct01(data.tapCategoryShare)} />
      </div>
      <div>
        <p className="mb-1 text-[11px] text-zinc-500">세션 평균 집중도 (1에 가까울수록 한 무기 몰림, 낮을수록 분산)</p>
        <ConcBar value={data.avgSessionConcentration} />
      </div>
      <div>
        <p className="mb-1 text-[11px] text-zinc-500">메인무기 분포 (세션에서 가장 많이 쓴 무기)</p>
        <DistBars dist={data.mainWeaponDist} label={wLabel} />
      </div>
      <MetaNote
        size={data.sampleSize}
        truncated={data.isTruncated}
        limit={data.limit}
        suffix={`무기 사용 세션 ${data.weaponSessions.toLocaleString()}${
          data.knownHitCoverage < 0.999 ? ` · known 무기 커버리지 ${pct01(data.knownHitCoverage)}` : ""
        } · 전체 타격분포 집중도 ${data.aggregateHitConcentration?.toFixed(2) ?? "—"}`}
      />
    </div>
  );
}

/** 무기 효율·파워 — 메인무기 기준 점수/초 중앙값(근사). pure(단일무기) 우선. */
export function WeaponThroughputBars({ data }: { data: WeaponThroughput }) {
  if (data.eligibleSessions === 0) return EMPTY;
  // 표시 가능한 행(pure≥5 또는 all≥5)만, 큰 중앙값 순
  const rows = data.rows
    .map((r) => {
      const usePure = r.pureN >= 5 && r.medianPure != null;
      const useAll = !usePure && r.allN >= 5 && r.medianAll != null;
      const value = usePure ? r.medianPure! : useAll ? r.medianAll! : null;
      const n = usePure ? r.pureN : r.allN;
      return { r, value, n, usePure };
    })
    .filter((x) => x.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const max = Math.max(1, ...rows.map((x) => x.value ?? 0));
  if (!rows.length) return <p className="text-sm text-zinc-400">표본이 충분한 무기가 아직 없어요(무기별 5세션 이상 필요).</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(({ r, value, n, usePure }) => {
        const tag = sampleTag(n);
        return (
          <div key={r.weapon} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-zinc-600 dark:text-zinc-300">{wLabel(r.weapon)}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-foreground/5">
              <div className="h-full rounded bg-emerald-400/70" style={{ width: `${Math.max(2, ((value ?? 0) / max) * 100)}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right tabular-nums font-medium">{Math.round(value ?? 0).toLocaleString()}/초</span>
            <span className="w-28 shrink-0 text-right text-[10px] text-zinc-400">
              {usePure ? `단일무기 ${n}판` : `메인무기 ${n}판·단일표본부족`}
              {tag.badge ? ` · ${tag.badge}` : ""}
            </span>
          </div>
        );
      })}
      <p className="mt-1 text-[11px] text-zinc-400">
        메인무기 기준 점수/초 중앙값(근사) — 정확한 무기 DPS 아님(콤보·맵·숙련도 혼재). 단일무기 세션 우선. 완료·유효 duration 세션 {data.eligibleSessions.toLocaleString()}개 기준(전체 {data.totalSessions.toLocaleString()}, 제외 {data.excludedSessions.toLocaleString()}).
      </p>
    </div>
  );
}

/** 맵 고착·전환. */
export function MapStickinessCard({ data }: { data: MapStickiness }) {
  if (data.validMapSessions === 0) return EMPTY;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="단일맵 세션" value={pct01(data.singleMapPct)} />
        <MiniStat label="평균 맵 종수" value={data.avgDistinctMaps.toFixed(1)} />
        <MiniStat label="맵전환/세션" value={data.mapSwitchRate.toFixed(2)} />
      </div>
      <div>
        <p className="mb-1 text-[11px] text-zinc-500">시작맵 분포</p>
        <DistBars dist={data.startMapDist} label={mLabel} />
      </div>
      <MetaNote size={data.sampleSize} truncated={data.isTruncated} limit={data.limit} suffix={`맵 데이터 세션 ${data.validMapSessions.toLocaleString()} 기준`} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-foreground/10 bg-foreground/5 p-2 text-center">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-base font-bold tabular-nums">{value}</p>
    </div>
  );
}

function pct01(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
