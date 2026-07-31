"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getMyProfile, formatCredits, type MyProfile } from "@/lib/profile";
import { DefaultBossCard } from "@/components/gallery/DefaultBossCard";
import { SignupBanner } from "@/components/gallery/SignupBanner";
import { EventBanner } from "@/components/events/EventBanner";
import { PendingGrid } from "@/components/gallery/PendingGrid";
import { DollCard, type Doll } from "@/components/gallery/DollCard";
import { ctaFor, type ViewerState } from "@/lib/gallery-cta";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import type { RoleId } from "@/lib/roles";
import type { PendingGeneration } from "@/lib/generation";
import { parseDollSignedUrlResponse } from "@/lib/doll-signed-url-response";
import { parseDollDeleteHttpAck } from "@/lib/storage-mutation-result";
import {
  galleryCursorFilter,
  mergeUniqueGalleryRows,
  nextGalleryCursor,
  parseGalleryDollRows,
  type GalleryCursor,
} from "@/lib/gallery-pagination";
import { pollGalleryPendingGenerations } from "@/lib/gallery-pending-poll";
import {
  clientMutationResponseNeedsReconciliation,
  runBoundedClientJsonFetch,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";
import { runBoundedClientOperation } from "@/lib/client-operation";

const GALLERY_PAGE = 12; // 무한스크롤 페이지 크기

// 갤러리 썸네일 서명 URL 클라 캐시(id→{url,만료}). 갤러리 이탈→재진입 시 서명 재발급 대신 재사용
// → FadeImg src 안정(브라우저 캐시 히트)으로 전 캐릭터 재페이드 방지. 서버 ttl(600s) 안쪽 보수값.
// 모듈 레벨이라 컴포넌트 remount 를 넘어 세션 동안 유지(전체 새로고침 시 초기화).
const signedUrlCache = new Map<string, { url: string; exp: number }>();
const SIGNED_URL_CACHE_MS = 8 * 60 * 1000;

export default function GalleryPage() {
  const mk = useMarketingCopy();
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [dolls, setDolls] = useState<Doll[]>([]);
  const [pending, setPending] = useState<PendingGeneration[]>([]);
  const [pendingLoadError, setPendingLoadError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<GalleryCursor | null>(null);
  const loadingMoreRef = useRef(false);
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const requestEpochRef = useRef(0);
  const pendingPollEpochRef = useRef(0);
  const pendingPollAbortRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [pendingPollRun, setPendingPollRun] = useState(0);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      mountedRef.current = false;
      controller.abort(new Error("gallery_unmounted"));
      if (lifecycleRef.current === controller) lifecycleRef.current = null;
    };
  }, []);

  // 한 페이지 조회 + 384px 썸네일 서명(무한스크롤). RLS 로 본인 doll 만.
  // (created_at,id) keyset은 삽입/삭제가 앞 페이지를 밀어도 다음 페이지를 건너뛰거나
  // 반복하지 않는다. 커서는 서명 race로 필터링되기 전 raw 페이지 마지막 행이다.
  const fetchDollPage = useCallback(async (
    cursor: GalleryCursor | null,
  ): Promise<{
    rows: Doll[];
    nextCursor: GalleryCursor | null;
    hasMore: boolean;
  }> => {
    const { data, error: qErr } = await runBoundedClientOperation(
      (signal) => {
        let query = createClient()
          .from("dolls")
          .select("id, image_url, created_at, role")
          .is("deleted_at", null) // takedown: 신고 삭제 캐릭터 숨김
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(GALLERY_PAGE)
          .abortSignal(signal);
        if (cursor) query = query.or(galleryCursorFilter(cursor));
        return query;
      },
      { signal: lifecycleRef.current?.signal },
    );
    if (qErr) throw qErr;
    const rawRows = parseGalleryDollRows(data);
    const nextCursor = nextGalleryCursor(rawRows, GALLERY_PAGE);
    let rows: Doll[] = rawRows;
    if (rows.length) {
      const now = Date.now();
      let missingIds = new Set<string>();
      // 캐시 미스/만료된 id 만 서명 재요청 — 재진입 시 같은 URL 재사용(브라우저 캐시 히트)으로 재페이드 방지.
      const missIds = rows
        .map((d) => d.id)
        .filter((id) => {
          const c = signedUrlCache.get(id);
          return !c || c.exp <= now;
      });
      if (missIds.length) {
        const delivery = await runBoundedClientJsonFetch({
          input: "/api/doll/signed-urls",
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: missIds, thumb: true }),
          },
          signal: lifecycleRef.current?.signal,
        });
        if (delivery.kind !== "confirmed") {
          throw new Error("캐릭터 이미지 응답을 확인하지 못했어요.");
        }
        const { response: r, body: json } = delivery.value;
        if (!r.ok) {
          throw new Error("캐릭터 이미지를 불러오지 못했어요.");
        }
        const signed = parseDollSignedUrlResponse(missIds, json);
        missingIds = signed.missingIds;
        for (const [id, url] of signed.urls) {
          signedUrlCache.set(id, {
            url,
            exp: now + SIGNED_URL_CACHE_MS,
          });
        }
      }
      rows = rows
        .filter((d) => !missingIds.has(d.id))
        .map((d) => {
          const signed = signedUrlCache.get(d.id);
          if (!signed) {
            throw new Error("캐릭터 이미지 응답이 불완전해요.");
          }
          return { ...d, image_url: signed.url };
        });
    }
    return { rows, nextCursor, hasMore: nextCursor !== null };
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    const cursor = cursorRef.current;
    if (!cursor) {
      setHasMore(false);
      return;
    }
    const epoch = requestEpochRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchDollPage(cursor);
      if (requestEpochRef.current !== epoch) return;
      cursorRef.current = page.nextCursor;
      setDolls((prev) => mergeUniqueGalleryRows(prev, page.rows));
      setHasMore(page.hasMore);
    } catch (error) {
      if (requestEpochRef.current !== epoch) return;
      setError(
        error instanceof Error
          ? error.message
          : "추가 캐릭터를 불러오지 못했어요.",
      );
    } finally {
      if (requestEpochRef.current === epoch) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [hasMore, fetchDollPage]);

  // 단일 순차 부트스트랩 — getMyProfile() 이 익명 세션을 1회 보장(ensureAuth 내부 호출)한 뒤
  // 같은 세션으로 dolls 조회. ensureAuth/getMyProfile 병렬 호출 금지(signInAnonymously 경쟁 방지).
  // profile null은 실제 no-row일 때만 nonmember. DB 장애는 비회원으로 축소하지 않고 재시도 UI를 낸다.
  const bootstrap = useCallback(async () => {
    const epoch = requestEpochRef.current + 1;
    requestEpochRef.current = epoch;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    let prof: MyProfile | null = null;
    setProfileLoadError(null);
    setError(null);
    setLoading(true);
    try {
      prof = await getMyProfile();
    } catch {
      if (requestEpochRef.current !== epoch) return;
      setProfileLoadError("계정 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
      setLoading(false);
      return;
    }
    if (requestEpochRef.current !== epoch) return;
    setProfile(prof);

    try {
      const page = await fetchDollPage(null);
      if (requestEpochRef.current !== epoch) return;
      cursorRef.current = page.nextCursor;
      setDolls(mergeUniqueGalleryRows([], page.rows));
      setHasMore(page.hasMore);
    } catch (e) {
      if (requestEpochRef.current !== epoch) return;
      setError(e instanceof Error ? e.message : "불러오기 실패");
      setDolls([]);
    } finally {
      if (requestEpochRef.current === epoch) setLoading(false);
    }

  }, [fetchDollPage]);

  // 무한스크롤 — 그리드 하단 sentinel 이 보이면 다음 페이지 로드.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  useEffect(() => {
    // 마운트 시 초기 목록 로드(1회) — bootstrap 내부 setState 는 의도적 데이터 로딩.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void bootstrap();
    return () => {
      requestEpochRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, [bootstrap]);

  // 회원 진입/수동 재시도마다 즉시 1회 확인하고, generating이 있는 동안에만
  // 단일 self-scheduled loop를 유지한다. interval 중첩·역순 응답·언마운트
  // setState를 epoch + AbortController로 함께 차단한다.
  useEffect(() => {
    if (profile?.isLoggedIn !== true) {
      pendingPollAbortRef.current?.abort();
      pendingPollAbortRef.current = null;
      return;
    }
    const epoch = pendingPollEpochRef.current + 1;
    pendingPollEpochRef.current = epoch;
    pendingPollAbortRef.current?.abort();
    const abort = new AbortController();
    pendingPollAbortRef.current = abort;

    void pollGalleryPendingGenerations({
      signal: abort.signal,
      onRows: (rows) => {
        if (
          !abort.signal.aborted &&
          pendingPollEpochRef.current === epoch
        ) {
          setPending(rows);
          setPendingLoadError(null);
        }
      },
      onError: () => {
        if (
          !abort.signal.aborted &&
          pendingPollEpochRef.current === epoch
        ) {
          setPendingLoadError(
            "진행 중인 캐릭터 생성 상태를 불러오지 못했어요.",
          );
        }
      },
    })
      .then((outcome) => {
        if (
          abort.signal.aborted ||
          pendingPollEpochRef.current !== epoch
        ) {
          return;
        }
        if (outcome === "timeout") {
          setPendingLoadError(
            "자동 상태 확인 시간이 끝났어요. 아래 버튼으로 다시 확인해주세요.",
          );
        } else if (outcome === "unavailable") {
          setPendingLoadError(
            "생성 상태 확인이 반복해서 실패했어요. 잠시 후 다시 시도해주세요.",
          );
        }
        if (pendingPollAbortRef.current === abort) {
          pendingPollAbortRef.current = null;
        }
      })
      .catch(() => {
        if (
          !abort.signal.aborted &&
          pendingPollEpochRef.current === epoch
        ) {
          setPendingLoadError(
            "자동 상태 확인을 시작할 수 없어요. 아래 버튼으로 다시 확인해주세요.",
          );
        }
        if (pendingPollAbortRef.current === abort) {
          pendingPollAbortRef.current = null;
        }
      });

    return () => {
      if (pendingPollEpochRef.current === epoch) {
        pendingPollEpochRef.current += 1;
      }
      abort.abort();
      if (pendingPollAbortRef.current === abort) {
        pendingPollAbortRef.current = null;
      }
    };
  }, [profile?.isLoggedIn, pendingPollRun]);

  const handleRoleChange = useCallback((id: string, role: RoleId) => {
    setDolls((prev) => prev.map((d) => (d.id === id ? { ...d, role } : d)));
  }, []);

  const handleDelete = async (id: string) => {
    if (deletingIdsRef.current.has(id)) return;
    if (!confirm("이 캐릭터를 삭제할까요?")) return;
    // State는 다음 render 전까지 closure에 반영되지 않는다. ref를 동기 점유해
    // double activation도 같은 doll DELETE 한 건으로 직렬화한다.
    deletingIdsRef.current.add(id);
    setDeletingIds((prev) => new Set(prev).add(id));
    setError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const outcome = await runReplayedJsonMutation({
        input: `/api/doll?id=${encodeURIComponent(id)}`,
        init: { method: "DELETE" },
        signal: controller.signal,
        classify: (response, body) => {
          const acknowledgement = response.ok
            ? parseDollDeleteHttpAck(body)
            : null;
          if (acknowledgement) {
            return {
              kind: "confirmed",
              value: acknowledgement,
            };
          }
          const error =
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as Record<string, unknown>).error ===
              "string"
              ? String((body as Record<string, unknown>).error)
              : null;
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "doll_delete_response_unconfirmed",
              error,
            };
          }
          return {
            kind: "rejected",
            error: error ?? `doll_delete_http_${response.status}`,
          };
        },
      });
      if (outcome.kind !== "confirmed") {
        const error =
          outcome.kind === "rejected" &&
          typeof outcome.error === "string"
            ? outcome.error
            : "삭제 결과를 확인하지 못했어요.";
        throw new Error(error);
      }
      if (mountedRef.current) {
        setDolls((prev) => prev.filter((d) => d.id !== id));
      }
      // keyset cursor는 앞선 행 삭제로 위치가 밀리지 않으므로 보정하지 않는다.
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "삭제 실패");
      }
    } finally {
      window.clearTimeout(timeoutId);
      deletingIdsRef.current.delete(id);
      // 이 id 만 해제 — 동시에 진행 중인 다른 삭제의 스피너를 건드리지 않음.
      if (mountedRef.current) {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  };

  // 뷰어 상태 — 비회원/프로필없음=nonmember, 회원이지만 0캐릭터=member-empty, 회원+캐릭터=member.
  const state: ViewerState = !profile?.isLoggedIn
    ? "nonmember"
    : dolls.length === 0
      ? "member-empty"
      : "member";
  const canUse = profile?.isLoggedIn === true;
  const genCredits = canUse ? (profile?.genCredits ?? null) : null;

  return (
    <>
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          {/* 헤더(제목·생성권·새로 만들기) — 정적이라 fetch 전에도 표시. 그리드만 스켈레톤. */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h1 className="text-2xl font-bold">내 캐릭터들</h1>
              {genCredits != null && (
                <span className="text-sm text-zinc-500">
                  생성권 {formatCredits(genCredits)}
                </span>
              )}
            </div>
            <Link
              // 로딩 중엔 state 가 nonmember 기본값이라 회원이 눌러도 /login 으로 새지 않게 /generate 고정
              // (proxy 가 비회원은 /login?next=/generate 로 동일 게이트). 로드 후엔 state별 ctaFor.
              href={loading || profileLoadError ? "/generate" : ctaFor(state).href}
              className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-paper-2 transition hover:opacity-90"
            >
              {mk.signupBanner.memberHeaderCta}
            </Link>
          </div>

          <EventBanner surface="gallery" />

          {profileLoadError ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-500">
              <p>{profileLoadError}</p>
              <button
                type="button"
                onClick={() => void bootstrap()}
                className="mt-3 rounded-full border border-red-500/30 px-4 py-2 font-semibold"
              >
                다시 불러오기
              </button>
            </div>
          ) : loading ? (
            <GridSkeleton />
          ) : (
            <>
              <SignupBanner state={state} />

              {canUse && pending.length > 0 && <PendingGrid pending={pending} />}
              {canUse && pendingLoadError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-500"
                >
                  <p>{pendingLoadError}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingLoadError(null);
                      setPendingPollRun((run) => run + 1);
                    }}
                    className="mt-2 font-semibold underline underline-offset-2"
                  >
                    생성 상태 다시 확인
                  </button>
                </div>
              )}

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

              {hasMore && <div ref={sentinelRef} className="h-4" />}
              {loadingMore && (
                <div className="flex justify-center py-2">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/60" />
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400"
                >
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={() => void bootstrap()}
                    className="mt-2 font-semibold underline underline-offset-2"
                  >
                    다시 시도
                  </button>
                </div>
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
          className="aspect-square animate-pulse rounded-2xl border border-foreground/10 ui-surface"
        />
      ))}
    </div>
  );
}
