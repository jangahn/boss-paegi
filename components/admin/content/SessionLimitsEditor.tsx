"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { SessionLimits } from "@/lib/config/domains/session";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "범위를 벗어났어요. 안내된 최소/최대 안에서 정수로 입력하세요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

export function SessionLimitsEditor({
  initial,
  version,
  source,
  invalid,
  maxPlaySeconds,
  maxScoreHard,
}: {
  initial: SessionLimits;
  version: number;
  source: "db" | "default";
  invalid: boolean;
  maxPlaySeconds: number;
  maxScoreHard: number;
}) {
  const router = useRouter();
  const [playSec, setPlaySec] = useState(String(initial.maxPlaySeconds));
  const [score, setScore] = useState(String(initial.maxScore));
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const value = { maxPlaySeconds: Number(playSec), maxScore: Number(score) };
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "session_limits", value, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
      };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 다음 판부터 반영됩니다." });
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
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값(무제한 수준)으로 동작 중이에요."
            : "아직 발행된 적 없어 기본값(사실상 무제한)을 보여줍니다."}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          최대 플레이 시간(초) <span className="text-zinc-400">· 5 ~ {maxPlaySeconds}</span>
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={5}
          max={maxPlaySeconds}
          value={playSec}
          onChange={(e) => setPlaySec(e.target.value)}
          className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
        />
        <span className="text-[11px] text-zinc-400">예: 90 = 90초 후 자동 종료</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          최대 점수 <span className="text-zinc-400">· 100 ~ {maxScoreHard.toLocaleString()}</span>
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={100}
          max={maxScoreHard}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
        />
        <span className="text-[11px] text-zinc-400">이 점수에 도달하면 자동 종료</span>
      </label>

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
