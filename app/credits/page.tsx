"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { Spinner } from "@/components/Spinner";
import {
  CREDIT_PRODUCT_LIST,
  perUnitPrice,
  type CreditProductId,
} from "@/lib/credit-products";
import { log, errInfo } from "@/lib/log";

/**
 * 생성권 충전 — 상품 4종(개당 단가 표시). 클릭 시 서버 checkout 으로 결제요청 →
 * 페이앱 결제창(payurl)으로 같은 탭 이동. price/credits 결정은 항상 서버 allowlist.
 * (회원 게이트는 proxy.ts 가 처리 — 비회원은 /login 으로.)
 */
export default function CreditsPage() {
  const [pending, setPending] = useState<CreditProductId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buy = async (productId: CreditProductId) => {
    if (pending) return; // 중복 클릭 가드
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
          <div>
            <h1 className="text-2xl font-bold">생성권 충전</h1>
            <p className="mt-1 text-sm text-zinc-500">
              캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {CREDIT_PRODUCT_LIST.map((p) => {
              const isPending = pending === p.productId;
              return (
                <button
                  key={p.productId}
                  type="button"
                  disabled={!!pending}
                  onClick={() => void buy(p.productId as CreditProductId)}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/15 p-4 text-left transition hover:bg-foreground/5 disabled:opacity-50"
                >
                  <div>
                    <p className="text-base font-bold">생성권 {p.credits}개</p>
                    <p className="text-xs text-zinc-500">
                      개당 {perUnitPrice(p).toLocaleString()}원
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-extrabold tabular-nums">
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

          <p className="text-[11px] leading-relaxed text-zinc-400">
            카드 · 네이버페이로 결제할 수 있어요. 결제 완료 후 생성권이 자동으로 충전돼요.
          </p>
        </div>
      </main>
    </>
  );
}
