"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { moveItem } from "@/lib/reorder";
import type { SiteContent, FaqItem } from "@/lib/config/domains/site-content";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "입력값이 형식에 맞지 않아요(길이·개수). 칸을 확인하세요.",
  domain_not_ready: "아직 편집할 수 없는 영역이에요.",
  update_failed: "저장에 실패했어요. 잠시 후 다시 시도하세요.",
};

const inputCls =
  "w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40";

export function SiteContentEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: SiteContent;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<SiteContent>(initial);
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof SiteContent>(k: K, v: SiteContent[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setFaq = (i: number, key: keyof FaqItem, v: string) =>
    setForm((f) => ({ ...f, faq: f.faq.map((it, ii) => (ii === i ? { ...it, [key]: v } : it)) }));
  const addFaq = () => setForm((f) => ({ ...f, faq: [...f.faq, { q: "", a: "" }] }));
  const removeFaq = (i: number) => setForm((f) => ({ ...f, faq: f.faq.filter((_, ii) => ii !== i) }));
  const moveFaq = (i: number, dir: -1 | 1) => setForm((f) => ({ ...f, faq: moveItem(f.faq, i, dir) }));

  // keywords 는 쉼표/개행 구분 텍스트로 편집 → 배열로 정규화.
  const [kwText, setKwText] = useState(initial.keywords.join(", "));
  const keywords = kwText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const value: SiteContent = { ...form, keywords };
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "site_content", value, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; version?: number; error?: string };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 다음 로드부터 홈·/faq·검색 메타에 반영됩니다." });
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
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요. 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다. 발행하면 이 값이 적용됩니다."}
        </p>
      )}
      <p className="rounded-lg bg-foreground/5 p-2 text-[11px] leading-relaxed text-zinc-500">
        💡 이 값들이 홈 소개 섹션·<b>/faq</b>·검색 title/description·구조화 데이터(JSON-LD)·llms.txt·공유 이미지로 자동 반영됩니다. 발행 후 다음 로드부터(공유 이미지는 최대 1시간 캐시).
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          한 줄 정의 <span className="text-zinc-400">({form.definition.length}/200) · 검색·AI 요약·OG 공통</span>
        </span>
        <textarea value={form.definition} maxLength={200} onChange={(e) => set("definition", e.target.value)} className={`${inputCls} h-16`} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          검색 설명(meta description) <span className="text-zinc-400">({form.metaDescription.length}/200)</span>
        </span>
        <textarea value={form.metaDescription} maxLength={200} onChange={(e) => set("metaDescription", e.target.value)} className={`${inputCls} h-20`} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          키워드 <span className="text-zinc-400">· 쉼표/줄바꿈 구분, 최대 20개 ({keywords.length})</span>
        </span>
        <textarea value={kwText} onChange={(e) => setKwText(e.target.value)} placeholder="부장님 패기, 스트레스 해소 게임, …" className={`${inputCls} h-16`} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          소개 문단 <span className="text-zinc-400">({form.intro.length}/1000) · 홈 섹션·/faq</span>
        </span>
        <textarea value={form.intro} maxLength={1000} onChange={(e) => set("intro", e.target.value)} className={`${inputCls} h-28`} />
      </label>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-semibold text-zinc-500">
          자주 묻는 질문(FAQ) <span className="text-zinc-400">· {form.faq.length}개 (위→아래 표시 순서)</span>
        </span>
        {form.faq.map((it, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-foreground/10 p-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400">#{i + 1}</span>
              <input value={it.q} maxLength={200} onChange={(e) => setFaq(i, "q", e.target.value)} placeholder="질문" className="flex-1 rounded-lg border border-foreground/15 bg-transparent p-2 text-sm font-medium outline-none focus:border-foreground/40" />
              <button type="button" onClick={() => moveFaq(i, -1)} disabled={i === 0} aria-label="위로" className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30">▲</button>
              <button type="button" onClick={() => moveFaq(i, 1)} disabled={i === form.faq.length - 1} aria-label="아래로" className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30">▼</button>
              <button type="button" onClick={() => removeFaq(i)} disabled={form.faq.length <= 1} className="text-xs text-red-400 hover:underline disabled:opacity-30">삭제</button>
            </div>
            <textarea value={it.a} maxLength={2000} onChange={(e) => setFaq(i, "a", e.target.value)} placeholder="답변" rows={Math.max(2, it.a.split("\n").length)} className={inputCls} />
          </div>
        ))}
        {form.faq.length < 30 && (
          <button type="button" onClick={addFaq} className="rounded-xl border border-dashed border-foreground/20 py-2 text-sm text-zinc-500 hover:bg-foreground/5">+ 질문 추가</button>
        )}
      </div>

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button type="button" onClick={() => void submit()} disabled={busy} className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40">
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
