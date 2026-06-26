"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { ScoreConfig } from "@/lib/config/domains/score";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "형식 오류 — 라벨(1~20자)·한 줄 평(1~40자)을 모두 채워주세요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

function band(i: number): string {
  if (i >= 9) return "90,000+";
  return `${(i * 10000).toLocaleString()}~${((i + 1) * 10000 - 1).toLocaleString()}`;
}

export function ScoreConfigEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: ScoreConfig;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [grades, setGrades] = useState(initial.grades);
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setField = (i: number, key: "label" | "comment", v: string) =>
    setGrades((gs) => gs.map((g, gi) => (gi === i ? { ...g, [key]: v } : g)));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const value: ScoreConfig = {
        grades: grades.map((g) => ({ label: g.label.trim(), comment: g.comment.trim() })),
      };
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "score_config", value, baseVersion }),
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
    <div className="mt-5 flex flex-col gap-4">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요. 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다."}
        </p>
      )}

      {grades.map((g, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-xl border border-foreground/10 bg-paper-2 p-3">
          <span className="text-[11px] text-zinc-400">
            {i}단계 · {band(i)}점
          </span>
          <input
            value={g.label}
            maxLength={20}
            onChange={(e) => setField(i, "label", e.target.value)}
            placeholder="등급 라벨 (예: 폭주 차장)"
            className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm font-semibold outline-none focus:border-foreground/40"
          />
          <input
            value={g.comment}
            maxLength={40}
            onChange={(e) => setField(i, "comment", e.target.value)}
            placeholder="한 줄 평 (예: 이성을 살짝 놓았습니다)"
            className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
          />
        </div>
      ))}

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="sticky bottom-3 flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background shadow-lg transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
