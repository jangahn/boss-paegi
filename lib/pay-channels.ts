import { PUBLIC_ENV } from "@/lib/env";

/**
 * 포트원 결제수단 ↔ 채널 매핑 — 서버(설정 검사)·클라(브라우저 SDK 호출) 공용이라 server-only 금지.
 * 값은 전부 NEXT_PUBLIC_(공개 안전 식별자) — 시크릿 없음(서버 전용 키는 lib/env.server.ts).
 *
 * 채널키는 포트원 콘솔 채널관리에서 발급: 테스트/실연동은 각각 독립 채널(별도 채널키)이며 **동시 운영**된다.
 * 어느 세트를 쓸지는 계정 기반으로 서버가 판정(PayMode — 심사·테스트 계정=test, 일반 유저=live,
 * 판정 로직은 lib/config/domains/growth.ts payModeFor). 결제창 호출 채널키의 최종 소스는
 * /api/pay/checkout 응답(서버 결정값) — 클라 env 직접 참조는 UI 구성(수단 목록)용.
 * card=KPN(신용카드 일반결제, payMethod CARD), tosspay/kakaopay=간편결제 직연동(payMethod EASY_PAY).
 */
export type PayChannelMethod = "card" | "tosspay" | "kakaopay";

/** 결제 모드 — live=실연동 채널(일반 유저), test=테스트 채널(심사·테스트 계정 전용). */
export type PayMode = "live" | "test";

export type PayChannel = {
  method: PayChannelMethod;
  /** 결제수단 선택 UI 라벨 */
  label: string;
  channelKey: string;
  /** 브라우저 SDK payMethod */
  payMethod: "CARD" | "EASY_PAY";
};

const CHANNEL_DEFS: Array<{
  method: PayChannelMethod;
  label: string;
  payMethod: "CARD" | "EASY_PAY";
  liveKey: () => string;
  testKey: () => string;
}> = [
  {
    method: "card",
    label: "카드",
    payMethod: "CARD",
    liveKey: () => PUBLIC_ENV.PORTONE_CHANNEL_KEY_CARD,
    testKey: () => PUBLIC_ENV.PORTONE_CHANNEL_KEY_CARD_TEST,
  },
  {
    method: "tosspay",
    label: "토스페이",
    payMethod: "EASY_PAY",
    liveKey: () => PUBLIC_ENV.PORTONE_CHANNEL_KEY_TOSSPAY,
    testKey: () => PUBLIC_ENV.PORTONE_CHANNEL_KEY_TOSSPAY_TEST,
  },
  {
    method: "kakaopay",
    label: "카카오페이",
    payMethod: "EASY_PAY",
    liveKey: () => PUBLIC_ENV.PORTONE_CHANNEL_KEY_KAKAOPAY,
    testKey: () => PUBLIC_ENV.PORTONE_CHANNEL_KEY_KAKAOPAY_TEST,
  },
];

/** 해당 모드의 채널키가 설정된 결제수단만(표시 순서 고정: 카드 → 토스페이 → 카카오페이). */
export function paymentChannels(mode: PayMode): PayChannel[] {
  const list: PayChannel[] = [];
  for (const def of CHANNEL_DEFS) {
    const channelKey = mode === "test" ? def.testKey() : def.liveKey();
    if (channelKey) {
      list.push({ method: def.method, label: def.label, channelKey, payMethod: def.payMethod });
    }
  }
  return list;
}

/** 모드 무관 어느 한쪽이라도 채널이 설정돼 있는지 — 결제 라우트 활성 판정(portoneConfigured)용. */
export function anyPaymentChannelConfigured(): boolean {
  return paymentChannels("live").length > 0 || paymentChannels("test").length > 0;
}
