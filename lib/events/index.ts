import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTS_BUCKET } from "@/lib/storage-path";
import {
  readSupabaseRowsPaginated,
  requireSupabaseData,
  requireSupabaseOptionalData,
  requireSupabasePage,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  activeEventsCacheForMs,
  parseActiveEventsResponse,
  type ActiveEvents,
} from "@/lib/active-events-response";
import {
  NEWS_PAGE_SIZE,
  coverPathSchema,
  isEventType,
  type BannerSurface,
  type EventRow,
  type EventType,
  type EventView,
} from "./types";

// 공개 노출은 항상 서버에서 service_role 로 읽어 **발행본+윈도우+미삭제만** 투영(테이블은 anon/auth revoke).
const COLS =
  "id, type, status, title, summary, body, cover_image_path, starts_at, ends_at, popup_active, banner_home_active, banner_gallery_active, banner_leaderboard_active, priority, pinned, noindex, popup_dismiss_days, published_at, created_by, created_at, updated_at, deleted_at, mutation_version";

/**
 * 커버 변환(on-the-fly) — 원본 1장에서 표시 시점 리사이즈(갤러리 DOLL_THUMB 패턴과 동일).
 * 둘 다 **40:21**(=1200/630, 1.905)·**resize:cover** 로 목록 썸네일·og 프레이밍을 통일하고
 * 풀 원본(~수백KB) 대신 webp ~수십KB 만 받게 한다. width/height 둘 다 필수(한쪽만이면 왜곡).
 * events 버킷은 public 이라 서명 불요 — getPublicUrl 의 transform 옵션으로 render URL 파생.
 */
const COVER_THUMB_TRANSFORM = { width: 600, height: 315, resize: "cover" } as const;
const COVER_OG_TRANSFORM = { width: 1200, height: 630, resize: "cover" } as const;

/** cover_image_path(상대경로) → events 버킷 public URL(없으면 null). transform 주면 변환 render URL. */
function coverUrl(
  path: string | null,
  transform?: { width: number; height: number; resize: "cover" }
): string | null {
  if (!path) return null;
  const admin = createAdminClient();
  const url = admin.storage
    .from(EVENTS_BUCKET)
    .getPublicUrl(path, transform ? { transform } : undefined).data.publicUrl;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      !parsed.hostname
    ) {
      throw new Error("invalid_public_url");
    }
  } catch (error) {
    throw new SupabaseOperationError("events.cover_url", error);
  }
  return url;
}

const EVENT_ROW_SCHEMA = {
  id: "uuid",
  type: "string",
  status: "string",
  title: "string",
  summary: "string",
  body: "string",
  cover_image_path: "nullableString",
  starts_at: "nullableTimestamp",
  ends_at: "nullableTimestamp",
  popup_active: "boolean",
  banner_home_active: "boolean",
  banner_gallery_active: "boolean",
  banner_leaderboard_active: "boolean",
  priority: "safeInteger",
  pinned: "boolean",
  noindex: "boolean",
  popup_dismiss_days: "nonnegativeInteger",
  published_at: "nullableTimestamp",
  created_by: "nullableUuid",
  created_at: "timestamp",
  updated_at: "timestamp",
  deleted_at: "nullableTimestamp",
  mutation_version: "nonnegativeInteger",
} as const;

function validateEventRows(operation: string, value: unknown): EventRow[] {
  const rows = validateAdminRows<EventRow>(operation, value, EVENT_ROW_SCHEMA);
  for (const row of rows) {
    const invalidWindow =
      row.starts_at !== null &&
      row.ends_at !== null &&
      Date.parse(row.starts_at) >= Date.parse(row.ends_at);
    if (
      !isEventType(row.type) ||
      (row.status !== "draft" && row.status !== "published") ||
      !coverPathSchema.safeParse(row.cover_image_path).success ||
      row.title.length > 200 ||
      row.summary.length > 200 ||
      row.body.length > 50_000 ||
      row.priority < -1_000 ||
      row.priority > 1_000 ||
      row.popup_dismiss_days < 1 ||
      row.popup_dismiss_days > 365 ||
      invalidWindow
    ) {
      throw new SupabaseOperationError(
        operation,
        new Error("invalid_event_row"),
      );
    }
  }
  return rows;
}
function toView(row: EventRow): EventView {
  return {
    ...row,
    coverUrl: coverUrl(row.cover_image_path),
    coverThumbUrl: coverUrl(row.cover_image_path, COVER_THUMB_TRANSFORM),
    coverOgUrl: coverUrl(row.cover_image_path, COVER_OG_TRANSFORM),
  };
}

