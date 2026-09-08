"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Spinner } from "@/components/Spinner";
import { ROLE_IDS } from "@/lib/roles";
import { GENDERS, GENDER_LABEL } from "@/lib/gender";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";

const STATES = [
  { v: "all", l: "전체" },
  { v: "public", l: "공개" },
  { v: "hidden", l: "숨김" },
  { v: "purged", l: "영구삭제" },
];

/**
 * 캐릭터 목록 필터 — 상태·롤·성별 select(즉시 적용) + 회원(owner) id 입력(Enter·적용). 변경 시 page 리셋.
 * 생성 기록 필터(GenStatusFilter)와 같은 조작 규약. 롤 호칭은 발행 config(roleFrom).
 */
export function DollFilterBar({
  state,
  role,
  gender,
  ownerId,
}: {
  state: string;
  role: string | null;
  gender: string | null;
  ownerId: string | null;
}) {
  const router = useRouter();
  const cfg = useRoleConfig();
  const [pending, startTransition] = useTransition();
  const [owner, setOwner] = useState(ownerId ?? "");

  const go = (next: { state?: string; role?: string | null; gender?: string | null; ownerId?: string | null }) => {
    const s = next.state !== undefined ? next.state : state;
    const r = next.role !== undefined ? next.role : role;
    const g = next.gender !== undefined ? next.gender : gender;
    const o = next.ownerId !== undefined ? next.ownerId : owner.trim() || null;
    const u = new URLSearchParams();
    if (s !== "all") u.set("state", s);
    if (r) u.set("role", r);
    if (g) u.set("gender", g);
    if (o) u.set("ownerId", o);
    const qs = u.toString();
    startTransition(() => router.push(`/admin/dolls${qs ? `?${qs}` : ""}`));
  };

  const clear = () => {
    setOwner("");
    startTransition(() => router.push("/admin/dolls"));
  };

  const hasFilter = state !== "all" || !!role || !!gender || !!ownerId;
  const selectCls =
    "rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={state} disabled={pending} onChange={(e) => go({ state: e.target.value })} className={selectCls} aria-label="상태">
        {STATES.map((t) => (
          <option key={t.v} value={t.v}>
            {t.l}
          </option>
        ))}
      </select>
      <select value={role ?? ""} disabled={pending} onChange={(e) => go({ role: e.target.value || null })} className={selectCls} aria-label="롤">
        <option value="">롤 전체</option>
        {ROLE_IDS.map((rid) => (
          <option key={rid} value={rid}>
            {roleFrom(rid, cfg).label}
          </option>
        ))}
      </select>
      <select value={gender ?? ""} disabled={pending} onChange={(e) => go({ gender: e.target.value || null })} className={selectCls} aria-label="성별">
        <option value="">성별 전체</option>
        {GENDERS.map((g) => (
          <option key={g} value={g}>
            {GENDER_LABEL[g]}
          </option>
        ))}
      </select>
      <input
        value={owner}
        disabled={pending}
        onChange={(e) => setOwner(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go({ ownerId: owner.trim() || null })}
        placeholder="회원(owner) id"
        className="w-40 min-w-0 rounded-lg border border-foreground/15 ui-field px-2.5 py-2 font-mono text-xs outline-none focus:border-foreground/40 disabled:opacity-50"
      />
      <button type="button" onClick={() => go({})} disabled={pending} className="rounded-lg border border-foreground/20 px-3 py-2 text-sm disabled:opacity-50">
        적용
      </button>
      {hasFilter && (
        <button type="button" onClick={clear} disabled={pending} className="rounded-lg border border-foreground/20 px-3 py-2 text-sm text-zinc-500 disabled:opacity-50">
          초기화
        </button>
      )}
      {pending && <Spinner className="h-4 w-4" />}
    </div>
  );
}
