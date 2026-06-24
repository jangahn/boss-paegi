"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { MarketingCopy } from "@/lib/config/domains/marketing";

type Section = { key: keyof MarketingCopy; label: string; fields: Field[] };
type Field = { k: string; label: string; max: number; multiline?: boolean };

const SECTIONS: Section[] = [
  {
    key: "home",
    label: "홈 화면",
    fields: [
      { k: "taglineLine1", label: "태그라인 1줄", max: 60 },
      { k: "taglineLine2", label: "태그라인 2줄", max: 60 },
      { k: "primaryCta", label: "주 버튼(만들기)", max: 30 },
      { k: "secondaryCta", label: "보조 버튼(바로 시작)", max: 30 },
      { k: "galleryLink", label: "갤러리 링크", max: 30 },
      { k: "leaderboardLink", label: "랭킹 링크", max: 30 },
      { k: "disclaimerLine1", label: "고지 1줄", max: 120, multiline: true },
      { k: "disclaimerLine2", label: "고지 2줄", max: 120, multiline: true },
    ],
  },
  {
    key: "signupBanner",
    label: "가입 배너 (갤러리)",
    fields: [
      { k: "nonmemberTitle", label: "비회원 제목", max: 80 },
      { k: "nonmemberSub", label: "비회원 설명", max: 200, multiline: true },
      { k: "memberEmptyTitle", label: "회원·0캐릭터 제목", max: 80 },
      { k: "memberEmptySub", label: "회원·0캐릭터 설명", max: 200, multiline: true },
    ],
  },
];

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "입력값이 형식에 맞지 않아요(길이 등). 빨간 칸을 확인하세요.",
  domain_not_ready: "아직 편집할 수 없는 영역이에요.",
  update_failed: "저장에 실패했어요. 잠시 후 다시 시도하세요.",
};

export function MarketingCopyEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: MarketingCopy;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<MarketingCopy>(initial);
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setField = (section: keyof MarketingCopy, k: string, v: string) => {
    setForm((f) => ({ ...f, [section]: { ...f[section], [k]: v } }));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "marketing_copy", value: form, baseVersion }),
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
    <div className="mt-5 flex flex-col gap-6">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 현재 코드 기본값으로 동작 중이에요. 아래에서 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다. 발행하면 이 값이 적용됩니다."}
        </p>
      )}

      {SECTIONS.map((sec) => (
        <fieldset key={String(sec.key)} className="flex flex-col gap-3">
          <legend className="text-sm font-semibold text-zinc-500">{sec.label}</legend>
          {sec.fields.map((fld) => {
            const val = (form[sec.key] as Record<string, string>)[fld.k] ?? "";
            return (
              <label key={fld.k} className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">
                  {fld.label} <span className="text-zinc-400">({val.length}/{fld.max})</span>
                </span>
                {fld.multiline ? (
                  <textarea
                    value={val}
                    maxLength={fld.max}
                    onChange={(e) => setField(sec.key, fld.k, e.target.value)}
                    className="h-16 w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
                  />
                ) : (
                  <input
                    value={val}
                    maxLength={fld.max}
                    onChange={(e) => setField(sec.key, fld.k, e.target.value)}
                    className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
                  />
                )}
              </label>
            );
          })}
        </fieldset>
      ))}

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>
      )}

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