// ── 공개 목록 ─────────────────────────────────────────────
/** 공개 목록(페이징·타입 필터). 예약 경계는 요청의 정확한 서버 시각으로 평가한다. */
export async function getPublishedEvents(opts?: {
  type?: EventType | null;
  page?: number;
}): Promise<{ items: EventView[]; total: number; totalPages: number }> {
  const type = opts?.type ?? null;
  const page = Math.max(1, opts?.page ?? 1);
  const now = new Date().toISOString();
  const from = (page - 1) * NEWS_PAGE_SIZE;
  const admin = createAdminClient();
  let query = admin
    .from("events")
    .select(COLS, { count: "exact" })
    .eq("status", "published")
    .is("deleted_at", null)
    // starts_at is inclusive and ends_at is exclusive.
    .or(`starts_at.is.null,starts_at.lte.${now}`)
    .or(`ends_at.is.null,ends_at.gt.${now}`);
  if (type) query = query.eq("type", type);
  const result = await requireSupabasePage<EventRow>(
    "events.published_list",
    () =>
      query
        .order("pinned", { ascending: false })
        .order("published_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + NEWS_PAGE_SIZE - 1),
  );
  const total = result.count;
  return {
    items: validateEventRows("events.published_list", result.rows).map(toView),
    total,
    totalPages: Math.max(1, Math.ceil(total / NEWS_PAGE_SIZE)),
  };
}

// ── 공개 단건 ─────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 공개 상세 — 발행+윈도우+미삭제만(draft/예약/만료/삭제 → null → notFound). 비-UUID는 즉시 null. */
export async function getEventById(id: string): Promise<EventView | null> {
  if (!UUID_RE.test(id)) return null;
  const now = new Date().toISOString();
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData("events.by_id", () =>
    admin
      .from("events")
      .select(COLS)
      .eq("id", id)
      .eq("status", "published")
      .is("deleted_at", null)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .maybeSingle(),
  );
  return data
    ? toView(validateEventRows("events.by_id", [data])[0]!)
    : null;
}

// ── 팝업/배너 원자 snapshot ───────────────────────────────
export type ActiveEventSurfaces = ActiveEvents;

const ACTIVE_EVENT_SNAPSHOT_ATTEMPTS = 3;
const ACTIVE_EVENT_SNAPSHOT_RPC_TIMEOUT_MS = 5_000;

const monotonicNow = () =>
  typeof performance !== "undefined" &&
  typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Four surfaces and the next scheduled transition come from one SQL statement
 * (`get_active_event_surfaces`). PostgreSQL therefore binds every pick to one
 * MVCC snapshot even if an admin publishes, deletes, reprioritizes, or changes
 * flags concurrently.
 *
 * A transition can still pass while that single RPC is in flight. Compare the
 * DB-authored interval with the full monotonic RPC duration (never the app
 * server wall clock, which may be skewed) and retry a bounded number of times.
 */
export async function getActiveEventSurfaces(): Promise<ActiveEventSurfaces> {
  for (
    let attempt = 0;
    attempt < ACTIVE_EVENT_SNAPSHOT_ATTEMPTS;
    attempt += 1
  ) {
    const startedAt = monotonicNow();
    const raw = await requireSupabaseData<unknown>(
      "events.active_snapshot",
      () =>
        createAdminClient()
          .rpc("get_active_event_surfaces")
          .abortSignal(
            AbortSignal.timeout(ACTIVE_EVENT_SNAPSHOT_RPC_TIMEOUT_MS),
          ),
    );
    const elapsedMs = Math.max(0, monotonicNow() - startedAt);
    const snapshot = parseActiveEventsResponse(raw);
    if (!snapshot) {
      throw new SupabaseOperationError(
        "events.active_snapshot",
        new Error("invalid_active_event_snapshot"),
      );
    }
    if (activeEventsCacheForMs(snapshot, elapsedMs) === null) continue;
    return snapshot;
  }
  throw new SupabaseOperationError(
    "events.active_snapshot",
    new Error("active_event_transition_churn"),
  );
}

/** 홈 진입 팝업 1건(우선순위 deterministic). */
export async function getActivePopupEvent() {
  return (await getActiveEventSurfaces()).popup;
}
/** 지면별 배너 1건(홈·갤러리·랭킹 각 독립, 우선순위 deterministic). */
export async function getActiveBanner(surface: BannerSurface) {
  return (await getActiveEventSurfaces()).banners[surface];
}

// ── sitemap ──────────────────────────────────────────────
/** 색인 대상(published·윈도우 active·미삭제·noindex=false) /news/[id] 목록. */
export async function getSitemapEvents(): Promise<
  { id: string; updated_at: string }[]
> {
  const now = new Date().toISOString();
  const admin = createAdminClient();
  const data = await readSupabaseRowsPaginated<{
    id: string;
    updated_at: string;
  }>(
    "events.sitemap",
    (offset, limit) =>
      admin
        .from("events")
        .select("id, updated_at")
        .eq("status", "published")
        .is("deleted_at", null)
        .eq("noindex", false)
        .or(`starts_at.is.null,starts_at.lte.${now}`)
        .or(`ends_at.is.null,ends_at.gt.${now}`)
        .order("published_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1),
  );
  return validateAdminRows("events.sitemap", data, {
    id: "uuid",
    updated_at: "timestamp",
  });
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
  const result = await requireSupabasePage<EventRow>("events.admin_list", () =>
    q
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + NEWS_PAGE_SIZE - 1),
  );
  const total = result.count;
  return {
    items: validateEventRows("events.admin_list", result.rows).map(toView),
    total,
    totalPages: Math.max(1, Math.ceil(total / NEWS_PAGE_SIZE)),
  };
}

/** 어드민 단건 — 상태 무관·미삭제(에디터). */
export async function getAdminEventById(id: string): Promise<EventView | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData("events.admin_by_id", () =>
    admin
      .from("events")
      .select(COLS)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
  );
  return data
    ? toView(validateEventRows("events.admin_by_id", [data])[0]!)
    : null;
}
