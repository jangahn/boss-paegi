"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 주문 목록 필터 — 상태 select + 주문ID/mul_no 검색. 변경 시 page 리셋(?page 미설정 = 1페이지).
 */
const STATUSES = [
  { v: "", l: "전체" },
  { v: "paid", l: "paid" },
  { v: "pending", l: "pending" },
  { v: "canceled", l: "canceled" },
  { v: "failed", l: "failed" },
];

export function OrdersFilter({ status, q }: { status: string | null; q: string | null }) {
  const router = useRouter();
  const [query, setQuery] = useState(q ?? "");

  const go = (nextStatus: string, nextQ: string) => {
    const u = new URLSearchParams();
    if (nextStatus) u.set("status", nextStatus);
    if (nextQ.trim()) u.set("q", nextQ.trim());
    router.push(`/admin/orders${u.toString() ? `?${u}` : ""}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={status ?? ""}
        onChange={(e) => go(e.target.value, query)}
        className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
      >
        {STATUSES.map((s) => (
          <option key={s.v} value={s.v}>
            {s.l}
          </option>
        ))}
      </select>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(status ?? "", query);
        }}
        className="flex flex-1 gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="주문ID / mul_no 검색"
          className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
        />
        <button
          type="submit"
          className="rounded-lg border border-foreground/20 px-3 py-2 text-sm font-medium"
        >
          검색
        </button>
      </form>
    </div>
  );
}
