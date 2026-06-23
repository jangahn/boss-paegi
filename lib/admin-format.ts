// 관리자 UI 공용 포맷 (client-safe — server/client 양쪽 사용).

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
