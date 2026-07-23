// 관리자 UI 공용 포맷 (client-safe — server/client 양쪽 사용).

import { CHANNEL_LABELS, type PayChannelMethod } from "@/lib/pay-channels";

/** 결제경로 표기 — provider(payapp 레거시/portone) + pay_channel(0059)을 한 라벨로 압축. */
export function payRouteLabel(o: { provider: string; pay_channel: string | null }): string {
  if (o.provider === "payapp") return "페이앱";
  return o.pay_channel ? CHANNEL_LABELS[o.pay_channel as PayChannelMethod] ?? o.pay_channel : "포트원";
}

export function fmtKst(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export const STATUS_COLOR: Record<string, string> = {
  paid: "text-emerald-600",
  pending: "text-amber-600",
  canceled: "text-zinc-400",
  failed: "text-red-500",
};

export const won = (n: number) => `${(n ?? 0).toLocaleString()}원`;

/** 짧은 식별자 표기(uuid 앞 8자리). */
export const shortId = (id: string) => (id ? id.slice(0, 8) : "—");

/** Next 16 searchParams 값은 string | string[] | undefined — 첫 값만 안전 추출(반복 키 방어). */
export const firstParam = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;
