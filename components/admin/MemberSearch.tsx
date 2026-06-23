"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Spinner } from "@/components/Spinner";

/** 회원 검색 박스 — 제출 시 ?q= 로 이동(서버가 후보 렌더). useTransition pending 동안 disable + 스피너. */
export function MemberSearch({ q }: { q: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(q ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = query.trim();
        startTransition(() => router.push(`/admin/users${v ? `?q=${encodeURIComponent(v)}` : ""}`));
      }}
      className="flex gap-2"
    >
      <input
        value={query}
        disabled={pending}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="이메일 / 닉네임(부분) / userId(정확)"
        className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={pending}
        className="flex items-center gap-1 rounded-lg border border-foreground/20 px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {pending && <Spinner className="h-3.5 w-3.5" />}검색
      </button>
    </form>
  );
}
