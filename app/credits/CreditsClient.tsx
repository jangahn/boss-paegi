"use client";

import { useState } from "react";
import { Spinner } from "@/components/Spinner";
import { useBfcacheReset } from "@/lib/use-bfcache-reset";
import { perUnitPrice, type CreditProduct } from "@/lib/credit-products";
import { PUBLIC_ENV } from "@/lib/env";
import { paymentChannels, type PayChannelMethod, type PayMode } from "@/lib/pay-channels";
import { log, errInfo } from "@/lib/log";
import { setSentryLastAction } from "@/lib/sentry-context";

/**
 * 생성권 충전 — 상품 4종(개당 단가 표시) + 결제수단 선택(카드/토스페이/카카오페이).
 * 클릭 시 서버 checkout 으로 주문 생성(price/credits 는 항상 서버 allowlist) →
 * 포트원 브라우저 SDK `requestPayment` 로 결제창 호출. 모바일은 redirectUrl 리다이렉트
 * 복귀(/credits/done), PC(iframe)는 프로미스 반환 후 같은 경로로 이동해 폴링 확인.
 * payMode 는 서버 판정값(심사 계정=test) — 수단 목록 구성용이며, 결제창 채널키는
 * checkout **응답의 서버 결정값**만 사용(클라 조작해도 서버가 계정 기반 재판정).
 */
