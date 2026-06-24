"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { BadgeCatalog } from "@/lib/config/domains/badges";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "형식 오류 — 라벨/설명 필수·임계값 정수. 카테고리는 7종 고정.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

type FamilyD = { key: string; name: string; emoji: string };
type BadgeD = {
  slug: string;
  familyKey: string;
  threshold: string;
  label: string;
  desc: string;
  active: boolean;
};

export function BadgeCatalogEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: BadgeCatalog;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [families, setFamilies] = useState<FamilyD[]>(
    initial.families.map((f) => ({ ...f }))
  );
  const [badges, setBadges] = useState<BadgeD[]>(
    initial.badges.map((b) => ({ ...b, threshold: String(b.threshold) }))
  );
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setFam = (key: string, k: "name" | "emoji", v: string) =>
    setFamilies((fs) => fs.map((f) => (f.key === key ? { ...f, [k]: v } : f)));
  const setBadge = (slug: string, k: keyof BadgeD, v: string | boolean) =>
    setBadges((bs) => bs.map((b) => (b.slug === slug ? { ...b, [k]: v } : b)));
  const addBadge = (familyKey: string) => {
    let n = 1;
    let slug = `${familyKey}_c${n}`;
    const taken = new Set(badges.map((b) => b.slug));
    while (taken.has(slug)) slug = `${familyKey}_c${++n}`;
    setBadges((bs) => [
      ...bs,
      { slug, familyKey, threshold: "0", label: "", desc: "", active: true },
    ]);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const value: BadgeCatalog = {
        families: families.map((f) => ({ key: f.key as BadgeCatalog["families"][number]["key"], name: f.name.trim(), emoji: f.emoji.trim() })),
        badges: badges.map((b) => ({
          slug: b.slug,
          familyKey: b.familyKey as BadgeCatalog["badges"][number]["familyKey"],
          threshold: Number(b.threshold),
          label: b.label.trim(),
          desc: b.desc.trim(),
          active: b.active,
        })),
      };
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "badge_catalog", value, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
      };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 신규 획득 판정부터 반영됩니다." });
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
    <div className="mt-5 flex flex-col gap-6">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다."}
        </p>
      )}

      {families.map((f) => {
        const fBadges = badges.filter((b) => b.familyKey === f.key);
        return (
          <fieldset key={f.key} className="flex flex-col gap-2 rounded-2xl border border-foreground/10 p-3">
            <div className="flex items-end gap-2">
              <label className="flex w-16 flex-col gap-0.5">
                <span className="text-[11px] text-zinc-400">이모지</span>
                <input
                  value={f.emoji}
                  maxLength={8}
                  onChange={(e) => setFam(f.key, "emoji", e.target.value)}
                  className="rounded-lg border border-foreground/15 bg-transparent p-2 text-center text-sm outline-none focus:border-foreground/40"
                />
              </label>
              <label className="flex flex-1 flex-col gap-0.5">
                <span className="text-[11px] text-zinc-400">카테고리 이름 ({f.key})</span>
                <input
                  value={f.name}
                  maxLength={20}
                  onChange={(e) => setFam(f.key, "name", e.target.value)}
                  className="rounded-lg border border-foreground/15 bg-transparent p-2 text-sm font-semibold outline-none focus:border-foreground/40"
                />
              </label>
            </div>

            {fBadges.map((b) => (
              <div key={b.slug} className="flex flex-col gap-1 rounded-lg bg-foreground/5 p-2">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                    <input
                      type="checkbox"
                      checked={b.active}
                      onChange={(e) => setBadge(b.slug, "active", e.target.checked)}
                    />
                    활성
                  </label>
                  <span className="text-[10px] text-zinc-400">{b.slug}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={b.threshold}
                    onChange={(e) => setBadge(b.slug, "threshold", e.target.value)}
                    placeholder="임계값"
                    className="ml-auto w-24 rounded-lg border border-foreground/15 bg-transparent p-1.5 text-sm outline-none focus:border-foreground/40"
                  />
                </div>
                <input
                  value={b.label}
                  maxLength={40}
                  onChange={(e) => setBadge(b.slug, "label", e.target.value)}
                  placeholder="라벨 (예: 1,000점)"
                  className="rounded-lg border border-foreground/15 bg-transparent p-1.5 text-sm outline-none focus:border-foreground/40"
                />
                <input
                  value={b.desc}
                  maxLength={80}
                  onChange={(e) => setBadge(b.slug, "desc", e.target.value)}
                  placeholder="설명"
                  className="rounded-lg border border-foreground/15 bg-transparent p-1.5 text-xs outline-none focus:border-foreground/40"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => addBadge(f.key)}
              className="rounded-lg border border-dashed border-foreground/20 py-1.5 text-xs text-zinc-500 hover:bg-foreground/5"
            >
              + {f.name} 뱃지 추가
            </button>
          </fieldset>
        );
      })}

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
