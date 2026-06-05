"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureAuth();
        const sb = createClient();
        const { data, error: queryError } = await sb
          .from("dolls")
          .select("id, image_url, created_at")
          .order("created_at", { ascending: false });
        if (cancelled) return;
        if (queryError) throw queryError;
        setDolls(data ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "불러오기 실패");
          setDolls([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
          <DollGrid dolls={dolls} />
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

function DollGrid({ dolls }: { dolls: Doll[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {dolls.map((d) => (
        <Link
          key={d.id}
          href={`/play?doll=${d.id}`}
          className="group relative aspect-square overflow-hidden rounded-2xl border border-foreground/10 transition hover:border-foreground/40"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={d.image_url}
            alt=""
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 text-xs text-white opacity-0 transition group-hover:opacity-100">
            패러 가기 →
          </span>
        </Link>
      ))}
    </div>
  );
}
