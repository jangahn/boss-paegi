"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { ModalShell } from "@/components/ModalShell";
import { LegalDocView } from "@/components/legal/LegalDocView";
import { useBfcacheReset } from "@/lib/use-bfcache-reset";
import { SERVICE_NAME } from "@/lib/policy";
import { createClient } from "@/lib/supabase/client";
import { getMyProfile, writeCachedProfile, clearProfileCache } from "@/lib/profile";
import { clearSentryIdentity } from "@/lib/sentry-context";
import type { ConsentItem } from "@/lib/consent";
import type { LegalSection } from "@/lib/legal/types";

/** /consent 서버가 내려주는 약관/방침 전문(인라인 "보기" 모달용). */
export type LegalDocLite = {
  title: string;
  sections: LegalSection[];
  version: number;
  effectiveDate: string | null;
};

const ITEM_LABEL: Record<ConsentItem, string> = {
  age: "본인은 만 14세 이상입니다. (만 14세 미만은 이용할 수 없습니다.)",
  terms: "이용약관에 동의합니다.",
  privacy:
    "개인정보처리방침 및 국외 이전(미국·싱가포르 등 클라우드/AI 사업자)에 동의합니다.",
};

/**
 * 통합 동의 폼 — `/consent` 가 서버에서 산출한 필요 항목(items)만 표시.
 * 약관/방침 "보기"는 **인라인 모달**(네비게이션 없음 → 체크 상태 보존, 모바일 인앱브라우저 안전).
 * [동의하고 시작] 완료 시 비로소 로그인(member). [로그아웃하고 다시 로그인]은 서버 cookie clear + signOut → /login.
 */
export function ConsentForm({
  items,
  next,
  docs,
}: {
  items: ConsentItem[];
  next: string;
  docs: Partial<Record<ConsentItem, LegalDocLite | null>>;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<null | "submit" | "switch">(null);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ConsentItem | null>(null);
  // 같은 탭 이동 → 뒤로가기(bfcache) 시 멈춘 스피너 해제.
  useBfcacheReset(() => setBusy(null));

  const all = items.every((i) => checked[i]);
  const toggle = (id: ConsentItem) => setChecked((p) => ({ ...p, [id]: !p[id] }));

  const submit = async () => {
    if (busy || !all) return;
    setBusy("submit");
    setErr(null);
    try {
      const payload: Record<string, boolean> = {};
      items.forEach((i) => (payload[i] = true));
      const res = await fetch("/api/account/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        // I3: stale consent_incomplete 캐시 제거 → 신선 member 캐시 확정 → 이동(ConsentGuard 루프 방지).
        clearProfileCache();
        try {
          const p = await getMyProfile();
          if (p) writeCachedProfile(p.id, p);
        } catch {
          /* refetch 실패해도 캐시는 비워졌으니 다음 진입에 신선 조회 */
        }
        router.replace(next);
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (out.error === "account_deleted") {
        window.location.assign("/login?error=account_deleted");
        return;
      }
      setErr("처리에 실패했어요. 잠시 후 다시 시도해주세요.");
      setBusy(null);
    } catch {
      setErr("네트워크 오류 — 다시 시도해주세요.");
      setBusy(null);
    }
  };

  const switchAccount = async () => {
    if (busy) return;
    setBusy("switch");
    setErr(null);
    try {
      // 서버: httpOnly MIGRATE_COOKIE clear + 세션 로그아웃(#1/I2).
      await fetch("/api/account/consent/cancel", { method: "POST" }).catch(() => {});
      clearProfileCache();
      clearSentryIdentity();
      try {
        await createClient().auth.signOut();
      } catch {
        /* 서버에서 이미 로그아웃됐을 수 있음 */
      }
      window.location.href = "/login";
    } catch {
      setBusy(null);
    }
  };

  const viewingDoc = viewing ? docs[viewing] : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">{SERVICE_NAME}</h1>
          <p className="mt-2 text-sm text-zinc-500">
            로그인을 마치려면 아래에 동의해주세요. 동의를 완료해야 로그인됩니다.
          </p>
        </div>

        <div className="space-y-3">
          {items.map((id) => {
            const on = !!checked[id];
            const hasDoc = !!docs[id];
            return (
              <div
                key={id}
                className="flex items-start gap-3 rounded-xl border border-foreground/15 ui-surface p-3"
              >
                <button
                  type="button"
                  onClick={() => toggle(id)}
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
                  <span className="text-sm leading-relaxed">{ITEM_LABEL[id]}</span>
                </button>
                {hasDoc && (
                  <button
                    type="button"
                    onClick={() => setViewing(id)}
                    className="shrink-0 text-xs text-zinc-500 underline underline-offset-2 hover:text-foreground"
                  >
                    보기
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {err && <p className="text-sm text-red-400">{err}</p>}

        <button
          type="button"
          disabled={!all || busy !== null}
          onClick={() => void submit()}
          className="flex items-center justify-center gap-2 rounded-full bg-foreground py-4 font-semibold text-paper-2 transition disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy === "submit" && <Spinner className="h-5 w-5" />}
          동의하고 시작
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void switchAccount()}
          className="flex items-center justify-center gap-2 text-center text-sm text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline disabled:opacity-40"
        >
          {busy === "switch" && <Spinner className="h-4 w-4" />}
          로그아웃하고 다시 로그인
        </button>
      </div>

      {viewing && viewingDoc && (
        <ModalShell wide onClose={() => setViewing(null)}>
          <div className="mb-1 flex justify-end">
            <button
              type="button"
              onClick={() => setViewing(null)}
              aria-label="닫기"
              className="text-lg leading-none text-zinc-500 hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <LegalDocView
              title={viewingDoc.title}
              sections={viewingDoc.sections}
              version={viewingDoc.version}
              effectiveDate={viewingDoc.effectiveDate}
              badge="current"
            />
          </div>
          <button
            type="button"
            onClick={() => setViewing(null)}
            className="mt-4 w-full rounded-full border border-foreground/15 ui-surface py-2.5 text-sm font-medium transition hover:bg-foreground/5"
          >
            닫기
          </button>
        </ModalShell>
      )}
    </main>
  );
}
