"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { Spinner } from "@/components/Spinner";
import { PaperPanel, Paperclip, RubberStamp } from "@/components/dossier";

type DoneState = "checking" | "paid" | "pending" | "error";

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 15; // ~30s

function CreditsDoneInner() {
  const order = useSearchParams().get("order");
  const [state, setState] = useState<DoneState>(order ? "checking" : "error");
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    if (!order) return;
    let cancelled = false;
    let tries = 0;

    const poll = async () => {
      tries += 1;
      try {
        const res = await fetch(
          `/api/payapp/order-status?order=${encodeURIComponent(order)}`
        );
        if (res.ok) {
          const d = (await res.json()) as { status: string; credits: number };
          if (cancelled) return;
          if (d.status === "paid") {
            setCredits(d.credits);
            setState("paid");
            // 상단 nav 크레딧 배지(AccountMenu)는 충전 직후 이 페이지에선 옛값일 수 있으나,
            // 다음 라우트 이동 시 AppNav 재마운트로 갱신(genCredits 캐시 미저장 → 최신 재조회). [품질감사 low: 자가보정]
            return;
          }
          if (d.status === "canceled" || d.status === "failed") {
            setState("error");
            return;
          }
        }
      } catch {
        /* 폴링 일시 실패 — 계속 재시도 */
      }
      if (cancelled) return;
      if (tries >= MAX_POLLS) {
        setState("pending");
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [order]);

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <PaperPanel
          folded
          className="relative flex w-full max-w-sm flex-col items-center gap-4 px-7 pb-8 pt-12"
        >
          <Paperclip className="left-7" />
          {state === "checking" && (
            <>
              <Spinner className="h-8 w-8" />
              <h1 className="font-bold text-3xl tracking-tight text-ink">결제 확인 중…</h1>
              <p className="text-sm text-zinc-500">잠시만 기다려주세요.</p>
            </>
          )}
          {state === "paid" && (
            <>
              <span className="text-4xl" aria-hidden>
                🎉
              </span>
              <RubberStamp tone="stamp">
                <h1 className="font-bold text-3xl tracking-tight">충전 완료!</h1>
              </RubberStamp>
              <p className="text-sm text-zinc-500">
                생성권{" "}
                <span className="font-bold text-2xl text-gold">{credits}개</span>가
                충전됐어요.
              </p>
              <Link
                href="/generate"
                className="mt-2 rounded-lg bg-foreground px-6 py-3 text-sm font-semibold text-background transition hover:opacity-90"
              >
                캐릭터 만들러 가기
              </Link>
            </>
          )}
          {(state === "pending" || state === "error") && (
            <>
              <span className="text-4xl" aria-hidden>
                {state === "pending" ? "⏳" : "⚠️"}
              </span>
              <h1 className="font-bold text-3xl tracking-tight text-ink">
                {state === "pending" ? "결제 처리 중이에요" : "결제를 확인할 수 없어요"}
              </h1>
              <p className="text-sm leading-relaxed text-zinc-500">
                결제가 완료되었는데 화면이 갱신되지 않으면 다시 로그인 후 크레딧을
                확인해주세요.
              </p>
              <Link
                href="/credits"
                className="mt-2 text-sm font-semibold text-steel underline transition hover:text-stamp"
              >
                충전 화면으로
              </Link>
            </>
          )}
        </PaperPanel>
      </main>
    </>
  );
}

export default function CreditsDonePage() {
  return (
    <Suspense fallback={null}>
      <CreditsDoneInner />
    </Suspense>
  );
}
