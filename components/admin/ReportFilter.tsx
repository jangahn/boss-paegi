"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Spinner } from "@/components/Spinner";

const STATUSES = [
  { v: "", l: "전체 상태" },
  { v: "pending", l: "대기" },
  { v: "actioned", l: "삭제됨" },
  { v: "dismissed", l: "기각" },
];

/**
 * 신고 큐 필터 — 상태 select(즉시 적용) + 캐릭터/제작자 id 입력(Enter·적용). 변경 시 page 리셋.
 * 테이블의 클릭 필터(캐릭터/제작자 칩)는 직접 /admin/moderation?dollId=·ownerId= 로 네비.
 */
export function ReportFilter({
  status,
  dollId,
  ownerId,
}: {
  status: string | null;
  dollId: string | null;
  ownerId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [doll, setDoll] = useState(dollId ?? "");
  const [owner, setOwner] = useState(ownerId ?? "");

  const go = (next: { status?: string | null; dollId?: string | null; ownerId?: string | null }) => {
    const s = next.status !== undefined ? next.status : status;
    const d = next.dollId !== undefined ? next.dollId : doll.trim() || null;
    const o = next.ownerId !== undefined ? next.ownerId : owner.trim() || null;
    const u = new URLSearchParams();
    if (s) u.set("status", s);
    if (d) u.set("dollId", d);
    if (o) u.set("ownerId", o);
    startTransition(() => router.push(`/admin/moderation${u.toString() ? `?${u}` : ""}`));
  };

  const clear = () => {
    setDoll("");
    setOwner("");
    startTransition(() => router.push("/admin/moderation"));
  };

  const hasFilter = !!(status || dollId || ownerId);
  const inputCls =
    "w-44 rounded-lg border border-foreground/15 bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus:border-foreground/40 disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={status ?? ""}
        disabled={pending}
        onChange={(e) => go({ status: e.target.value || null })}
        className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
      >
        {STATUSES.map((t) => (
          <option key={t.v} value={t.v}>
            {t.l}
          </option>
        ))}
      </select>
      <input
        value={doll}
        disabled={pending}
        onChange={(e) => setDoll(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go({ dollId: doll.trim() || null })}
        placeholder="캐릭터 id"
        className={inputCls}
      />
      <input
        value={owner}
        disabled={pending}
        onChange={(e) => setOwner(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go({ ownerId: owner.trim() || null })}
        placeholder="제작자(owner) id"
        className={inputCls}
      />
      <button
        type="button"
        onClick={() => go({})}
        disabled={pending}
        className="rounded-lg border border-foreground/20 px-3 py-2 text-sm disabled:opacity-50"
      >
        적용
      </button>
      {hasFilter && (
        <button
          type="button"
          onClick={clear}
          disabled={pending}
          className="rounded-lg border border-foreground/20 px-3 py-2 text-sm text-zinc-500 disabled:opacity-50"
        >
          초기화
        </button>
      )}
      {pending && <Spinner className="h-4 w-4" />}
    </div>
  );
}
