"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import { Spinner } from "@/components/Spinner";
import { AppNav } from "@/components/AppNav";
import { saveDoll, shareDoll } from "@/lib/doll-share";

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
    <>
      <AppNav />
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
    </>
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
        <DollCard
          key={d.id}
          doll={d}
          deleting={deletingId === d.id}
          onDelete={() => onDelete(d.id)}
        />
      ))}
    </div>
  );
}

function DollCard({
  doll,
  deleting,
  onDelete,
}: {
  doll: Doll;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const flash = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 1800);
  };

  const handleShare = async () => {
    setMenuOpen(false);
    if (sharing) return;
    setSharing(true);
    try {
      const result = await shareDoll(doll.image_url, doll.id);
      if (result === "copied") flash("링크 복사됨");
      else if (result === "failed") flash("공유 실패");
    } finally {
      setSharing(false);
    }
  };

  const handleDownload = async () => {
    setMenuOpen(false);
    const result = await saveDoll(doll.image_url, doll.id);
    if (result === "failed") flash("저장 실패");
  };

  return (
    // outer 는 overflow 없음 — 드롭다운이 카드 경계 (둥근 모서리 클리핑) 에
    // 잘리지 않게 이미지 영역과 분리 (작은 폰에서 메뉴가 카드보다 큼)
    <div className="group relative">
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-foreground/10">
        {/* 이미지 로드 전 pulse placeholder */}
        {!imgLoaded && (
          <div className="absolute inset-0 animate-pulse bg-foreground/10" />
        )}
        <Link href={`/play?doll=${doll.id}`} className="block h-full w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={doll.image_url}
            alt=""
            onLoad={() => setImgLoaded(true)}
            className={`h-full w-full object-cover transition duration-300 group-hover:scale-105 ${
              imgLoaded ? "opacity-100" : "opacity-0"
            }`}
          />
        </Link>

        {actionMsg && (
          <span className="absolute bottom-2 left-2 z-10 rounded-full bg-black/65 px-2.5 py-1 text-[10px] text-white">
            {actionMsg}
          </span>
        )}
        {sharing && (
          <span className="absolute bottom-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/65">
            <Spinner className="h-3.5 w-3.5 text-white" />
          </span>
        )}

        {/* 삭제 진행 중 — 카드 dim + 스피너 */}
        {deleting && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[2px]">
            <Spinner className="h-6 w-6 text-white" />
            <span className="text-xs font-medium text-white/90">
              삭제 중...
            </span>
          </div>
        )}
      </div>

      {/* ⋯ 옵션 버튼 — 공유/저장/삭제 메뉴 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        disabled={deleting}
        aria-label="옵션"
        className="absolute right-2 top-2 z-20 flex h-9 w-9 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/65 text-lg font-bold leading-none text-white shadow-lg backdrop-blur-sm transition hover:bg-black/80 active:scale-90 disabled:opacity-40"
      >
        ⋯
      </button>

      {menuOpen && (
        <>
          {/* 바깥 탭으로 닫기 */}
          <div
            className="fixed inset-0 z-20"
            onClick={(e) => {
              e.preventDefault();
              setMenuOpen(false);
            }}
          />
          <div className="absolute right-2 top-12 z-30 w-32 overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-2xl">
            <MenuItem onClick={handleShare}>공유</MenuItem>
            <MenuItem onClick={handleDownload}>이미지 저장</MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              danger
            >
              삭제
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  danger = false,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`block w-full cursor-pointer touch-manipulation px-4 py-3 text-left text-sm transition hover:bg-foreground/5 ${
        danger ? "text-red-400" : ""
      }`}
    >
      {children}
    </button>
  );
}
