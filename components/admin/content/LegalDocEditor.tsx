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

/**
 * 법무문서 버전 편집기 — 상태머신: 편집 중(draft) ⇄ 예약(미래 시행) → 시행 중 → 지난.
 * Model A: '발행 전 문서(draft)'는 문서당 1개. 발행=draft 소비, 발행취소=예약본→draft 복원, 시행본=불변(새 버전으로 개정).
 * (상세 page 가 draft/versions 변동 시 key 로 remount → 마운트 초기화가 상태를 재설정한다.)
 */
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
  const today = kstToday();

  // 버전 분류
  const scheduled = versions.find((v) => (v.effective_date ?? "") > today) ?? null;
  const effective = versions
    .filter((v) => (v.effective_date ?? "") <= today)
    .sort(
      (a, b) =>
        (b.effective_date ?? "").localeCompare(a.effective_date ?? "") || b.version - a.version
    );
  const current = effective[0] ?? null;
  const past = effective.slice(1);
  const latest = versions.slice().sort((a, b) => b.version - a.version)[0] ?? null;

  // 편집 상태 — draft 가 있으면 자동 편집 진입.
  const [editing, setEditing] = useState<boolean>(!!draft);
  const [seedLabel, setSeedLabel] = useState<string>(draft ? "발행 전 문서" : "");
  const [title, setTitle] = useState(draft?.title ?? "");
  const [sections, setSections] = useState<LegalSection[]>(
    draft?.sections?.length ? draft.sections : [{ heading: "", body: "" }]
  );
  const [publicNote, setPublicNote] = useState(draft?.public_note ?? "");
  const [adminNote, setAdminNote] = useState(draft?.admin_note ?? "");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmUnpub, setConfirmUnpub] = useState(false);
  const [preview, setPreview] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setSec = (i: number, key: keyof LegalSection, v: string) =>
    setSections((ss) => ss.map((s, si) => (si === i ? { ...s, [key]: v } : s)));
  const addSec = () => setSections((ss) => [...ss, { heading: "", body: "" }]);
  const removeSec = (i: number) => setSections((ss) => ss.filter((_, si) => si !== i));
  const moveSec = (i: number, dir: -1 | 1) => setSections((ss) => moveItem(ss, i, dir));

  const norm: LegalSection[] = sections.map((s) => ({ heading: s.heading.trim(), body: s.body.trim() }));
  const validForm =
    title.trim().length > 0 &&
    norm.length > 0 &&
    norm.every((s) => s.heading.length > 0 && s.body.length > 0);
  const unchanged =
    !!latest &&
    latest.title === title.trim() &&
    JSON.stringify(latest.sections) === JSON.stringify(norm) &&
    (latest.public_note ?? "") === publicNote.trim() &&
    latest.effective_date === effectiveDate;

  // 발행 전 문서가 이미 있거나(draft) 예약본이 있으면 새 버전 시작 불가(Model A: 발행 전 문서 1개).
  const canStartNew = !draft && !scheduled;

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
      restored_draft?: boolean;
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

  const startNew = (from: LegalDocRow | null) => {
    setTitle(from?.title ?? "");
    setSections(from?.sections?.length ? from.sections.map((s) => ({ ...s })) : [{ heading: "", body: "" }]);
    setPublicNote("");
    setAdminNote("");
    setEffectiveDate(today);
    setSeedLabel(from ? `버전 ${from.version} 내용에서 시작한 새 문서` : "새 문서");
    setEditing(true);
    setPreview(false);
    setMsg(null);
  };

  const saveDraft = async () => {
    if (busy || !validForm) return;
    setBusy(true);
    setMsg(null);
    try {
      const { ok, out } = await post(draftBody());
      if (ok) {
        setMsg({ ok: true, text: "임시 저장했어요(비공개)." });
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
    setConfirmPublish(false);
    setMsg(null);
    try {
      const saved = await post(draftBody()); // 발행은 저장된 draft 스냅샷 → 선행 저장
      if (!saved.ok) {
        setMsg({ ok: false, text: saved.out.error ?? "저장 실패" });
        return;
      }
      const pub = await post({ action: "publish", docType, effectiveDate });
      if (pub.ok) {
        const future = effectiveDate > today;
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

  const unpublish = async () => {
    if (busy) return;
    setBusy(true);
    setConfirmUnpub(false);
    setMsg(null);
    try {
      const { ok, out } = await post({ action: "unpublish", docType });
      if (ok) {
        setMsg({
          ok: true,
          text: "예약 발행을 취소했어요. 발행 전 문서로 되돌렸어요 — 수정 후 다시 발행하세요.",
        });
        router.refresh();
      } else setMsg({ ok: false, text: out.error ?? "발행취소 실패" });
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40";
  const previewLink = (v: LegalDocRow) => `${DOC_PATH[docType]}?v=${v.id}`;

  return (
    <div className="mt-5 flex flex-col gap-5">
      {/* ── 버전 현황 ── */}
      <section className="rounded-2xl border border-foreground/10 p-4">
        <h3 className="text-sm font-semibold text-zinc-500">버전 현황 <span className="font-normal text-zinc-400">· 최신순</span></h3>
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {draft && (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5">
              <span><Badge tone="amber">편집 중</Badge> 발행 전 문서 <span className="text-xs text-zinc-400">· 아래에서 편집</span></span>
            </li>
          )}
          {scheduled && (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-2.5">
              <span><Badge tone="sky">예약</Badge> 버전 {scheduled.version} · <b>{scheduled.effective_date}</b> 시행 예정{scheduled.public_note ? ` · ${scheduled.public_note}` : ""}</span>
              <span className="flex items-center gap-2 text-xs">
                <Link href={previewLink(scheduled)} target="_blank" className="text-zinc-500 underline-offset-4 hover:text-foreground hover:underline">미리보기 →</Link>
                <button type="button" onClick={() => setConfirmUnpub(true)} disabled={busy} className="rounded-full border border-foreground/20 px-3 py-1 font-medium hover:bg-foreground/5 disabled:opacity-40">발행취소</button>
              </span>
            </li>
          )}
          {current && (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2.5">
              <span><Badge tone="emerald">시행 중</Badge> 버전 {current.version} · 시행일 {current.effective_date}{current.public_note ? ` · ${current.public_note}` : ""}</span>
              <span className="flex items-center gap-2 text-xs">
                <Link href={previewLink(current)} target="_blank" className="text-zinc-500 underline-offset-4 hover:text-foreground hover:underline">공개 보기 →</Link>
                <button
                  type="button"
                  onClick={() => startNew(current)}
                  disabled={busy || !canStartNew}
                  title={!canStartNew ? "발행 전 문서/예약본을 먼저 처리하세요" : undefined}
                  className="rounded-full border border-foreground/20 px-3 py-1 font-medium hover:bg-foreground/5 disabled:opacity-40"
                >새 버전으로 개정</button>
              </span>
            </li>
          )}
          {past.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-2.5 text-xs text-zinc-500">
              <span><Badge tone="zinc">지난</Badge> 버전 {v.version} · 시행일 {v.effective_date}{v.public_note ? ` · ${v.public_note}` : ""}</span>
              <Link href={previewLink(v)} target="_blank" className="underline-offset-4 hover:text-foreground hover:underline">공개 보기 →</Link>
            </li>
          ))}
          {!draft && !scheduled && !current && (
            <li className="px-2.5 text-xs text-zinc-400">아직 작성된 문서가 없어요.</li>
          )}
        </ul>

        {/* 편집 진입 CTA (편집 중이 아닐 때) */}
        {!editing && (
          <div className="mt-3">
            {scheduled ? (
              <p className="text-xs text-zinc-500">시행 예정본을 수정하려면 위에서 <b>발행취소</b>하세요(발행 전 문서로 돌아갑니다).</p>
            ) : canStartNew && current ? (
              <button type="button" onClick={() => startNew(current)} disabled={busy} className="rounded-full border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5 disabled:opacity-40">현재 시행본으로 새 버전 시작</button>
            ) : canStartNew ? (
              <button type="button" onClick={() => startNew(null)} disabled={busy} className="rounded-full border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5 disabled:opacity-40">새 문서 작성</button>
            ) : null}
          </div>
        )}
      </section>

      {/* ── 편집 영역(발행 전 문서) ── */}
      {editing && (
        <section className="flex flex-col gap-5 rounded-2xl border border-foreground/10 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">발행 전 문서 편집 <span className="font-normal text-zinc-400">· {seedLabel}</span></h3>
            {!draft && (
              <button type="button" onClick={() => { setEditing(false); setMsg(null); }} className="text-xs text-zinc-500 underline-offset-4 hover:text-foreground hover:underline">편집 취소</button>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">문서 제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={inputCls} />
          </label>

          <div className="flex flex-col gap-3">
            <span className="text-sm font-semibold text-zinc-500">섹션 <span className="text-zinc-400">· 제목 + 본문 (위→아래 표시 순서)</span></span>
            {sections.map((s, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-xl border border-foreground/10 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-400">#{i + 1}</span>
                  <input value={s.heading} onChange={(e) => setSec(i, "heading", e.target.value)} placeholder="섹션 제목 (예: 제1조 (목적))" maxLength={120} className="flex-1 rounded-lg border border-foreground/15 bg-transparent p-2 text-sm font-medium outline-none focus:border-foreground/40" />
                  <button type="button" onClick={() => moveSec(i, -1)} disabled={i === 0} aria-label="위로" className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30">▲</button>
                  <button type="button" onClick={() => moveSec(i, 1)} disabled={i === sections.length - 1} aria-label="아래로" className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30">▼</button>
                  <button type="button" onClick={() => removeSec(i)} disabled={sections.length <= 1} className="text-xs text-red-400 hover:underline disabled:opacity-30">삭제</button>
                </div>
                <textarea value={s.body} onChange={(e) => setSec(i, "body", e.target.value)} placeholder="본문 (개행 유지됨)" rows={Math.max(3, s.body.split("\n").length)} maxLength={20000} className={inputCls} />
              </div>
            ))}
            {sections.length < 50 && (
              <button type="button" onClick={addSec} className="rounded-xl border border-dashed border-foreground/20 py-2 text-sm text-zinc-500 hover:bg-foreground/5">+ 섹션 추가</button>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">시행일 <span className="text-zinc-400">· 오늘이면 즉시, 미래면 예약 발행(시행일에 자동 적용). 미래 예약본은 문서당 1개</span></span>
            <input type="date" value={effectiveDate} min={today} onChange={(e) => setEffectiveDate(e.target.value)} className="w-48 rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">공개 개정 사유 <span className="text-amber-600">· 공개 페이지에 노출됨</span></span>
            <input value={publicNote} onChange={(e) => setPublicNote(e.target.value)} maxLength={1000} placeholder="예: 국외이전 항목 추가 반영" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">내부 메모 <span className="text-zinc-400">· 비공개(운영자만)</span></span>
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
              임시 저장
            </button>
            <button type="button" onClick={() => setConfirmPublish(true)} disabled={busy || !validForm || unchanged} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40">
              발행
            </button>
          </div>
          {unchanged && <p className="text-center text-[11px] text-zinc-400">직전 발행본과 내용·시행일이 같아 발행할 변경이 없어요.</p>}
        </section>
      )}

      {!editing && msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      {confirmPublish && (
        <ModalShell onClose={() => setConfirmPublish(false)}>
          <h2 className="text-lg font-bold">{label}을 발행할까요?</h2>
          <p className="mt-2 text-sm text-zinc-500">
            시행일 <b>{effectiveDate}</b>
            {effectiveDate > today ? " (예약 — 시행일에 자동 적용)" : " (오늘 — 즉시 적용)"} 으로 새 버전이 발행됩니다. 발행 전 문서는 이 버전으로 확정·소비되며, 발행본은 이력으로 영구 보존돼요.
            {effectiveDate > today ? " 시행 전에는 '발행취소'로 되돌릴 수 있어요." : ""}
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmPublish(false)} className="flex-1 rounded-full border border-foreground/15 py-2.5 text-sm">취소</button>
            <button type="button" onClick={() => void publish()} className="flex-1 rounded-full bg-foreground py-2.5 text-sm font-semibold text-background">발행</button>
          </div>
        </ModalShell>
      )}

      {confirmUnpub && scheduled && (
        <ModalShell onClose={() => setConfirmUnpub(false)}>
          <h2 className="text-lg font-bold">예약 발행을 취소할까요?</h2>
          <p className="mt-2 text-sm text-zinc-500">
            버전 {scheduled.version}(<b>{scheduled.effective_date}</b> 시행 예정)의 예약을 취소합니다. 아직 시행 전이라 공개에 영향은 없으며, 내용은 <b>발행 전 문서</b>로 되돌아가 수정 후 다시 발행할 수 있어요.
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmUnpub(false)} className="flex-1 rounded-full border border-foreground/15 py-2.5 text-sm">닫기</button>
            <button type="button" onClick={() => void unpublish()} className="flex-1 rounded-full bg-foreground py-2.5 text-sm font-semibold text-background">발행취소</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "amber" | "sky" | "emerald" | "zinc" }) {
  const cls = {
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    zinc: "bg-foreground/10 text-zinc-500",
  }[tone];
  return <span className={`mr-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}
