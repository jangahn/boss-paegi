"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { Spinner } from "@/components/Spinner";
import { PaperPanel, Paperclip, DashedDivider } from "@/components/dossier";
import { perUnitPrice } from "@/lib/credit-products";
import { useCreditProducts } from "@/components/CreditProductsProvider";
import { log, errInfo } from "@/lib/log";
import { setSentryLastAction } from "@/lib/sentry-context";

/**
 * 생성권 충전 — 상품 4종(개당 단가 표시). 클릭 시 서버 checkout 으로 결제요청 →
 * 페이앱 결제창(payurl)으로 같은 탭 이동. price/credits 결정은 항상 서버 allowlist.
 * (회원 게이트는 proxy.ts 가 처리 — 비회원은 /login 으로.)
 */
export default function CreditsPage() {
  const products = useCreditProducts();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agePrompt, setAgePrompt] = useState<string | null>(null); // 14세 확인 대기 productId

  const confirmAgeAndBuy = async () => {
    const pid = agePrompt;
    if (!pid) return;
    setAgePrompt(null);
    await fetch("/api/account/confirm-age", { method: "POST" });
    void buy(pid);
  };

  const buy = async (productId: string) => {
    if (pending) return; // 중복 클릭 가드
    setSentryLastAction("purchase_start");
    setPending(productId);
    setError(null);
    try {
      const res = await fetch("/api/payapp/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        if (e.error === "payment_unavailable") {
          throw new Error("결제 기능이 잠시 비활성화돼 있어요. 잠시 후 다시 시도해주세요.");
        }
        if (
          e.error === "unauthorized" ||
          e.error === "member_only" ||
          e.error === "member_setup_required"
        ) {
          window.location.assign("/login?next=/credits");
          return;
        }
        if (e.error === "age_required") {
          setAgePrompt(productId);
          setPending(null);
          return;
        }
        throw new Error("결제 요청에 실패했어요. 잠시 후 다시 시도해주세요.");
      }
      const { payurl } = (await res.json()) as { payurl?: string };
      if (!payurl) throw new Error("결제창 주소를 받지 못했어요.");
      window.location.assign(payurl); // 같은 탭 리다이렉트
    } catch (e) {
      log.warn("credits.checkout_fail", errInfo(e));
      setError(e instanceof Error ? e.message : "결제 요청 실패");
      setPending(null);
    }
  };

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-md flex-col gap-5">
          <PaperPanel folded className="relative px-7 pb-6 pt-10">
            <Paperclip className="left-7" />
            <h1 className="font-bold text-3xl tracking-tight text-ink sm:text-4xl">생성권 충전</h1>
            <DashedDivider className="my-4" />
            <p className="text-sm text-zinc-500">
              캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.
            </p>
          </PaperPanel>

          <div className="flex flex-col gap-3">
            {products.map((p) => {
              const isPending = pending === p.productId;
              return (
                <button
                  key={p.productId}
                  type="button"
                  disabled={!!pending}
                  onClick={() => void buy(p.productId)}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper p-4 text-left shadow-sm transition hover:bg-foreground/5 disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-bold text-ink">{p.goodname}</p>
                    <p className="text-xs text-zinc-500">
                      생성권 {p.credits}개 · 개당 {perUnitPrice(p).toLocaleString()}원
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="whitespace-nowrap font-bold text-xl tabular-nums text-gold">
                      {p.price.toLocaleString()}원
                    </span>
                    {isPending && <Spinner className="h-4 w-4" />}
                  </div>
                </button>
              );
            })}
          </div>

          {error && (
            <p className="rounded-xl bg-red-500/10 p-3 text-sm text-red-500">{error}</p>
          )}
          {agePrompt && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <p className="text-amber-700 dark:text-amber-300">
                만 14세 이상만 결제할 수 있어요.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setAgePrompt(null)}
                  className="flex-1 rounded-lg border-2 border-line py-2 text-xs font-medium text-ink"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={() => void confirmAgeAndBuy()}
                  className="flex-1 rounded-lg bg-foreground py-2 text-xs font-semibold text-background"
                >
                  만 14세 이상입니다 · 계속
                </button>
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-zinc-400">
            카드 · 네이버페이로 결제할 수 있어요. 결제 완료 후 생성권이 자동으로 충전돼요.
          </p>
        </div>
      </main>
    </>
  );
}