export function CreditsClient({
  products,
  enabled,
  comingSoon,
  payMode,
}: {
  products: CreditProduct[];
  enabled: boolean;
  comingSoon: { title: string; body: string };
  payMode: PayMode;
}) {
  const channels = paymentChannels(payMode);
  const [method, setMethod] = useState<PayChannelMethod | null>(channels[0]?.method ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 법적 동의는 서버 proxy 가 렌더 전 게이트(미동의면 여기 안 옴). 진입 시 클라 동의 가드 불필요.
  // 결제창(리다이렉트) 갔다가 뒤로가기 → bfcache 복원 시 멈춘 스피너(pending) 해제.
  useBfcacheReset(() => setPending(null));

  const buy = async (productId: string) => {
    if (pending) return; // 중복 클릭 가드
    const channel = channels.find((c) => c.method === method);
    if (!channel) {
      setError("결제 수단을 선택해주세요.");
      return;
    }
    setSentryLastAction("purchase_start");
    setPending(productId);
    setError(null);
    try {
      const res = await fetch("/api/pay/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // method/wantLive 는 힌트일 뿐 — 채널키·모드는 서버가 계정 기반으로 재판정해 응답.
        body: JSON.stringify({ productId, method: channel.method, wantLive: payMode === "live" }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        if (e.error === "payment_unavailable") {
          throw new Error("결제 기능이 잠시 비활성화돼 있어요. 잠시 후 다시 시도해주세요.");
        }
        if (e.error === "rate_limited") {
          throw new Error("결제 요청이 너무 잦아요. 잠시 후 다시 시도해주세요.");
        }
        if (e.error === "unauthorized" || e.error === "member_only") {
          window.location.assign("/login?next=/credits");
          return;
        }
        if (e.error === "consent_required") {
          // 동의 미완(in-between/레거시/구버전) — 통합 동의 화면으로.
          window.location.assign("/consent?next=/credits");
          return;
        }
        throw new Error("결제 요청에 실패했어요. 잠시 후 다시 시도해주세요.");
      }
      const { orderUuid, paymentId, orderName, totalAmount, channelKey, payMethod } =
        (await res.json()) as {
          orderUuid?: string;
          paymentId?: string;
          orderName?: string;
          totalAmount?: number;
          channelKey?: string;
          payMethod?: "CARD" | "EASY_PAY";
        };
      if (!orderUuid || !paymentId || !orderName || !totalAmount || !channelKey || !payMethod) {
        throw new Error("결제 정보를 받지 못했어요.");
      }

      // 결제창 호출 — 금액·주문명·채널키는 서버 결정값 그대로(클라 조작해도 서버/웹훅 대사가 차단).
      const PortOne = await import("@portone/browser-sdk/v2");
      const doneUrl = `${window.location.origin}/credits/done?order=${orderUuid}`;
      const resp = await PortOne.requestPayment({
        storeId: PUBLIC_ENV.PORTONE_STORE_ID,
        channelKey,
        paymentId,
        orderName,
        totalAmount,
        currency: "KRW",
        payMethod,
        redirectUrl: doneUrl, // 모바일(리다이렉트 방식) 복귀 — 카카오페이 등은 모바일 REDIRECTION 강제
      });
      // 리다이렉트 방식이면 여기 안 옴. PC(iframe/프로미스 반환) 경로:
      if (resp?.code !== undefined && resp.code !== null) {
        // 사용자 취소 포함 — 결제창 실패 코드. 주문은 pending 으로 남고 10분 재사용/실패 대사가 처리.
        log.warn("credits.pay_window_fail", { code: resp.code });
        throw new Error(resp.message || "결제가 완료되지 않았어요.");
      }
      window.location.assign(doneUrl); // 서버 폴링(단건 조회 재검증)으로 최종 확인
    } catch (e) {
      log.warn("credits.checkout_fail", errInfo(e));
      setError(e instanceof Error ? e.message : "결제 요청 실패");
      setPending(null);
    }
  };

  // OFF(준비중) — 어드민이 결제 노출을 끈 상태(심사용 계정 제외). 서버 체크아웃도 차단됨.
  // 채널 0개(해당 모드의 채널키 미설정 — 예: 실연동 계약 전) 도 동일하게 준비중으로 안내.
  if (!enabled || channels.length === 0) {
    return (
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 py-10 text-center">
          <span className="text-4xl" aria-hidden>
            🛠️
          </span>
          <h1 className="text-2xl font-bold">{comingSoon.title}</h1>
          <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-500">{comingSoon.body}</p>
        </div>
      </main>
    );
  }

  return (
    <>
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-md flex-col gap-5">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              생성권 충전
              {payMode === "test" && (
                <span className="rounded-full border border-foreground/15 bg-foreground/5 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500">
                  테스트 결제 모드
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.
            </p>
            {payMode === "test" && (
              <p className="mt-1 text-xs text-zinc-400">
                심사·테스트용 결제 환경이에요. 실제 요금이 청구되지 않아요.
              </p>
            )}
          </div>

          {channels.length > 1 && (
            <div className="flex items-center gap-2" role="radiogroup" aria-label="결제 수단">
              {channels.map((c) => (
                <button
                  key={c.method}
                  type="button"
                  role="radio"
                  aria-checked={method === c.method}
                  disabled={!!pending}
                  onClick={() => setMethod(c.method)}
                  className={`rounded-full border px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${
                    method === c.method
                      ? "border-foreground bg-foreground text-paper-2"
                      : "border-foreground/15 ui-surface hover:bg-foreground/5"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {products.map((p) => {
              const isPending = pending === p.productId;
              return (
                <button
                  key={p.productId}
                  type="button"
                  disabled={!!pending}
                  onClick={() => void buy(p.productId)}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/15 ui-surface p-4 text-left transition hover:bg-foreground/5 disabled:opacity-50"
                >
                  <div>
                    <p className="text-base font-bold">{p.goodname}</p>
                    <p className="text-xs text-zinc-500">
                      생성권 {p.credits}개 · 개당 {perUnitPrice(p).toLocaleString()}원
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

          {/* 상품 정보 고지 — PG 심사 요건: 제공기간(즉시 지급)·유효기간(1년 이내)·환불규정을
              구매 페이지에 노출(전상법 §13 상품정보제공고시 디지털콘텐츠 표시사항과 정합).
              세부 기준은 이용약관 제10조와 동일해야 함(drift 금지). */}
          <div className="flex flex-col gap-1.5 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5 text-[11px] leading-relaxed text-zinc-500">
            <p>
              · <b>제공 기간</b>: 생성권은 결제 완료 <b>즉시 지급</b>되어 바로 사용할 수 있어요.
            </p>
            <p>
              · <b>유효기간</b>: 구매일(지급일)로부터 <b>1년</b>이에요. 무료로 지급된 생성권도
              동일해요.
            </p>
            <p>
              · <b>환불</b>: 결제일로부터 7일 이내에는 사용하지 않은 생성권을 전액 환불받을 수
              있어요. 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한돼요.
              유효기간이 지난 미사용 생성권은 구매일로부터 5년까지 결제금액의 90% 환급을 요청할
              수 있어요. 자세한 기준·절차는 이용약관을 확인해주세요.
            </p>
            <p>
              · {channels.map((c) => c.label).join(" · ")}로 결제할 수 있어요. 표시 가격은 부가세
              포함 최종 결제 금액이에요.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
