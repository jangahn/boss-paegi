import "server-only";
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTS_BUCKET } from "@/lib/storage-path";
import { NEWS_PAGE_SIZE, type EventRow, type EventType, type EventView } from "./types";

// 공개 노출은 항상 서버에서 service_role 로 읽어 **발행본+윈도우+미삭제만** 투영(테이블은 anon/auth revoke).
const COLS =
  "id, type, status, title, summary, body, cover_image_path, starts_at, ends_at, popup_active, banner_active, priority, pinned, noindex, popup_dismiss_days, published_at, created_by, created_at, updated_at, deleted_at";

/** cover_image_path(상대경로) → events 버킷 public URL(없으면 null). */
function coverUrl(path: string | null): string | null {
  if (!path) return null;
  const admin = createAdminClient();
  return admin.storage.from(EVENTS_BUCKET).getPublicUrl(path).data.publicUrl ?? null;
}
function toView(row: EventRow): EventView {
  return { ...row, coverUrl: coverUrl(row.cover_image_path) };
}

/**
 * 60초 버킷 — 윈도우 비교(now)를 분 단위로 양자화해 unstable_cache 키를 안정화.
 * 효과: 분당 1회만 재조회(캐시 효율) + starts_at/ends_at 자동 노출·만료 ≤60초 지연(MVP 허용).
 * revalidateTag('events') 는 키와 무관하게 즉시 무효화(발행/수정/삭제 시).
 */
function nowBucket(): number {
  return Math.floor(Date.now() / 60_000);
}
function bucketIso(bucket: number): string {
  return new Date(bucket * 60_000).toISOString();
}

// ── 공개 목록 ─────────────────────────────────────────────
const _getPublishedEvents = unstable_cache(
  async (
    type: EventType | null,
    page: number,
    bucket: number
  ): Promise<{ items: EventView[]; total: number; totalPages: number }> => {
    const now = bucketIso(bucket);
    const from = (page - 1) * NEWS_PAGE_SIZE;
    const admin = createAdminClient();
    let q = admin
      .from("events")
      .select(COLS, { count: "exact" })
      .eq("status", "published")
      .is("deleted_at", null)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`);
    if (type) q = q.eq("type", type);
    const { data, count } = await q
      .order("pinned", { ascending: false })
      .order("published_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + NEWS_PAGE_SIZE - 1);
    const total = count ?? 0;
    return {
      items: ((data as EventRow[] | null) ?? []).map(toView),
      total,
      totalPages: Math.max(1, Math.ceil(total / NEWS_PAGE_SIZE)),
    };
  },
  ["events-list"],
  { revalidate: 60, tags: ["events"] }
);

/** 공개 목록(페이징·타입 필터). */
export function getPublishedEvents(opts?: { type?: EventType | null; page?: number }) {
  return _getPublishedEvents(opts?.type ?? null, Math.max(1, opts?.page ?? 1), nowBucket());
}

// ── 공개 단건 ─────────────────────────────────────────────
const _getEventById = unstable_cache(
  async (id: string, bucket: number): Promise<EventView | null> => {
    const now = bucketIso(bucket);
    const admin = createAdminClient();
    const { data } = await admin
      .from("events")
      .select(COLS)
      .eq("id", id)
      .eq("status", "published")
      .is("deleted_at", null)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .maybeSingle();
    return data ? toView(data as EventRow) : null;
  },
  ["events-by-id"],
  { revalidate: 60, tags: ["events"] }
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 공개 상세 — 발행+윈도우+미삭제만(draft/예약/만료/삭제 → null → notFound). 비-UUID는 즉시 null. */
export function getEventById(id: string): Promise<EventView | null> {
  if (!UUID_RE.test(id)) return Promise.resolve(null);
  return _getEventById(id, nowBucket());
}

// ── 팝업/배너 1건 픽 ──────────────────────────────────────
function pickActiveQuery(flag: "popup_active" | "banner_active", now: string) {
  const admin = createAdminClient();
  return admin
    .from("events")
    .select(COLS)
    .eq("status", "published")
    .is("deleted_at", null)
    .eq(flag, true)
    .or(`starts_at.is.null,starts_at.lte.${now}`)
    .or(`ends_at.is.null,ends_at.gt.${now}`)
    .order("priority", { ascending: false })
    .order("pinned", { ascending: false })
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
}

const _getActivePopupEvent = unstable_cache(
  async (bucket: number): Promise<EventView | null> => {
    const { data } = await pickActiveQuery("popup_active", bucketIso(bucket));
    return data ? toView(data as EventRow) : null;
  },
  ["events-popup"],
  { revalidate: 60, tags: ["events"] }
);
const _getActiveBannerEvent = unstable_cache(
  async (bucket: number): Promise<EventView | null> => {
    const { data } = await pickActiveQuery("banner_active", bucketIso(bucket));
    return data ? toView(data as EventRow) : null;
  },
  ["events-banner"],
  { revalidate: 60, tags: ["events"] }
);

/** 홈 진입 팝업 1건(우선순위 deterministic). */
export function getActivePopupEvent() {
  return _getActivePopupEvent(nowBucket());
}
/** 홈·랭킹·갤러리 공통 배너 1건. */
export function getActiveBannerEvent() {
  return _getActiveBannerEvent(nowBucket());
}

// ── sitemap ──────────────────────────────────────────────
const _getSitemapEvents = unstable_cache(
  async (bucket: number): Promise<{ id: string; updated_at: string }[]> => {
    const now = bucketIso(bucket);
    const admin = createAdminClient();
    const { data } = await admin
      .from("events")
      .select("id, updated_at")
      .eq("status", "published")
      .is("deleted_at", null)
      .eq("noindex", false)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .order("published_at", { ascending: false });
    return (data as { id: string; updated_at: string }[] | null) ?? [];
  },
  ["events-sitemap"],
  { revalidate: 60, tags: ["events"] }
);

/** 색인 대상(published·윈도우 active·미삭제·noindex=false) /news/[id] 목록. */
export function getSitemapEvents() {
  return _getSitemapEvents(nowBucket());
}

// ── 어드민(캐시 안 함 — 항상 최신) ───────────────────────────
/** 어드민 목록 — draft 포함·미삭제, 최신 수정순. */
export async function getAdminEvents(opts?: {
  status?: "draft" | "published";
  type?: EventType;
  page?: number;
}): Promise<{ items: EventView[]; total: number; totalPages: number }> {
  const page = Math.max(1, opts?.page ?? 1);
  const from = (page - 1) * NEWS_PAGE_SIZE;
  const admin = createAdminClient();
  let q = admin
    .from("events")
    .select(COLS, { count: "exact" })
    .is("deleted_at", null);
  if (opts?.status) q = q.eq("status", opts.status);
  if (opts?.type) q = q.eq("type", opts.type);
  const { data, count } = await q
    .order("updated_at", { ascending: false })
    .range(from, from + NEWS_PAGE_SIZE - 1);
  const total = count ?? 0;
  return {
    items: ((data as EventRow[] | null) ?? []).map(toView),
    total,
    totalPages: Math.max(1, Math.ceil(total / NEWS_PAGE_SIZE)),
  };
}

/** 어드민 단건 — 상태 무관·미삭제(에디터). */
export async function getAdminEventById(id: string): Promise<EventView | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("events")
    .select(COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? toView(data as EventRow) : null;
}
