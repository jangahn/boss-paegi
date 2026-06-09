"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";

type Doll = {
  id: string;
  image_url: string;
  created_at: string;
};

export default function GalleryPage() {
  const [dolls, setDolls] = useState<Doll[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureAuth();
      const sb = createClient();
      const { data, error: queryError } = await sb
        .from("dolls")
        .select("id, image_url, created_at")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      setDolls(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
      setDolls([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm("이 부장님 인형을 삭제할까요?")) return;
    setDeletingId(id);
    setError(null);
    try {
      const r = await fetch(`/api/doll?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? "삭제 실패");
      }
      setDolls((prev) => (prev ?? []).filter((d) => d.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="flex flex-1 flex-col px-6 py-8">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">내 부장님들</h1>
          <Link
            href="/generate"
            className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90"
          >
            + 새로 만들기
          </Link>
        </div>

        {dolls === null ? (
          <GridSkeleton />
        ) : dolls.length === 0 ? (
          <EmptyState />
        ) : (
          <DollGrid dolls={dolls} onDelete={handleDelete} deletingId={deletingId} />
        )}

        {error && (
          <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">{error}</p>
        )}
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-foreground/15 p-12 text-center">
      <p className="text-zinc-500">아직 만든 부장님이 없어요.</p>
      <Link
        href="/generate"
        className="rounded-full bg-foreground px-6 py-3 font-semibold text-background"
      >
        첫 부장님 만들기
      </Link>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="aspect-square animate-pulse rounded-2xl bg-foreground/10"
        />
      ))}
    </div>
  );
}

function DollGrid({
  dolls,
  onDelete,
  deletingId,
}: {
  dolls: Doll[];
  onDelete: (id: string) => void;
  deletingId: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {dolls.map((d) => (
        <div
          key={d.id}
          className="group relative aspect-square overflow-hidden rounded-2xl border border-foreground/10"
        >
          <Link href={`/play?doll=${d.id}`} className="block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={d.image_url}
              alt=""
              className="h-full w-full object-cover transition group-hover:scale-105"
            />
          </Link>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(d.id);
            }}
            disabled={deletingId === d.id}
            aria-label="삭제"
            className="absolute right-2 top-2 z-10 flex h-9 w-9 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur-sm transition hover:bg-red-500/85 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
