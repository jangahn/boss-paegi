"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Spinner } from "@/components/Spinner";

const STATUSES = [
  { v: "all", l: "전체" },
  { v: "requested", l: "생성요청" },
  { v: "unpicked", l: "선택 전" },
  { v: "picked", l: "선택완료" },
  { v: "rejected", l: "거부(얼굴X)" },
  { v: "failed", l: "기타 실패" },
];

/**
 * 생성 현황 필터 — 상태 select(즉시 적용) + 회원(owner)/캐릭터(doll) id 입력(Enter·적용). 변경 시 page 리셋.
 * 테이블의 클릭 필터(회원/캐릭터 칩)는 직접 /admin/generations?ownerId=·dollId= 로 네비.
 */
export function GenStatusFilter({
  status,
  ownerId,
  dollId,
}: {
  status: string;
  ownerId: string | null;
  dollId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [owner, setOwner] = useState(ownerId ?? "");
  const [doll, setDoll] = useState(dollId ?? "");

  const go = (next: { status?: string; ownerId?: string | null; dollId?: string | null }) => {
    const s = next.status !== undefined ? next.status : status;
    const o = next.ownerId !== undefined ? next.ownerId : owner.trim() || null;
    const d = next.dollId !== undefined ? next.dollId : doll.trim() || null;
    const u = new URLSearchParams();
    if (s !== "all") u.set("status", s);
    if (o) u.set("ownerId", o);
    if (d) u.set("dollId", d);
    const qs = u.toString();
    startTransition(() => router.push(`/admin/generations${qs ? `?${qs}` : ""}`));
  };

  const clear = () => {
    setOwner("");
    setDoll("");
    startTransition(() => router.push("/admin/generations"));
  };

  const hasFilter = status !== "all" || !!ownerId || !!dollId;
  const inputCls =
    "w-40 rounded-lg border border-foreground/15 ui-field px-2.5 py-2 font-mono text-xs outline-none focus:border-foreground/40 disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={status}
        disabled={pending}
        onChange={(e) => go({ status: e.target.value })}
        className="rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
      >
        {STATUSES.map((t) => (
          <option key={t.v} value={t.v}>
            {t.l}
          </option>
        ))}
      </select>
      <input
        value={owner}
        disabled={pending}
        onChange={(e) => setOwner(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go({ ownerId: owner.trim() || null })}
        placeholder="회원(owner) id"
        className={inputCls}
      />
      <input
        value={doll}
        disabled={pending}
        onChange={(e) => setDoll(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go({ dollId: doll.trim() || null })}
        placeholder="캐릭터 id"
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
