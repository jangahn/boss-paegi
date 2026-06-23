"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Spinner } from "@/components/Spinner";

/**
 * 주문 목록 필터 — 상태 select + 주문ID/mul_no 검색. 변경 시 page 리셋(?page 미설정 = 1페이지).
 * useTransition 으로 RSC 네비 pending 동안 컨트롤 disable + 스피너(무피드백·중복submit 방지).
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
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(q ?? "");

  const go = (nextStatus: string, nextQ: string) => {
    const u = new URLSearchParams();
    if (nextStatus) u.set("status", nextStatus);
    if (nextQ.trim()) u.set("q", nextQ.trim());
    startTransition(() => router.push(`/admin/orders${u.toString() ? `?${u}` : ""}`));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={status ?? ""}
        disabled={pending}
        onChange={(e) => go(e.target.value, query)}
        className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
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
          disabled={pending}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="주문ID / mul_no 검색"
          className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-1 rounded-lg border border-foreground/20 px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {pending && <Spinner className="h-3.5 w-3.5" />}검색
        </button>
      </form>
    </div>
  );
}
