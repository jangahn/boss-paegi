"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { ROLE_IDS, josaEul, josaEun, josaEuro, type RoleId } from "@/lib/roles";
import {
  RoleSurfaceDiagram,
  ROLE_FIELD_SURFACE,
} from "@/components/admin/content/diagram/SurfaceDiagram";
import type { RoleConfig, RoleFull } from "@/lib/config/domains/roles";

// 섹션 순서 = 실제 카드 위→아래(캐릭터 공유 카드 본문: 직급·소속·특이사항) +
// 점수 공유 카드·게임 종료 화면의 피격 반응. 카드에 안 나오는 시비 멘트(플레이 말풍선)는 맨 밑.
// 라벨 용어는 마케팅 카피 페이지(캐릭터 공유 카드/점수 공유 카드/게임 종료 화면/플레이 화면)와 일치.
type ArraySec = { kind: "array"; key: "ranks" | "departments" | "traits"; label: string };
type TieredSec = { kind: "tiered"; key: "reactions" | "taunts"; label: string };
type Section = ArraySec | TieredSec;

const SECTIONS: Section[] = [
  { kind: "array", key: "ranks", label: "직급 (캐릭터 공유 카드)" },
  { kind: "array", key: "departments", label: "소속 (캐릭터 공유 카드)" },
  { kind: "array", key: "traits", label: "특이사항 (캐릭터 공유 카드)" },
  { kind: "tiered", key: "reactions", label: "피격 반응 (점수 공유 카드·게임 종료 화면)" },
  { kind: "tiered", key: "taunts", label: "시비 멘트 (플레이 화면 말풍선)" },
];

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "형식 오류 — 각 점수 칸은 최소 1줄, 특이사항/직급/소속도 1개 이상 필요해요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

function band(i: number): string {
  if (i >= 9) return "90,000+";
  return `${(i * 10000).toLocaleString()}~${((i + 1) * 10000 - 1).toLocaleString()}`;
}

// 호칭 파생 조사형 미리보기 — 입력한 호칭으로 을/를·은/는·(으)로가 자동 파생됨을 즉시 확인.
function josaPreview(label: string): string {
  if (!label) return "—";
  return [
    label,
    `${label}${josaEul(label)}`,
    `${label}${josaEun(label)}`,
    `${label}${josaEuro(label)}`,
  ].join(" · ");
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
  const [focused, setFocused] = useState<string | null>(null);

  const r = form[role];
  const surfs = focused ? ROLE_FIELD_SURFACE[focused] ?? [] : [];
  const patch = (next: Partial<RoleFull>) =>
    setForm((f) => ({ ...f, [role]: { ...f[role], ...next } }));
  const setTier = (kind: "reactions" | "taunts", i: number, text: string) => {
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

  // 공통 textarea/input 스타일
  const inputCls =
    "w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40";

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
              rid === role ? "bg-foreground text-paper-2" : "bg-foreground/5 text-zinc-500"
            }`}
          >
            {form[rid].label || rid}
          </button>
        ))}
      </div>

      {/* 포커스한 항목이 들어가는 화면 미리보기 — 스크롤 시 비침 방지 불투명 밴드 */}
      <div className="sticky top-14 z-20 -mx-1 border-b border-foreground/10 bg-background px-1 pb-2 pt-2">
        {surfs.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-2">
            {surfs.map((s, i) => (
              <div key={`${s.surface}-${i}`} className="min-w-[200px] flex-1">
                <RoleSurfaceDiagram surface={s.surface} active={s.region} />
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-[11px] text-zinc-400">
            아래 입력칸을 선택하면 그 내용이 들어가는 화면이 여기 표시돼요.
          </p>
        )}
      </div>

      {/* 호칭 (상단 별도 블록) — 조사·갤러리 칩은 호칭에서 자동 파생 */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold text-zinc-500">호칭</legend>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">
            호칭 (예: 부장님) — 을/를·은/는·(으)로는 자동 파생
          </span>
          <input
            value={r.label}
            onFocus={() => setFocused("label")}
            onChange={(e) => patch({ label: e.target.value })}
            className={inputCls}
          />
        </label>
        <p className="rounded-lg bg-foreground/5 p-2 text-xs text-zinc-500">
          파생 · <b>{josaPreview(r.label)}</b>
        </p>
      </fieldset>

      {/* 본문/플레이 섹션 — 순서 = 카드 위→아래, 시비 멘트는 맨 밑 */}
      {SECTIONS.map((sec) =>
        sec.kind === "array" ? (
          <label key={sec.key} className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">{sec.label}</span>
            <textarea
              value={r[sec.key].join("\n")}
              onFocus={() => setFocused(sec.key)}
              onChange={(e) =>
                patch({ [sec.key]: e.target.value.split("\n") } as Partial<RoleFull>)
              }
              rows={Math.max(3, r[sec.key].length)}
              placeholder="한 줄에 하나씩"
              className={inputCls}
            />
          </label>
        ) : (
          <fieldset key={sec.key} className="flex flex-col gap-2">
            <legend className="text-sm font-semibold text-zinc-500">{sec.label}</legend>
            {r[sec.key].map((lines, i) => (
              <label key={i} className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-400">
                  {i}단계 · {band(i)}점
                </span>
                <textarea
                  value={lines.join("\n")}
                  onFocus={() => setFocused(sec.key)}
                  onChange={(e) => setTier(sec.key, i, e.target.value)}
                  rows={Math.max(2, lines.length)}
                  placeholder="한 줄에 하나씩"
                  className={inputCls}
                />
              </label>
            ))}
          </fieldset>
        )
      )}

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="sticky bottom-3 flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 shadow-lg transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행 (전체 롤)
      </button>
    </div>
  );
}
