"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { BusinessInfo, BusinessInfoConfig } from "@/lib/config/domains/business-info";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "입력값이 형식에 맞지 않아요 — 통신판매업신고번호 외에는 전부 채워야 발행돼요.",
  domain_not_ready: "아직 편집할 수 없는 영역이에요.",
  update_failed: "저장에 실패했어요. 잠시 후 다시 시도하세요.",
};

const inputCls =
  "w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40";

const EMPTY_BIZ: BusinessInfo = {
  companyName: "", ownerName: "", bizRegNo: "", mailOrderNo: "", address: "", phone: "", email: "",
};

export function BusinessInfoEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: BusinessInfoConfig;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [biz, setBiz] = useState<BusinessInfo>(initial.info ?? EMPTY_BIZ);
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setB = (k: keyof BusinessInfo, v: string) => setBiz((b) => ({ ...b, [k]: v }));
  // 전부 빈 값이면 미설정(푸터 비노출)으로 발행. mailOrderNo 만 빈 값 허용.
  const filled = Object.entries(biz).some(([, v]) => v.trim() !== "");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const value: BusinessInfoConfig = filled
      ? {
          info: {
            companyName: biz.companyName.trim(),
            ownerName: biz.ownerName.trim(),
            bizRegNo: biz.bizRegNo.trim(),
            mailOrderNo: biz.mailOrderNo.trim(),
            address: biz.address.trim(),
            phone: biz.phone.trim(),
            email: biz.email.trim(),
          },
        }
      : {};
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "business_info", value, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; version?: number; error?: string };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({
          ok: true,
          text: filled
            ? "발행됐어요. 다음 로드부터 전 페이지 푸터에 반영됩니다."
            : "발행됐어요(미설정) — 푸터가 노출되지 않습니다.",
        });
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
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값(미설정)으로 동작 중이에요. 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 푸터가 노출되지 않습니다. 채워서 발행하면 노출됩니다."}
        </p>
      )}
      <p className="rounded-lg bg-foreground/5 p-2 text-[11px] leading-relaxed text-zinc-500">
        카드사·카카오페이 입점 심사는 상호·사업자번호·대표자·주소·<b>유선전화(휴대폰 불가)</b>가
        메인·결제페이지에 노출되고 사업자등록증과 일치해야 해요. 통신판매업신고번호는 신고 완료 후 채우세요.
        채우면 전 페이지 푸터에 상시 노출되고, 전부 비우고 발행하면 푸터가 사라집니다.
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

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button type="button" onClick={() => void submit()} disabled={busy} className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40">
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
