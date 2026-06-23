"use client";

import { useRouter } from "next/navigation";

/** 처리 내역 유형 필터 — 변경 시 page 리셋(?page 미설정 = 1페이지). */
const TYPES = [
  { v: "", l: "전체" },
  { v: "cs_adjust", l: "CS 조정" },
  { v: "cancel_refund", l: "환불/취소" },
  { v: "settle_stuck", l: "지급(stuck)" },
];

export function LedgerFilter({ actionType }: { actionType: string | null }) {
  const router = useRouter();
  return (
    <select
      value={actionType ?? ""}
      onChange={(e) => router.push(`/admin/ledger${e.target.value ? `?type=${e.target.value}` : ""}`)}
      className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
    >
      {TYPES.map((t) => (
        <option key={t.v} value={t.v}>
          {t.l}
        </option>
      ))}
    </select>
  );
}
