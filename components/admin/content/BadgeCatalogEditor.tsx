"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { ModalShell } from "@/components/ModalShell";
import { moveItem } from "@/lib/reorder";
import type { BadgeCatalog } from "@/lib/config/domains/badges";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "형식 오류 — 라벨/설명 필수·임계값 정수·키 형식 확인. 카테고리는 7종 고정.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

type FamilyD = { key: string; name: string; emoji: string };
type BadgeD = {
  uid: string; // 세션 내 안정 식별자(slug 편집해도 유지 — React key·setter용)
  slug: string;
  familyKey: string;
  threshold: string;
  label: string;
  desc: string;
  active: boolean;
};
type Impact = Record<string, { users: number; scores: number }>;

export function BadgeCatalogEditor({
  initial,
  version,
  source,
  invalid,
  impact = {},
}: {
  initial: BadgeCatalog;
  version: number;
  source: "db" | "default";
  invalid: boolean;
  /** slug 별 과거 획득 영향도(user_badges·score_stats) — 삭제/키변경 경고용. */
  impact?: Impact;
}) {
  const router = useRouter();
  const uidc = useRef(0);
  const [fams, setFams] = useState<FamilyD[]>(initial.families.map((f) => ({ ...f })));
  const [badges, setBadges] = useState<BadgeD[]>(
    initial.badges.map((b, i) => ({ ...b, threshold: String(b.threshold), uid: `i${i}` }))
  );
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BadgeD | null>(null);

  const setFam = (key: string, k: "name" | "emoji", v: string) =>
    setFams((fs) => fs.map((f) => (f.key === key ? { ...f, [k]: v } : f)));
  const setBadge = (uid: string, k: keyof BadgeD, v: string | boolean) =>
    setBadges((bs) => bs.map((b) => (b.uid === uid ? { ...b, [k]: v } : b)));
  const addBadge = (familyKey: string) => {
    const taken = new Set(badges.map((b) => b.slug));
    let n = 1;
    let slug = `${familyKey}_c${n}`;
    while (taken.has(slug)) slug = `${familyKey}_c${++n}`;
    setBadges((bs) => [
      ...bs,
      { uid: `n${uidc.current++}`, slug, familyKey, threshold: "0", label: "", desc: "", active: true },
    ]);
  };
  const removeBadge = (uid: string) =>
    setBadges((bs) => bs.filter((b) => b.uid !== uid));
  // family 내 인접 스왑(전체 배열에서 같은 family 이웃과 교환) — 표시 순서 = 배열 순서.
  const moveBadge = (uid: string, dir: -1 | 1) =>
    setBadges((bs) => {
      const target = bs.find((b) => b.uid === uid);
      if (!target) return bs;
      const fam = bs.filter((b) => b.familyKey === target.familyKey);
      const fi = fam.findIndex((b) => b.uid === uid);
      const tj = fi + dir;
      if (tj < 0 || tj >= fam.length) return bs;
      const a = bs.findIndex((b) => b.uid === fam[fi].uid);
      const c = bs.findIndex((b) => b.uid === fam[tj].uid);
      return moveItem(bs, a, (c - a) as -1 | 1);
    });

  const askDelete = (b: BadgeD) => {
    const imp = impact[b.slug];
    if (imp && (imp.users > 0 || imp.scores > 0)) setPendingDelete(b);
    else removeBadge(b.uid);
  };

  const submit = async () => {
    if (busy) return;
    // 클라 검증: slug 비어있음·중복 차단(서버 zod 보강).
    const slugs = badges.map((b) => b.slug.trim());
    if (slugs.some((s) => !s)) {
      setMsg({ ok: false, text: "키(slug)가 비어있는 뱃지가 있어요." });
      return;
    }
    if (new Set(slugs).size !== slugs.length) {
      setMsg({ ok: false, text: "중복된 키(slug)가 있어요. 키는 유일해야 합니다." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const value: BadgeCatalog = {
        families: fams.map((f) => ({
          key: f.key as BadgeCatalog["families"][number]["key"],
          name: f.name.trim(),
          emoji: f.emoji.trim(),
        })),
        badges: badges.map((b) => ({
          slug: b.slug.trim(),
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

      {fams.map((f) => {
        const fBadges = badges.filter((b) => b.familyKey === f.key);
        return (
          <fieldset key={f.key} className="flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-paper-2 p-3">
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

            {fBadges.map((b, fi) => {
              const imp = impact[b.slug];
              const earned = imp && (imp.users > 0 || imp.scores > 0);
              return (
                <div key={b.uid} className="flex flex-col gap-1 rounded-lg bg-paper-2 p-2">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                      <input
                        type="checkbox"
                        checked={b.active}
                        onChange={(e) => setBadge(b.uid, "active", e.target.checked)}
                      />
                      활성
                    </label>
                    {earned && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        획득 {imp!.users}명
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveBadge(b.uid, -1)}
                        disabled={fi === 0}
                        aria-label="위로"
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => moveBadge(b.uid, 1)}
                        disabled={fi === fBadges.length - 1}
                        aria-label="아래로"
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        onClick={() => askDelete(b)}
                        className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-500/10"
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={b.slug}
                      maxLength={40}
                      onChange={(e) => setBadge(b.uid, "slug", e.target.value)}
                      placeholder="키(slug)"
                      className="w-32 rounded-lg border border-foreground/15 bg-transparent p-1.5 font-mono text-[11px] outline-none focus:border-foreground/40"
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      value={b.threshold}
                      onChange={(e) => setBadge(b.uid, "threshold", e.target.value)}
                      placeholder="임계값"
                      className="ml-auto w-24 rounded-lg border border-foreground/15 bg-transparent p-1.5 text-sm outline-none focus:border-foreground/40"
                    />
                  </div>
                  <input
                    value={b.label}
                    maxLength={40}
                    onChange={(e) => setBadge(b.uid, "label", e.target.value)}
                    placeholder="라벨 (예: 1,000점)"
                    className="rounded-lg border border-foreground/15 bg-transparent p-1.5 text-sm outline-none focus:border-foreground/40"
                  />
                  <input
                    value={b.desc}
                    maxLength={80}
                    onChange={(e) => setBadge(b.uid, "desc", e.target.value)}
                    placeholder="설명"
                    className="rounded-lg border border-foreground/15 bg-transparent p-1.5 text-xs outline-none focus:border-foreground/40"
                  />
                </div>
              );
            })}
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

      {pendingDelete && (
        <ModalShell onClose={() => setPendingDelete(null)}>
          <h2 className="text-lg font-bold">이미 획득된 뱃지예요</h2>
          <p className="mt-2 text-sm text-zinc-500">
            <b>{pendingDelete.label || pendingDelete.slug}</b> 은(는){" "}
            <b>{impact[pendingDelete.slug]?.users ?? 0}명</b>이 획득했고, 점수기록{" "}
            <b>{impact[pendingDelete.slug]?.scores ?? 0}건</b>에 남아 있어요. 삭제하면 과거 획득 표시에서
            <b> 조용히 숨겨집니다</b>(기록 자체는 보존). 계속할까요?
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="flex-1 rounded-full border border-foreground/15 py-2.5 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => {
                removeBadge(pendingDelete.uid);
                setPendingDelete(null);
              }}
              className="flex-1 rounded-full bg-red-500 py-2.5 text-sm font-semibold text-white"
            >
              삭제
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
