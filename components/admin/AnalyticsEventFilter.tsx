"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Spinner } from "@/components/Spinner";
import {
  ANALYTICS_EVENT_KINDS,
  ANALYTICS_EVENT_KIND_KO,
  type AnalyticsEventKind,
} from "@/lib/admin-acquisition-labels";

/** 원본 이벤트 종류 필터 — 변경 시 page 리셋. 처리내역 필터(LedgerFilter)와 같은 select·pending 패턴. */
export function AnalyticsEventFilter({ kind }: { kind: AnalyticsEventKind | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-2">
      <select
        value={kind ?? ""}
        disabled={pending}
        aria-label="이벤트 종류"
        onChange={(e) =>
          startTransition(() =>
            router.push(`/admin/acquisition/events${e.target.value ? `?kind=${e.target.value}` : ""}`),
          )
        }
        className="rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
      >
        <option value="">전체</option>
        {ANALYTICS_EVENT_KINDS.map((k) => (
          <option key={k} value={k}>
            {ANALYTICS_EVENT_KIND_KO[k]}
          </option>
        ))}
      </select>
      {pending && <Spinner className="h-4 w-4" />}
    </div>
  );
}
