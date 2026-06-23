"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import { getMyProfile, formatCredits } from "@/lib/profile";
import { Spinner } from "@/components/Spinner";
import { AppNav } from "@/components/AppNav";
import { shareDoll } from "@/lib/doll-share";
import { ROLE_IDS, ROLE_META, asRole, josaEuro, type RoleId } from "@/lib/roles";
import type { PendingGeneration } from "@/lib/generation";

type Doll = {
  id: string;
  image_url: string;
  created_at: string;
  role: string;
};

export default function GalleryPage() {
  const [dolls, setDolls] = useState<Doll[] | null>(null);
  const [pending, setPending] = useState<PendingGeneration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [credits, setCredits] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureAuth();
      const sb = createClient();
      const { data, error: queryError } = await sb
        .from("dolls")
        .select("id, image_url, created_at, role")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      setDolls(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
      setDolls([]);
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch("/api/generations");
      if (!res.ok) return;
      const { pending } = (await res.json()) as { pending: PendingGeneration[] };
      setPending(pending);
    } catch {
      /* 생성 복구는 부가기능 — 실패해도 갤러리 본문엔 영향 없음 */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPending();
    // genCredits 는 마운트 시 1회 로드 — 생성은 /generate 에서 일어나고 끝나면 /play 로 이동하므로
    // 갤러리 재진입=재마운트로 자가보정(별도 실시간 동기화 불요). [품질감사 low: 자가보정 확인됨]
    getMyProfile()
      .then((p) => setCredits(p?.genCredits ?? null))
      .catch(() => {});
  }, [load, loadPending]);

  // 생성 중인 게 있으면 완료 감지 위해 폴링
  useEffect(() => {
    if (!pending.some((p) => p.kind === "generating")) return;
    const t = setInterval(() => void loadPending(), 4000);
    return () => clearInterval(t);
  }, [pending, loadPending]);

  const handleRoleChange = useCallback((id: string, role: RoleId) => {
    setDolls((prev) => (prev ?? []).map((d) => (d.id === id ? { ...d, role } : d)));
  }, []);

  const handleDelete = async (id: string) => {
    if (deletingIds.has(id)) return;
    if (!confirm("이 캐릭터를 삭제할까요?")) return;
    setDeletingIds((prev) => new Set(prev).add(id));
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
      // 이 id 만 해제 — 동시에 진행 중인 다른 삭제의 스피너를 건드리지 않음.
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-bold">내 캐릭터들</h1>
            {credits !== null && (
              <span className="text-sm text-zinc-500">
                생성권 {formatCredits(credits)}
              </span>
            )}
          </div>
          <Link
            href="/generate"
            className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90"
          >
            + 새로 만들기
          </Link>
        </div>

        {pending.length > 0 && <PendingGrid pending={pending} />}

        {dolls === null ? (
          <GridSkeleton />
        ) : dolls.length === 0 ? (
          pending.length === 0 && <EmptyState />
        ) : (
          <DollGrid
            dolls={dolls}
            onDelete={handleDelete}
            onRoleChange={handleRoleChange}
            deletingIds={deletingIds}
          />
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
      <p className="text-zinc-500">아직 만든 캐릭터가 없어요.</p>
      <Link
        href="/generate"
        className="rounded-full bg-foreground px-6 py-3 font-semibold text-background"
      >
        첫 캐릭터 만들기
      </Link>
    </div>
  );
}

/** 미완결 생성 — 생성 중 / 고르기 대기 / 중단됨 */
function PendingGrid({ pending }: { pending: PendingGeneration[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-zinc-400">진행 중인 생성</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {pending.map((p) => (
          <PendingCard key={p.id} gen={p} />
        ))}
      </div>
    </div>
  );
}

