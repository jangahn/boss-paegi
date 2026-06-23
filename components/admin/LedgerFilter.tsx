"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Spinner } from "@/components/Spinner";

/** 처리 내역 유형 필터 — 변경 시 page 리셋. useTransition 으로 RSC 네비 pending 동안 disable + 스피너. */
const TYPES = [
  { v: "", l: "전체" },
  { v: "cs_adjust", l: "CS 조정" },
  { v: "cancel_refund", l: "환불/취소" },
  { v: "settle_stuck", l: "지급(stuck)" },
];

export function LedgerFilter({ actionType }: { actionType: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-2">
      <select
        value={actionType ?? ""}
        disabled={pending}
        onChange={(e) =>
          startTransition(() =>
            router.push(`/admin/ledger${e.target.value ? `?type=${e.target.value}` : ""}`)
          )
        }
        className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
      >
        {TYPES.map((t) => (
          <option key={t.v} value={t.v}>
            {t.l}
          </option>
        ))}
      </select>
      {pending && <Spinner className="h-4 w-4" />}
    </div>
  );
}
