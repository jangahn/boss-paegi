"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { moveItem } from "@/lib/reorder";
import type { SiteContent, FaqItem, BusinessInfo } from "@/lib/config/domains/site-content";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "입력값이 형식에 맞지 않아요(길이·개수). 칸을 확인하세요.",
  domain_not_ready: "아직 편집할 수 없는 영역이에요.",
  update_failed: "저장에 실패했어요. 잠시 후 다시 시도하세요.",
};

const inputCls =
  "w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40";

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

  // 사업자정보 — 전부 빈 값이면 미설정(푸터 비노출)로 발행. mailOrderNo 만 빈 값 허용.
  const EMPTY_BIZ: BusinessInfo = {
    companyName: "", ownerName: "", bizRegNo: "", mailOrderNo: "", address: "", phone: "", email: "",
  };
  const [biz, setBiz] = useState<BusinessInfo>(initial.businessInfo ?? EMPTY_BIZ);
  const setB = (k: keyof BusinessInfo, v: string) => setBiz((b) => ({ ...b, [k]: v }));
  const bizFilled = Object.entries(biz).some(([, v]) => v.trim() !== "");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const value: SiteContent = {
      ...form,
      keywords,
      ...(bizFilled
        ? {
            businessInfo: {
              companyName: biz.companyName.trim(),
              ownerName: biz.ownerName.trim(),
              bizRegNo: biz.bizRegNo.trim(),
              mailOrderNo: biz.mailOrderNo.trim(),
              address: biz.address.trim(),
              phone: biz.phone.trim(),
              email: biz.email.trim(),
            },
          }
        : { businessInfo: undefined }),
    };
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
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-foreground/10 ui-surface p-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400">#{i + 1}</span>
              <input value={it.q} maxLength={200} onChange={(e) => setFaq(i, "q", e.target.value)} placeholder="질문" className="flex-1 rounded-lg border border-foreground/15 ui-field p-2 text-sm font-medium outline-none focus:border-foreground/40" />
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

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-zinc-500">
          사업자정보 <span className="text-zinc-400">· 채우면 전 페이지 푸터에 상시 노출(PG 심사 요건)</span>
        </span>
        <p className="rounded-lg bg-foreground/5 p-2 text-[11px] leading-relaxed text-zinc-500">
          카드사·카카오페이 입점 심사는 상호·사업자번호·대표자·주소·<b>유선전화(휴대폰 불가)</b>가
          메인·결제페이지에 노출되고 사업자등록증과 일치해야 해요. 통신판매업신고번호는 신고 완료 후 채우세요.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input value={biz.companyName} maxLength={60} onChange={(e) => setB("companyName", e.target.value)} placeholder="상호 (예: 제이엔에이)" className={inputCls} />
          <input value={biz.ownerName} maxLength={30} onChange={(e) => setB("ownerName", e.target.value)} placeholder="대표자명" className={inputCls} />
          <input value={biz.bizRegNo} maxLength={20} onChange={(e) => setB("bizRegNo", e.target.value)} placeholder="사업자등록번호" className={inputCls} />
          <input value={biz.mailOrderNo} maxLength={40} onChange={(e) => setB("mailOrderNo", e.target.value)} placeholder="통신판매업신고번호 (미신고 시 비움)" className={inputCls} />
          <input value={biz.address} maxLength={120} onChange={(e) => setB("address", e.target.value)} placeholder="사업장 주소" className={`${inputCls} col-span-2`} />
          <input value={biz.phone} maxLength={20} onChange={(e) => setB("phone", e.target.value)} placeholder="유선전화 (휴대폰 불가, 예: 070-…)" className={inputCls} />
          <input value={biz.email} maxLength={120} onChange={(e) => setB("email", e.target.value)} placeholder="고객센터 이메일" className={inputCls} />
        </div>
      </div>

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button type="button" onClick={() => void submit()} disabled={busy} className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40">
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
