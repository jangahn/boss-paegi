"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { useBfcacheReset } from "@/lib/use-bfcache-reset";
import { perUnitPrice, type CreditProduct } from "@/lib/credit-products";
import { paymentChannels, type PayChannelMethod, type PayMode } from "@/lib/pay-channels";
import { log, errInfo } from "@/lib/log";
import { setSentryLastAction } from "@/lib/sentry-context";
import { parseCheckoutHttpResponse } from "@/lib/pay/http-contract";
import { CREDITS_OFFER_COPY } from "@/lib/pay/display-evidence";
import { CHECKOUT_WITHDRAWAL_CONFIRMATION } from "@/lib/pay/withdrawal-evidence";
import { payErrorAction, payErrorMessage } from "@/lib/pay/error-catalog";
import { waitForPortOnePayment } from "@/lib/pay/client-portone-payment";

import {
  clientMutationResponseNeedsReconciliation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";

// stale 자가치유(action === "stale_reload" — 어떤 코드가 해당하는지는 오류
// 카탈로그가 결정): 1회 자동 새로고침 루프 방지 마커 + 갱신 후 안내 배너 마커.
const STALE_RELOAD_MARKER = "boss-paegi:checkout-stale-reload";
const STALE_RELOAD_NOTICE = "boss-paegi:checkout-stale-notice";

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
  classificationUnavailable = false,
  offerEvidenceId = null,
  offerSnapshotSha256 = null,
}: {
  products: CreditProduct[];
  enabled: boolean;
  comingSoon: { title: string; body: string };
  payMode: PayMode;
  classificationUnavailable?: boolean;
  offerEvidenceId?: string | null;
  offerSnapshotSha256?: string | null;
}) {
  const channels = paymentChannels(payMode);
  const [method, setMethod] = useState<PayChannelMethod | null>(channels[0]?.method ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const lifecycleRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      controller.abort(new Error("credits_client_unmounted"));
      if (lifecycleRef.current === controller) lifecycleRef.current = null;
    };
  }, []);

  // 법적 동의는 서버 proxy 가 렌더 전 게이트(미동의면 여기 안 옴). 진입 시 클라 동의 가드 불필요.
  // 결제창(리다이렉트) 갔다가 뒤로가기 → bfcache 복원 시 멈춘 스피너(pending) 해제.
  useBfcacheReset(() => {
    pendingRef.current = false;
    setPending(null);
  });

  // stale 자가치유 새로고침 직후 — 왜 화면이 갱신됐고 뭘 하면 되는지 1회 안내.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(STALE_RELOAD_NOTICE)) {
        sessionStorage.removeItem(STALE_RELOAD_NOTICE);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError(
          "상품 정보가 갱신되어 화면을 새로고침했어요. 원하시는 상품으로 다시 시도해주세요.",
        );
      }
    } catch {
      /* sessionStorage 접근 불가(프라이빗 모드 등) — 안내 생략 */
    }
  }, []);

  const buy = async (product: CreditProduct) => {
    if (pendingRef.current) return; // 중복 클릭 가드
    const channel = channels.find((c) => c.method === method);
    if (!channel) {
      setError("결제 수단을 선택해주세요.");
      return;
    }
    if (offerEvidenceId === null || offerSnapshotSha256 === null) {
      setError("상품 안내를 불러오지 못했어요. 새로고침 후 다시 시도해주세요.");
      return;
    }
    setSentryLastAction("purchase_start");
    pendingRef.current = true;
    setPending(product.productId);
    setError(null);
    const lifecycleSignal = lifecycleRef.current?.signal;
    try {
      const checkoutRequestId = crypto.randomUUID();
      const requestBody = JSON.stringify({
        // expected* 는 권위 입력이 아니라 이 화면이 사용자에게 표시한
        // TEST/LIVE 및 상품 스냅샷의 fence다. 서버 최신 판정과 다르면
        // 가격을 포함한 어떤 값도 바꿔 결제창을 열지 않는다.
        productId: product.productId,
        method: channel.method,
        expectedMode: payMode,
        expectedProduct: product,
        checkoutRequestId,
        offerEvidenceId,
        offerSnapshotSha256,
        withdrawalConfirmation: {
          confirmed: true,
          copyVersion: CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
          statement: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
        },
      });
      const delivery = await runReplayedJsonMutation({
        input: "/api/pay/checkout",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        signal: lifecycleSignal,
        classify: (response, body) => {
          const checkout = response.ok
            ? parseCheckoutHttpResponse(body)
            : null;
          if (checkout) return { kind: "confirmed", value: checkout };
          const apiError =
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : null;
          // 서버가 오류 코드를 명시한 응답은 상태코드 불문 **확정 거절** — 코드가
          // 곧 이유이고, 서버는 이미 rollback 을 마쳤다. (구버전은 429/503/5xx 를
          // 일괄 미확정 처리해 rate-limit 에 자동 재전송 + 코드 문구가 죽는
          // 사각이 있었다.) 재전송이 정당한 미확정은 코드 없는 5xx/transport 뿐.
          if (apiError) return { kind: "rejected", error: apiError };
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "checkout_response_unconfirmed",
              error: null,
            };
          }
          return {
            kind: "rejected",
            error: `checkout_http_${response.status}`,
          };
        },
      });
      if (delivery.kind === "aborted") return;
      if (delivery.kind === "rejected") {
        // 코드→문구/동작은 서버와 공유하는 단일 카탈로그(lib/pay/error-catalog)가
        // 결정한다. 사전에 없는 코드도 숨기지 않는다 — 문의/조사 시 이 코드가
        // 서버 로그와 1:1 로 이어지는 유일한 단서다.
        const code =
          typeof delivery.error === "string" ? delivery.error : null;
        const action = code ? payErrorAction(code) : null;
        if (action === "login") {
          window.location.assign("/login?next=/credits");
          return;
        }
        if (action === "consent") {
          window.location.assign("/consent?next=/credits");
          return;
        }
        if (action === "stale_reload") {
          // 상품/문구/증거가 서버 최신과 어긋난 탭 — 1회 자동 새로고침으로 자가
          // 치유(마커로 루프 방지)하고, 갱신된 화면에서 안내 배너를 띄운다.
          // 재발이면 명시 안내로 강등.
          if (!sessionStorage.getItem(STALE_RELOAD_MARKER)) {
            sessionStorage.setItem(STALE_RELOAD_MARKER, "1");
            sessionStorage.setItem(STALE_RELOAD_NOTICE, "1");
            window.location.reload();
            return;
          }
        }
        throw new Error(
          code
            ? payErrorMessage(code)
            : "결제 요청에 실패했어요. 잠시 후 다시 시도해주세요.",
        );
      }
      if (delivery.kind === "confirmed") {
        try { sessionStorage.removeItem(STALE_RELOAD_MARKER); } catch { /* noop */ }
      }
      if (delivery.kind !== "confirmed") {
        throw new Error(
          "결제 주문 결과를 확인하지 못했어요. 결제창은 열지 않았습니다. 잠시 후 다시 시도해주세요.",
        );
      }
      const {
        orderUuid,
        paymentId,
        orderName: checkoutOrderName,
        totalAmount,
        storeId,
        currency,
        channelKey,
        payMethod,
      } = delivery.value;

      // 결제창 호출 — 가맹점·통화·금액·주문명·채널키는 하나의 서버
      // checkout receipt에서 그대로 사용한다. NEXT_PUBLIC_* 빌드값을 섞으면
      // 롤링 배포/설정 전환 중 서로 다른 가맹점 증거로 결제될 수 있다.
      const PortOne = await import("@portone/browser-sdk/v2");
      const doneUrl = `${window.location.origin}/credits/done?order=${orderUuid}`;
      const paymentWindow = await waitForPortOnePayment(
        PortOne.requestPayment({
          storeId,
          channelKey,
          paymentId,
          orderName: checkoutOrderName,
          totalAmount,
          currency,
          payMethod,
          redirectUrl: doneUrl, // 모바일(리다이렉트 방식) 복귀 — 카카오페이 등은 모바일 REDIRECTION 강제
        }),
        { signal: lifecycleSignal },
      );
      if (paymentWindow.kind === "cancelled") return;
      if (paymentWindow.kind === "timeout") {
        // Never replay a charge-capable SDK call. The durable order-status
        // route is the only safe authority after an ambiguous client timeout.
        window.location.assign(doneUrl);
        return;
      }
      const resp = paymentWindow.value;
      // 리다이렉트 방식이면 여기 안 옴. PC(iframe/프로미스 반환) 경로:
      if (resp?.code !== undefined && resp.code !== null) {
        // 사용자 취소 포함 — 결제창 실패 코드. 주문은 사용자별 전역 미해결
        // intent로 남고 다음 checkout 재사용/실패 대사가 처리한다.
        log.warn("credits.pay_window_fail", { code: resp.code });
        throw new Error(resp.message || "결제가 완료되지 않았어요.");
      }
      window.location.assign(doneUrl); // 서버 폴링(단건 조회 재검증)으로 최종 확인
    } catch (e) {
      log.warn("credits.checkout_fail", errInfo(e));
      if (!lifecycleSignal?.aborted) {
        setError(e instanceof Error ? e.message : "결제 요청 실패");
        pendingRef.current = false;
        setPending(null);
      }
    }
  };

  if (
    classificationUnavailable ||
    (enabled &&
      channels.length > 0 &&
      (offerEvidenceId === null || offerSnapshotSha256 === null))
  ) {
    return (
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 py-10 text-center">
          <span className="text-4xl" aria-hidden>
            ⚠️
          </span>
          <h1 className="text-2xl font-bold">결제 환경을 확인하지 못했어요</h1>
          <p className="text-sm leading-relaxed text-zinc-500">
            안전을 위해 결제를 시작하지 않았어요. 잠시 후 새로고침해 주세요.
          </p>
        </div>
      </main>
    );
  }

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

          <div className="rounded-xl border border-foreground/15 bg-foreground/[0.03] p-3.5 text-sm leading-relaxed">
            <b className="block">사용분 청약철회 제한 안내</b>
            <span className="block text-xs text-zinc-500">
              {CHECKOUT_WITHDRAWAL_CONFIRMATION.statement}
            </span>
            <span className="mt-1 block text-xs text-zinc-500">
              결제 버튼을 누르면 위 내용을 확인한 것으로 봅니다.
            </span>
          </div>

          <div className="flex flex-col gap-3">
            {products.map((p) => {
              const isPending = pending === p.productId;
              return (
                <button
                  key={p.productId}
                  type="button"
                  disabled={!!pending}
                  onClick={() => void buy(p)}
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

          {/* 상품 정보 고지 — PG 심사 요건: 제공기간(즉시 지급)·유효기간(1년 이내)과 '사용분
              청약철회 제한' 표시는 법정 필수(전상법 §13·§17⑥)라 여기 유지. 환불 산정·수치의
              정본은 이용약관 제10조 단일 소스 — 여기엔 한 줄 요지+약관 참조만(수치 중복 금지,
              v0.75). 결제수단/부가세 안내 줄은 법정 의무 아님이라 삭제(v2, 2026-08-19 결정). */}
          <div className="flex flex-col gap-1.5 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5 text-[11px] leading-relaxed text-zinc-500">
            <p>
              · <b>제공 기간</b>: {CREDITS_OFFER_COPY.supply}
            </p>
            <p>
              · <b>유효기간</b>: {CREDITS_OFFER_COPY.validity}
            </p>
            <p>
              · <b>환불</b>: {CREDITS_OFFER_COPY.refund}{" "}
              {CREDITS_OFFER_COPY.refundReferencePrefix}{" "}
              <Link href="/terms" className="underline underline-offset-2">
                {CREDITS_OFFER_COPY.termsLinkLabel}
              </Link>
              {CREDITS_OFFER_COPY.refundReferenceSuffix}
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
