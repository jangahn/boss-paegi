"use client";

import { useState } from "react";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { SERVICE_NAME } from "@/lib/policy";

// 재동의는 약관·방침만(연령은 재확인하지 않음 — age_confirmed_at 유지).
const ITEMS = [
  { id: "terms", label: "이용약관에 동의합니다.", link: "/terms" },
  {
    id: "privacy",
    label: "개인정보처리방침 및 국외 이전(미국·싱가포르 등 클라우드/AI 사업자)에 동의합니다.",
    link: "/privacy",
  },
] as const;

export function ReconsentConsent({ next }: { next: string }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const all = ITEMS.every((i) => checked[i.id]);
  const toggle = (id: string) => setChecked((p) => ({ ...p, [id]: !p[id] }));

  const submit = async () => {
    if (busy || !all) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/account/reconsent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: true, privacy: true }),
      });
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (out.error === "account_deleted") {
        window.location.assign("/login?error=account_deleted");
        return;
      }
      setErr("처리에 실패했어요. 잠시 후 다시 시도해주세요.");
    } catch {
      setErr("네트워크 오류 — 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">{SERVICE_NAME} 재이용 안내</h1>
          <p className="mt-2 text-sm text-zinc-500">
            계정이 복구되었어요. 다시 이용하려면 현재 약관·개인정보처리방침에 동의해주세요.
          </p>
        </div>

        <div className="space-y-3">
          {ITEMS.map((item) => {
            const on = !!checked[item.id];
            return (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-xl border border-foreground/15 bg-paper-2 p-3"
              >
                <button
                  type="button"
                  onClick={() => toggle(item.id)}
                  aria-pressed={on}
                  className="flex flex-1 items-start gap-3 text-left"
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition ${
                      on
                        ? "border-foreground bg-foreground text-paper-2"
                        : "border-foreground/40 text-transparent"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  </span>
                  <span className="text-sm leading-relaxed">{item.label}</span>
                </button>
                <Link
                  href={item.link}
                  target="_blank"
                  className="shrink-0 text-xs text-zinc-500 underline underline-offset-2 hover:text-foreground"
                >
                  보기
                </Link>
              </div>
            );
          })}
        </div>

        {err && <p className="text-sm text-red-400">{err}</p>}

        <button
          type="button"
          disabled={!all || busy}
          onClick={() => void submit()}
          className="flex items-center justify-center gap-2 rounded-full bg-foreground py-4 font-semibold text-paper-2 transition disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy && <Spinner className="h-5 w-5" />}
          동의하고 계속
        </button>
      </div>
    </main>
  );
}
