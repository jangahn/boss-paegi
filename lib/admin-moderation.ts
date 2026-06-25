import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import { log, errInfo } from "@/lib/log";

/**
 * 모더레이션 큐 — **캐릭터 단위**(신고된 / 숨김 / 영구삭제된 doll). server-only, service_role.
 * 처리상태 단일축: pending(대기·미결정 신고) · hidden(숨김·가역) · purged(영구삭제·비가역) · dismissed(기각·공개유지).
 * 집계·상태계산·필터·페이지는 `admin_moderation_queue` RPC(PostgREST 임베드 모호성 회피·집계 한방). 이미지만 서명.
 */
export const REPORT_PAGE_SIZE = 10;

export const MOD_STATES = ["pending", "hidden", "purged", "dismissed"] as const;
export type ModState = (typeof MOD_STATES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ModReport = {
  id: string;
  reason: string;
  detail: string | null;
  contact: string | null;
  status: string; // pending | actioned | dismissed
  created_at: string;
};

export type ModerationRow = {
  dollId: string;
  image_url: string | null; // 서명됨(공개/숨김) 또는 null(영구삭제)
  owner_id: string | null;
  owner_name: string | null;
  deleted_at: string | null;
  artifacts_purged_at: string | null;
  state: ModState;
  report_count: number;
  pending_count: number;
  latest_report_at: string | null;
  reports: ModReport[];
};

export type ModerationFilters = {
  state?: ModState | null;
  dollId?: string | null;
  ownerId?: string | null;
  page?: number;
};

export type ModerationQueuePage = {
  rows: ModerationRow[];
  total: number;
  page: number;
  pageSize: number;
};

const EMPTY = (page: number): ModerationQueuePage => ({
  rows: [],
  total: 0,
  page,
  pageSize: REPORT_PAGE_SIZE,
});

/** adminId = requireAdmin 통과한 호출자(RPC 내부에서도 is_admin 재검증). */
export async function getModerationQueue(
  adminId: string,
  f: ModerationFilters
): Promise<ModerationQueuePage> {
  const page = Math.max(1, f.page ?? 1);
  if (f.dollId && !UUID_RE.test(f.dollId)) return EMPTY(page);
  if (f.ownerId && !UUID_RE.test(f.ownerId)) return EMPTY(page);

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_moderation_queue", {
    p_admin_id: adminId,
    p_state: f.state ?? null,
    p_doll_id: f.dollId ?? null,
    p_owner_id: f.ownerId ?? null,
    p_limit: REPORT_PAGE_SIZE,
    p_offset: (page - 1) * REPORT_PAGE_SIZE,
  });
  if (error) {
    log.warn("admin.mod_queue_fail", errInfo(error));
    return EMPTY(page);
  }
  const result = (data ?? { rows: [], total: 0 }) as {
    rows: Omit<ModerationRow, never>[];
    total: number;
  };

  // 이미지 서명: 영구삭제(purged)면 객체 없음→null(플레이스홀더). 아니면 서명(공개·숨김 모두 어드민은 얼굴 확인).
  const rows: ModerationRow[] = [];
  for (const r of result.rows as ModerationRow[]) {
    rows.push({
      ...r,
      image_url: r.artifacts_purged_at ? null : await signedDollUrl(r.image_url, 600, { thumb: true }),
    });
  }
  return { rows, total: result.total ?? 0, page, pageSize: REPORT_PAGE_SIZE };
}