function PendingCard({ gen }: { gen: PendingGeneration }) {
  if (gen.kind === "generating") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl border border-foreground/10 bg-foreground/5">
        <Spinner className="h-7 w-7 text-foreground/70" />
        <span className="text-xs font-medium text-zinc-500">
          AI 가 만드는 중…
        </span>
      </div>
    );
  }
  if (gen.kind === "interrupted") {
    return (
      <Link
        href="/generate"
        className="flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-amber-500/40 bg-amber-500/5 p-3 text-center transition hover:bg-amber-500/10"
      >
        <span className="text-2xl" aria-hidden>
          ⚠️
        </span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
          생성이 중단됐어요
        </span>
        <span className="text-[11px] text-zinc-500">탭해서 다시 만들기</span>
      </Link>
    );
  }
  // ready — 3장 완성, 고르기 대기
  return (
    <Link
      href={`/generate?resume=${gen.id}`}
      className="group relative flex aspect-square flex-col overflow-hidden rounded-2xl border border-emerald-500/40 bg-foreground/5 transition hover:border-emerald-500/70"
    >
      <div className="grid flex-1 grid-cols-3 gap-px bg-foreground/10">
        {gen.candidateUrls.slice(0, 3).map((url, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={url}
            alt=""
            className="h-full w-full object-cover"
          />
        ))}
      </div>
      <div className="flex items-center justify-center gap-1 bg-emerald-500/15 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
        고르던 인형 이어서 →
      </div>
    </Link>
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
  onRoleChange,
  deletingIds,
}: {
  dolls: Doll[];
  onDelete: (id: string) => void;
  onRoleChange: (id: string, role: RoleId) => void;
  deletingIds: Set<string>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {dolls.map((d) => (
        <DollCard
          key={d.id}
          doll={d}
          deleting={deletingIds.has(d.id)}
          onDelete={() => onDelete(d.id)}
          onRoleChange={onRoleChange}
        />
      ))}
    </div>
  );
}

function DollCard({
  doll,
  deleting,
  onDelete,
  onRoleChange,
}: {
  doll: Doll;
  deleting: boolean;
  onDelete: () => void;
  onRoleChange: (id: string, role: RoleId) => void;
}) {
  const role = asRole(doll.role);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [roleMenu, setRoleMenu] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const flash = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 1800);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setRoleMenu(false);
  };

  const handleShare = async () => {
    closeMenu();
    if (sharing) return;
    setSharing(true);
    try {
      const result = await shareDoll(doll.image_url, doll.id, role);
      if (result === "copied") flash("링크 복사됨");
      else if (result === "failed") flash("공유 실패");
    } finally {
      setSharing(false);
    }
  };

  const handleRole = async (next: RoleId) => {
    if (savingRole) return;
    if (next === role) {
      closeMenu();
      return;
    }
    closeMenu(); // 메뉴 닫고 카드 오버레이("변경 중…")로 진행 표시
    setSavingRole(true);
    try {
      const r = await fetch("/api/doll", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: doll.id, role: next }),
      });
      if (!r.ok) {
        flash("롤 변경 실패");
        return;
      }
      onRoleChange(doll.id, next);
      flash(`${ROLE_META[next].chip}${josaEuro(ROLE_META[next].chip)} 변경`);
    } catch {
      flash("롤 변경 실패");
    } finally {
      setSavingRole(false);
    }
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

        {/* 롤 변경 진행 중 — 카드 dim + 스피너 (탭/대기 구분) */}
        {savingRole && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[2px]">
            <Spinner className="h-6 w-6 text-white" />
            <span className="text-xs font-medium text-white/90">변경 중…</span>
          </div>
        )}
      </div>

      {/* 롤 칩 (좌상단 — ⋯ 버튼/공유 스피너와 안 겹치게) */}
      <span className="pointer-events-none absolute left-2 top-2 z-20 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
        {ROLE_META[role].chip}
      </span>

      {/* ⋯ 옵션 버튼 — 공유/롤 변경/삭제 메뉴 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRoleMenu(false);
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
              closeMenu();
            }}
          />
          <div className="absolute right-2 top-12 z-30 w-36 overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-2xl">
            {roleMenu ? (
              ROLE_IDS.map((rid) => (
                <MenuItem key={rid} onClick={() => void handleRole(rid)}>
                  {ROLE_META[rid].chip}
                  {rid === role ? " ✓" : ""}
                </MenuItem>
              ))
            ) : (
              <>
                <MenuItem onClick={handleShare}>공유</MenuItem>
                <MenuItem onClick={() => setRoleMenu(true)}>롤 변경</MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    onDelete();
                  }}
                  danger
                >
                  삭제
                </MenuItem>
              </>
            )}
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
