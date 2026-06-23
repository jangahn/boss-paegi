"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** 회원 검색 박스 — 제출 시 ?q= 로 이동(서버가 후보 렌더). 이메일/닉네임 부분일치, ID exact. */
export function MemberSearch({ q }: { q: string | null }) {
  const router = useRouter();
  const [query, setQuery] = useState(q ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = query.trim();
        router.push(`/admin/users${v ? `?q=${encodeURIComponent(v)}` : ""}`);
      }}
      className="flex gap-2"
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="이메일 / 닉네임(부분) / userId(정확)"
        className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
      />
      <button type="submit" className="rounded-lg border border-foreground/20 px-4 py-2 text-sm font-medium">
        검색
      </button>
    </form>
  );
}
