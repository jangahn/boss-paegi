"use client";

import { useState } from "react";
import { Spinner } from "@/components/Spinner";

type Found = { userId: string; displayName: string | null; genCredits: number };

export function CreditAdjustForm() {
  const [query, setQuery] = useState(""); // 이메일/닉네임 또는 userId
  const [found, setFound] = useState<Found | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    if (busy || !query.trim()) return;
    setBusy(true); setError(null); setMsg(null); setFound(null);
    try {
      const res = await fetch("/api/admin/lookup-member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      if (!res.ok) throw new Error("회원을 찾지 못했어요");
      setFound((await res.json()) as Found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const d = Number(delta);
    if (busy || !found || !Number.isInteger(d) || d === 0 || d < -100 || d > 100 || reason.trim().length < 5) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const res = await fetch("/api/admin/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: found.userId, delta: d, reason: reason.trim() }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string; before?: number; after?: number };
      if (!res.ok) throw new Error(out.error ?? "failed");
      setMsg(`완료: ${out.before} → ${out.after} 크레딧`);
      setFound((f) => (f ? { ...f, genCredits: out.after ?? f.genCredits } : f));
      setDelta(""); setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "적용 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-foreground/10 p-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이메일 / 닉네임 / userId"
          className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
        />
        <button type="button" onClick={() => void lookup()} disabled={busy} className="rounded-lg border border-foreground/20 px-3 py-2 text-sm font-medium disabled:opacity-40">
          조회
        </button>
      </div>

      {found && (
        <div className="rounded-lg bg-foreground/5 p-2 text-xs">
          <b>{found.displayName ?? "(닉네임 없음)"}</b> · 현재 {found.genCredits}개 · {found.userId.slice(0, 8)}
          <div className="mt-2 flex gap-2">
            <input
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="±delta(-100~100, ≠0)"
              className="w-32 rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 text-sm outline-none"
            />
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="사유(5~500자)"
              maxLength={500}
              className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 text-sm outline-none"
            />
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-40"
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}적용
            </button>
          </div>
        </div>
      )}

      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
