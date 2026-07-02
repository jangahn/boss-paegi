import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getIntegrityDetail } from "@/lib/admin-integrity";
import { IntegrityActions } from "@/components/admin/IntegrityActions";
import { formatDuration, weaponLabel } from "@/lib/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABEL: Record<string, string> = {
  registered: "정상",
  pending: "검토 대기",
  cleared: "정상 확인",
  voided: "무효",
};

/** 인간 지속 apm 상한(실측 ≥60s ~879) 참조선 — 봇(≈3600 고정)과 육안 대비. */
const HUMAN_APM_CEILING = 880;

export default async function AdminIntegrityDetailPage({
  params,
}: {
  params: Promise<{ scoreId: string }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");
  const { scoreId } = await params;
  const d = await getIntegrityDetail(scoreId);
  if (!d) notFound();

  const scorePerSec = d.durationMs > 0 ? Math.round((d.score / d.durationMs) * 1000) : 0;
  const t = d.telemetry;
  const scoreMismatch =
    t?.score != null && d.score > 0 ? Math.round((Math.abs(d.score - t.score) / d.score) * 100) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href="/admin/integrity" className="text-sm text-zinc-400 underline-offset-4 hover:underline">
        ← 리뷰 큐
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tabular-nums">{d.score.toLocaleString()}점</h1>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{STATUS_LABEL[d.reviewStatus] ?? d.reviewStatus}</span>
        {d.abuseStatus === "banned" && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">정지된 유저</span>
        )}
        {d.flag && <span className="text-sm text-amber-400">위험도 {d.flag.abuseScore}</span>}
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        {d.ownerName} {d.email ? `· ${d.email}` : ""} · {new Date(d.createdAt).toLocaleString("ko-KR")}
      </p>

      {/* 종합 지표 */}
      <Section title="점수 지표">
        <Grid>
          <Field label="점수/초" value={`${scorePerSec.toLocaleString()} (인간 ≤1,267)`} warn={scorePerSec > 1400} />
          <Field label="지속 타격속도" value={apmToRate(t?.apm)} warn={(t?.apm ?? 0) > 18 * 60} />
          <Field label="소요 시간" value={formatDuration(d.durationMs)} warn={d.durationMs > 900000} />
          <Field label="최대 콤보" value={d.maxCombo?.toLocaleString() ?? "—"} />
          <Field label="주력 무기" value={weaponLabel(d.weapon)} />
          <Field label="rules" value={d.flag?.rulesVersion ?? "—"} />
        </Grid>
      </Section>

      {/* 발화 신호 */}
      {d.flag && d.flag.signals.length > 0 && (
        <Section title="발화 신호">
          <ul className="space-y-1 text-sm">
            {d.flag.signals.map((s, i) => (
              <li key={i} className="flex flex-wrap gap-2 text-zinc-300">
                <span className="font-mono text-amber-400">{s.id}</span>
                {s.value != null && (
                  <span className="text-zinc-400">
                    값 {s.value}{s.threshold != null ? ` / 임계 ${s.threshold}` : ""}
                  </span>
                )}
                <span className="text-[11px] text-zinc-500">({s.source})</span>
              </li>
            ))}
          </ul>
          {d.flag.reason && <p className="mt-2 text-xs text-zinc-400">사유: {d.flag.reason}</p>}
        </Section>
      )}

      {/* 텔레메트리 */}
      <Section title="텔레메트리">
        {t ? (
          <>
            <Grid>
              <Field label="APM" value={t.apm?.toLocaleString() ?? "—"} warn={(t.apm ?? 0) > HUMAN_APM_CEILING} />
              <Field label="tap 비율" value={t.tapShare != null ? t.tapShare.toFixed(2) : "—"} />
              <Field label="max touch" value={t.maxTouch?.toString() ?? "—"} />
              <Field label="무기 종류" value={t.distinctWeapons?.toString() ?? "—"} />
              <Field label="간격 CV" value={t.intervalCv != null ? t.intervalCv.toFixed(3) : "—(PR6)"} warn={t.intervalCv != null && t.intervalCv < 0.15} />
              <Field label="기기/주사율" value={`${t.deviceClass ?? "—"} / ${t.refreshHz ?? "—"}Hz`} />
              <Field
                label="텔레↔점수 정합"
                value={t.score == null ? "세션 점수 없음" : scoreMismatch != null ? `${scoreMismatch}% 차이` : "—"}
                warn={scoreMismatch != null && scoreMismatch > 20}
              />
              <Field label="suspicious 플래그" value={t.suspicious ? "TRUE" : "false"} warn={t.suspicious} />
            </Grid>
            <ApmSparkline data={t.bucketApm} />
          </>
        ) : (
          <p className="text-sm text-zinc-500">연결된 텔레메트리 세션이 없습니다 (직접 제출 가능성).</p>
        )}
      </Section>

      {/* 이 유저의 다른 점수 */}
      {d.otherScores.length > 0 && (
        <Section title="이 유저의 다른 점수">
          <ul className="space-y-1 text-sm">
            {d.otherScores.map((o) => (
              <li key={o.id} className="flex gap-3 text-zinc-300">
                <span className="tabular-nums">{o.score.toLocaleString()}점</span>
                <span className="text-xs text-zinc-500">{STATUS_LABEL[o.reviewStatus] ?? o.reviewStatus}</span>
                <span className="text-[11px] text-zinc-600">{new Date(o.createdAt).toLocaleDateString("ko-KR")}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 조치 */}
      <Section title="조치">
        <IntegrityActions
          scoreId={d.scoreId}
          ownerId={d.ownerId}
          reviewStatus={d.reviewStatus}
          abuseStatus={d.abuseStatus}
        />
      </Section>
    </main>
  );
}

function apmToRate(apm: number | null | undefined): string {
  if (apm == null) return "—";
  return `${(apm / 60).toFixed(1)}타/초 (인간 지속 ≤~15)`;
}

/** 버킷별 apm 스파크라인 — 봇=천장 고정 직선 / 인간=들쭉날쭉. 인간 상한 참조선 포함. */
function ApmSparkline({ data }: { data: number[] }) {
  if (!data || data.length < 2) {
    return <p className="mt-3 text-xs text-zinc-500">버킷 데이터 부족(스파크라인 생략).</p>;
  }
  const W = 640, H = 120, pad = 4;
  const max = Math.max(...data, HUMAN_APM_CEILING * 1.2, 1);
  const stepX = (W - pad * 2) / (data.length - 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const pts = data.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ceilingY = y(HUMAN_APM_CEILING).toFixed(1);
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-white/10 bg-black/30">
        {/* 인간 지속 apm 상한 참조선 */}
        <line x1={pad} y1={ceilingY} x2={W - pad} y2={ceilingY} stroke="#f59e0b" strokeDasharray="4 3" strokeWidth="1" opacity="0.7" />
        <text x={pad + 2} y={Number(ceilingY) - 3} fill="#f59e0b" fontSize="10">
          인간 지속 상한 ~{HUMAN_APM_CEILING}
        </text>
        <polyline points={pts} fill="none" stroke="#ef4444" strokeWidth="1.5" />
      </svg>
      <p className="mt-1 text-[11px] text-zinc-500">
        버킷별 APM. 봇/매크로는 천장에 고정된 평평한 직선, 사람은 들쭉날쭉하며 대부분 주황 참조선 아래.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
      <h2 className="mb-2 text-sm font-semibold text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">{children}</div>;
}
function Field({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`text-sm ${warn ? "font-bold text-red-400" : "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
