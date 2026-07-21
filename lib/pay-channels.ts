import { PUBLIC_ENV } from "@/lib/env";

/**
 * 포트원 결제수단 ↔ 채널 매핑 — 서버(설정 검사)·클라(브라우저 SDK 호출) 공용이라 server-only 금지.
 * 값은 전부 NEXT_PUBLIC_(공개 안전 식별자) — 시크릿 없음(서버 전용 키는 lib/env.server.ts).
 *
 * 채널키는 포트원 콘솔 채널관리에서 발급: 테스트/실연동은 각각 독립 채널(별도 채널키)이라
 * env 값 교체만으로 모드 전환(코드 변경 없음). card=KPN(신용카드 일반결제, payMethod CARD),
 * tosspay/kakaopay=간편결제 직연동(payMethod EASY_PAY 전용 — 수단 선택은 각 결제창 안에서).
 */
export type PayChannelMethod = "card" | "tosspay" | "kakaopay";

export type PayChannel = {
  method: PayChannelMethod;
  /** 결제수단 선택 UI 라벨 */
  label: string;
  channelKey: string;
  /** 브라우저 SDK payMethod */
  payMethod: "CARD" | "EASY_PAY";
};

/** 채널키가 설정된 결제수단만(표시 순서 고정: 카드 → 토스페이 → 카카오페이). */
export function paymentChannels(): PayChannel[] {
  const list: PayChannel[] = [];
  if (PUBLIC_ENV.PORTONE_CHANNEL_KEY_CARD) {
    list.push({
      method: "card",
      label: "카드",
      channelKey: PUBLIC_ENV.PORTONE_CHANNEL_KEY_CARD,
      payMethod: "CARD",
    });
  }
  if (PUBLIC_ENV.PORTONE_CHANNEL_KEY_TOSSPAY) {
    list.push({
      method: "tosspay",
      label: "토스페이",
      channelKey: PUBLIC_ENV.PORTONE_CHANNEL_KEY_TOSSPAY,
      payMethod: "EASY_PAY",
    });
  }
  if (PUBLIC_ENV.PORTONE_CHANNEL_KEY_KAKAOPAY) {
    list.push({
      method: "kakaopay",
      label: "카카오페이",
      channelKey: PUBLIC_ENV.PORTONE_CHANNEL_KEY_KAKAOPAY,
      payMethod: "EASY_PAY",
    });
  }
  return list;
}
