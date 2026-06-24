"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { ROLE_IDS, defaultSafeHook, type RoleId } from "@/lib/roles";
import { SurfaceDiagram } from "@/components/admin/content/diagram/SurfaceDiagram";
import type { RoleConfig, RoleFull } from "@/lib/config/domains/roles";

const TIERED = [
  { key: "reactions", label: "피격 반응 (게임오버·공유 보고서)" },
  { key: "taunts", label: "시비 멘트 (플레이 중 말풍선)" },
  { key: "ogLines", label: "공유 OG 후킹 문구 (조사 포함 완성형)" },
] as const;
const ARRAYS = [
  { key: "traits", label: "인사기록 특이사항" },
  { key: "ranks", label: "인사기록 직급" },
  { key: "departments", label: "인사기록 소속" },
] as const;
const STRINGS = [
  { key: "label", label: "호칭 (예: 부장님) — 을/를·은/는·갤러리 칩은 자동 파생" },
] as const;

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "형식 오류 — 각 점수 칸은 최소 1줄, 특이사항/직급/소속도 1개 이상 필요해요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

function band(i: number): string {
  if (i >= 9) return "90,000+";
  return `${(i * 10000).toLocaleString()}~${((i + 1) * 10000 - 1).toLocaleString()}`;
}

// 제출 전 정리 — 배열 항목 trim + 빈 줄 제거, 문자열 trim.
function clean(cfg: RoleConfig): RoleConfig {
  const cleanArr = (a: string[]) => a.map((s) => s.trim()).filter(Boolean);
  const out = {} as RoleConfig;
  for (const r of ROLE_IDS) {
    const v = cfg[r];
    out[r] = {
      reactions: v.reactions.map(cleanArr),
      taunts: v.taunts.map(cleanArr),
      ogLines: v.ogLines.map(cleanArr),
      traits: cleanArr(v.traits),
      ranks: cleanArr(v.ranks),
      departments: cleanArr(v.departments),
      label: v.label.trim(),
    };
  }
  return out;
}

export function RoleContentEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: RoleConfig;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<RoleConfig>(initial);
  const [role, setRole] = useState<RoleId>("boss");
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const r = form[role];
  const patch = (next: Partial<RoleFull>) =>
    setForm((f) => ({ ...f, [role]: { ...f[role], ...next } }));
  const setTier = (kind: "reactions" | "taunts" | "ogLines", i: number, text: string) => {
    const arr = r[kind].map((t, ti) => (ti === i ? text.split("\n") : t));
    patch({ [kind]: arr } as Partial<RoleFull>);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "role_content", value: clean(form), baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
      };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 다음 로드부터 반영됩니다." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: ERR_KO[out.error ?? ""] ?? out.error ?? "저장 실패" });
      }
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-5">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요. 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다."}
        </p>
      )}

      {/* 롤 탭 */}
      <div className="flex flex-wrap gap-1">
        {ROLE_IDS.map((rid) => (
          <button
            key={rid}
            type="button"
            onClick={() => setRole(rid)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              rid === role ? "bg-foreground text-background" : "bg-foreground/5 text-zinc-500"
            }`}
          >
            {form[rid].label || rid}
          </button>
        ))}
      </div>

      {/* 문자열 필드 + josa 미리보기 */}
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold text-zinc-500">호칭·조사</legend>
        {STRINGS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">{f.label}</span>
            <input
              value={r[f.key]}
              onChange={(e) => patch({ [f.key]: e.target.value } as Partial<RoleFull>)}
              className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
            />
          </label>
        ))}
        <p className="rounded-lg bg-foreground/5 p-2 text-xs text-zinc-500">
          미리보기 · 공유후킹: <b>{r.label ? defaultSafeHook(r.label) : "—"}</b> · OG예: {r.ogLines[3]?.[0] ?? "—"}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <SurfaceDiagram surface="doll" />
          <SurfaceDiagram surface="share" />
        </div>
        <p className="text-[11px] text-zinc-400">
          이 롤의 호칭·피격 반응·인사기록은 위 화면(인사기록 카드·결과 보고서)에 들어가요.
        </p>
      </fieldset>

      {/* tiered (10단계) */}
      {TIERED.map((t) => (
        <fieldset key={t.key} className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-zinc-500">{t.label}</legend>
          {r[t.key].map((lines, i) => (
            <label key={i} className="flex flex-col gap-0.5">
              <span className="text-[11px] text-zinc-400">
                {i}단계 · {band(i)}점
              </span>
              <textarea
                value={lines.join("\n")}
                onChange={(e) => setTier(t.key, i, e.target.value)}
                rows={Math.max(2, lines.length)}
                placeholder="한 줄에 하나씩"
                className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
              />
            </label>
          ))}
        </fieldset>
      ))}

      {/* 배열 필드 */}
      {ARRAYS.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">{f.label}</span>
          <textarea
            value={r[f.key].join("\n")}
            onChange={(e) => patch({ [f.key]: e.target.value.split("\n") } as Partial<RoleFull>)}
            rows={Math.max(3, r[f.key].length)}
            placeholder="한 줄에 하나씩"
            className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
          />
        </label>
      ))}

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="sticky bottom-3 flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background shadow-lg transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행 (전체 롤)
      </button>
    </div>
  );
}
