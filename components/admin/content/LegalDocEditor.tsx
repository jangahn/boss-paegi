"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { ModalShell } from "@/components/ModalShell";
import { moveItem } from "@/lib/reorder";
import { LegalDocView } from "@/components/legal/LegalDocView";
import { DOC_PATH, type DocType, type LegalDocRow, type LegalSection } from "@/lib/legal/types";

function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

export function LegalDocEditor({
  docType,
  label,
  draft,
  versions,
}: {
  docType: DocType;
  label: string;
  draft: LegalDocRow | null;
  versions: LegalDocRow[];
}) {
  const router = useRouter();
  const latest = versions[0] ?? null;
  const seed = draft ?? latest;
  const [title, setTitle] = useState(seed?.title ?? "");
  const [sections, setSections] = useState<LegalSection[]>(
    seed?.sections?.length ? seed.sections : [{ heading: "", body: "" }]
  );
  const [publicNote, setPublicNote] = useState(draft?.public_note ?? "");
  const [adminNote, setAdminNote] = useState(draft?.admin_note ?? "");
  const [effectiveDate, setEffectiveDate] = useState(kstToday());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setSec = (i: number, key: keyof LegalSection, v: string) =>
    setSections((ss) => ss.map((s, si) => (si === i ? { ...s, [key]: v } : s)));
  const addSec = () => setSections((ss) => [...ss, { heading: "", body: "" }]);
  const removeSec = (i: number) => setSections((ss) => ss.filter((_, si) => si !== i));
  const moveSec = (i: number, dir: -1 | 1) => setSections((ss) => moveItem(ss, i, dir));

  // 제출용 정규화(trim) — RPC/zod 도 trim 하지만 무변경 비교를 위해 로컬에서도.
  const norm: LegalSection[] = sections.map((s) => ({
    heading: s.heading.trim(),
    body: s.body.trim(),
  }));
  const validForm =
    title.trim().length > 0 &&
    norm.length > 0 &&
    norm.every((s) => s.heading.length > 0 && s.body.length > 0);

  // 직전 발행본과 내용·시행일 모두 동일하면 발행 불필요(서버도 no_change 로 차단)
  const unchanged =
    !!latest &&
    latest.title === title.trim() &&
    JSON.stringify(latest.sections) === JSON.stringify(norm) &&
    (latest.public_note ?? "") === publicNote.trim() &&
    latest.effective_date === effectiveDate;

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/admin/legal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      version?: number;
      effective_date?: string;
      error?: string;
    };
    return { ok: res.ok && !!out.ok, out };
  };

  const draftBody = () => ({
    action: "save_draft",
    docType,
    title,
    sections: norm,
    publicNote: publicNote.trim() || null,
    adminNote: adminNote.trim() || null,
  });

  const saveDraft = async () => {
    if (busy || !validForm) return;
    setBusy(true);
    setMsg(null);
    try {
      const { ok, out } = await post(draftBody());
      if (ok) {
        setMsg({ ok: true, text: "초안을 저장했어요(비공개)." });
        router.refresh();
      } else setMsg({ ok: false, text: out.error ?? "저장 실패" });
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (busy || !validForm) return;
    setBusy(true);
    setConfirm(false);
    setMsg(null);
    try {
      // 1) 최신 편집을 draft 로 저장(발행은 저장된 draft 를 스냅샷)
      const saved = await post(draftBody());
      if (!saved.ok) {
        setMsg({ ok: false, text: saved.out.error ?? "저장 실패" });
        return;
      }
      // 2) 발행
      const pub = await post({ action: "publish", docType, effectiveDate });
      if (pub.ok) {
        const future = effectiveDate > kstToday();
        setMsg({
          ok: true,
          text: `발행됐어요 — 버전 ${pub.out.version}, 시행일 ${pub.out.effective_date}${
            future ? " (예약: 시행일에 자동 적용)" : ""
          }.`,
        });
        router.refresh();
      } else setMsg({ ok: false, text: pub.out.error ?? "발행 실패" });
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40";

  return (
    <div className="mt-5 flex flex-col gap-5">
      {!draft && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {latest
            ? "초안이 없어 최신 발행본을 불러왔어요. 수정 후 초안 저장/발행하세요."
            : "아직 초안·발행본이 없어요. 작성 후 초안 저장하세요."}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">문서 제목</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={inputCls} />
      </label>

      {/* 섹션 배열 */}
      <div className="flex flex-col gap-3">
        <span className="text-sm font-semibold text-zinc-500">
          섹션 <span className="text-zinc-400">· 제목 + 본문 (위→아래 표시 순서)</span>
        </span>
        {sections.map((s, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-foreground/10 p-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400">#{i + 1}</span>
              <input
                value={s.heading}
                onChange={(e) => setSec(i, "heading", e.target.value)}
                placeholder="섹션 제목 (예: 제1조 (목적))"
                maxLength={120}
                className="flex-1 rounded-lg border border-foreground/15 bg-transparent p-2 text-sm font-medium outline-none focus:border-foreground/40"
              />
              <button type="button" onClick={() => moveSec(i, -1)} disabled={i === 0} aria-label="위로" className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30">▲</button>
              <button type="button" onClick={() => moveSec(i, 1)} disabled={i === sections.length - 1} aria-label="아래로" className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30">▼</button>
              <button type="button" onClick={() => removeSec(i)} disabled={sections.length <= 1} className="text-xs text-red-400 hover:underline disabled:opacity-30">삭제</button>
            </div>
            <textarea
              value={s.body}
              onChange={(e) => setSec(i, "body", e.target.value)}
              placeholder="본문 (개행 유지됨)"
              rows={Math.max(3, s.body.split("\n").length)}
              maxLength={20000}
              className={inputCls}
            />
          </div>
        ))}
        {sections.length < 50 && (
          <button type="button" onClick={addSec} className="rounded-xl border border-dashed border-foreground/20 py-2 text-sm text-zinc-500 hover:bg-foreground/5">
            + 섹션 추가
          </button>
        )}
      </div>

      {/* 시행일 + 개정사유/메모 */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          시행일 <span className="text-zinc-400">· 오늘이면 즉시, 미래면 예약 발행(시행일에 자동 적용). 미래 예약본은 문서당 1개</span>
        </span>
        <input type="date" value={effectiveDate} min={kstToday()} onChange={(e) => setEffectiveDate(e.target.value)} className="w-48 rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          공개 개정 사유 <span className="text-amber-600">· 공개 페이지에 노출됨</span>
        </span>
        <input value={publicNote} onChange={(e) => setPublicNote(e.target.value)} maxLength={1000} placeholder="예: 국외이전 항목 추가 반영" className={inputCls} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          내부 메모 <span className="text-zinc-400">· 비공개(운영자만)</span>
        </span>
        <input value={adminNote} onChange={(e) => setAdminNote(e.target.value)} maxLength={2000} className={inputCls} />
      </label>

      <button type="button" onClick={() => setPreview((p) => !p)} className="self-start text-xs text-zinc-500 underline-offset-4 hover:text-foreground hover:underline">
        {preview ? "미리보기 닫기" : "공개 미리보기 열기"}
      </button>
      {preview && (
        <div className="rounded-2xl border border-foreground/10 p-4">
          <LegalDocView title={title || "(제목 없음)"} effectiveDate={effectiveDate} sections={norm.filter((s) => s.heading || s.body)} publicNote={publicNote.trim() || null} badge="upcoming" />
        </div>
      )}

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={() => void saveDraft()} disabled={busy || !validForm} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-foreground/20 py-3 text-sm font-semibold transition hover:bg-foreground/5 disabled:opacity-40">
          {busy && <Spinner className="h-4 w-4" />}
          초안 저장
        </button>
        <button type="button" onClick={() => setConfirm(true)} disabled={busy || !validForm || unchanged} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40">
          발행
        </button>
      </div>
      {unchanged && (
        <p className="text-center text-[11px] text-zinc-400">직전 발행본과 내용·시행일이 같아 발행할 변경이 없어요.</p>
      )}

      {/* 발행 이력 */}
      {versions.length > 0 && (
        <div className="border-t border-foreground/10 pt-4">
          <h3 className="text-sm font-semibold text-zinc-500">발행 이력</h3>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-zinc-500">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2">
                <span>버전 {v.version} · 시행일 {v.effective_date}{v.public_note ? ` · ${v.public_note}` : ""}</span>
                <Link href={`${DOC_PATH[docType]}?v=${v.id}`} className="underline-offset-4 hover:text-foreground hover:underline" target="_blank">공개 보기 →</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirm && (
        <ModalShell onClose={() => setConfirm(false)}>
          <h2 className="text-lg font-bold">{label}을 발행할까요?</h2>
          <p className="mt-2 text-sm text-zinc-500">
            시행일 <b>{effectiveDate}</b>
            {effectiveDate > kstToday() ? " (예약 — 시행일에 자동 적용)" : " (오늘 — 즉시 적용)"} 으로 새 버전이 발행되고 공개 페이지에 반영됩니다. 발행본은 이력으로 영구 보존돼요.
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirm(false)} className="flex-1 rounded-full border border-foreground/15 py-2.5 text-sm">취소</button>
            <button type="button" onClick={() => void publish()} className="flex-1 rounded-full bg-foreground py-2.5 text-sm font-semibold text-background">발행</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
