"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getMyProfile, formatCredits, type MyProfile } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { DefaultBossCard } from "@/components/gallery/DefaultBossCard";
import { SignupBanner } from "@/components/gallery/SignupBanner";
import { PendingGrid } from "@/components/gallery/PendingGrid";
import { DollCard, type Doll } from "@/components/gallery/DollCard";
import { ctaFor, type ViewerState } from "@/lib/gallery-cta";
import type { RoleId } from "@/lib/roles";
import type { PendingGeneration } from "@/lib/generation";

export default function GalleryPage() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [dolls, setDolls] = useState<Doll[]>([]);
  const [pending, setPending] = useState<PendingGeneration[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  // 단일 순차 부트스트랩 — getMyProfile() 이 익명 세션을 1회 보장(ensureAuth 내부 호출)한 뒤
  // 같은 세션으로 dolls 조회. ensureAuth/getMyProfile 병렬 호출 금지(signInAnonymously 경쟁 방지).
  // profile null/실패 → nonmember fallback. 비회원은 /api/generations·생성권 모두 스킵.
  const bootstrap = useCallback(async () => {
    let prof: MyProfile | null = null;
    try {
      prof = await getMyProfile();
    } catch {
      /* 조회 실패 → nonmember fallback */
    }
    setProfile(prof);

    try {
      const sb = createClient();
      const { data, error: queryError } = await sb
        .from("dolls")
        .select("id, image_url, created_at, role")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      setDolls((data as Doll[] | null) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
      setDolls([]);
    } finally {
      setLoading(false);
    }

    if (prof?.isMember) void loadPending(); // 회원만 — 비회원은 생성 자체가 없음
  }, [loadPending]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 생성 중인 게 있으면 완료 감지 위해 폴링 (회원만 pending 이 채워짐)
  useEffect(() => {
    if (!pending.some((p) => p.kind === "generating")) return;
    const t = setInterval(() => void loadPending(), 4000);
    return () => clearInterval(t);
  }, [pending, loadPending]);

  const handleRoleChange = useCallback((id: string, role: RoleId) => {
    setDolls((prev) => prev.map((d) => (d.id === id ? { ...d, role } : d)));
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
      setDolls((prev) => prev.filter((d) => d.id !== id));
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

  // 뷰어 상태 — 비회원/프로필없음=nonmember, 회원이지만 0캐릭터=member-empty, 회원+캐릭터=member.
  const state: ViewerState = !profile?.isMember
    ? "nonmember"
    : dolls.length === 0
      ? "member-empty"
      : "member";
  const isMember = profile?.isMember === true;
  const genCredits = isMember ? (profile?.genCredits ?? null) : null;

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          {loading ? (
            <GridSkeleton />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <h1 className="text-2xl font-bold">
                    {state === "member" ? "내 캐릭터들" : "캐릭터 갤러리"}
                  </h1>
                  {genCredits != null && (
                    <span className="text-sm text-zinc-500">
                      생성권 {formatCredits(genCredits)}
                    </span>
                  )}
                </div>
                <Link
                  href={ctaFor(state).href}
                  className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90"
                >
                  + 새로 만들기
                </Link>
              </div>

              <SignupBanner state={state} />

              {isMember && pending.length > 0 && <PendingGrid pending={pending} />}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <DefaultBossCard state={state} />
                {dolls.map((d) => (
                  <DollCard
                    key={d.id}
                    doll={d}
                    deleting={deletingIds.has(d.id)}
                    onDelete={() => handleDelete(d.id)}
                    onRoleChange={handleRoleChange}
                  />
                ))}
              </div>

              {error && (
                <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </>
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
