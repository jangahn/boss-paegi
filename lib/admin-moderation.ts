import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import { log, errInfo } from "@/lib/log";

/**
 * 모더레이션(신고 큐 + 물리삭제 미확정) 조회 — server-only, service_role.
 * 전체 상태(pending/actioned/dismissed) + 필터(status·dollId·ownerId) + 10/page.
 */
export const REPORT_PAGE_SIZE = 10;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReportRow = {
  id: string;
  dollId: string;
  reason: string;
  detail: string | null;
  contact: string | null;
  status: string; // pending | actioned | dismissed
  created_at: string;
  resolved_at: string | null;
  doll: {
    image_url: string | null;
    owner_id: string | null;
    owner_name: string | null;
    deleted_at: string | null;
    artifacts_purged_at: string | null;
  } | null;
};

export type ReportFilters = {
  status?: string | null;
  dollId?: string | null;
  ownerId?: string | null;
  page?: number;
};

export type ReportQueuePage = {
  rows: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
};

const EMPTY = (page: number): ReportQueuePage => ({
  rows: [],
  total: 0,
  page,
  pageSize: REPORT_PAGE_SIZE,
});

export async function getReportQueue(f: ReportFilters): Promise<ReportQueuePage> {
  const page = Math.max(1, f.page ?? 1);
  const from = (page - 1) * REPORT_PAGE_SIZE;
  const admin = createAdminClient();

  // ownerId 필터: content_reports 에 owner 가 없으니 그 owner 의 doll id 들을 먼저 구해 target_id IN.
  let ownerDollIds: string[] | null = null;
  if (f.ownerId) {
    if (!UUID_RE.test(f.ownerId)) return EMPTY(page);
    const { data: od } = await admin
      .from("dolls")
      .select("id")
      .eq("owner_id", f.ownerId);
    ownerDollIds = ((od ?? []) as { id: string }[]).map((d) => d.id);
    if (ownerDollIds.length === 0) return EMPTY(page);
  }

  let qb = admin
    .from("content_reports")
    .select(
      "id, target_id, reason, detail, reporter_contact, status, created_at, resolved_at",
      { count: "exact" }
    )
    .eq("target_type", "doll");
  if (f.status) qb = qb.eq("status", f.status);
  if (f.dollId) {
    if (!UUID_RE.test(f.dollId)) return EMPTY(page);
    qb = qb.eq("target_id", f.dollId);
  }
  if (ownerDollIds) qb = qb.in("target_id", ownerDollIds);

  const { data, count, error } = await qb
    .order("created_at", { ascending: false })
    .range(from, from + REPORT_PAGE_SIZE - 1);
  if (error) {
    log.warn("admin.report_queue_fail", errInfo(error));
    return EMPTY(page);
  }

  const list = (data ?? []) as {
    id: string;
    target_id: string;
    reason: string;
    detail: string | null;
    reporter_contact: string | null;
    status: string;
    created_at: string;
    resolved_at: string | null;
  }[];

  // doll 정보 일괄 조회(content_reports.target_id 는 FK 아님 → 수동 조인).
  const dollMap = new Map<string, ReportRow["doll"]>();
  const ids = [...new Set(list.map((r) => r.target_id))];
  if (ids.length) {
    const { data: dolls } = await admin
      .from("dolls")
      .select("id, image_url, owner_id, deleted_at, artifacts_purged_at, profiles(display_name)")
      .in("id", ids);
    for (const d of (dolls ?? []) as Record<string, unknown>[]) {
      const prof = d.profiles as
        | { display_name?: string }
        | { display_name?: string }[]
        | null;
      const ownerName = Array.isArray(prof)
        ? prof[0]?.display_name ?? null
        : prof?.display_name ?? null;
      const purged = (d.artifacts_purged_at as string | null) ?? null;
      dollMap.set(d.id as string, {
        // 영구삭제(purged)면 객체 없음→null(UI 플레이스홀더). 아니면 서명(삭제돼도 어드민은 얼굴 확인 필요).
        image_url: purged ? null : await signedDollUrl((d.image_url as string | null) ?? null),
        owner_id: (d.owner_id as string | null) ?? null,
        owner_name: ownerName,
        deleted_at: (d.deleted_at as string | null) ?? null,
        artifacts_purged_at: purged,
      });
    }
  }

  const rows: ReportRow[] = list.map((r) => ({
    id: r.id,
    dollId: r.target_id,
    reason: r.reason,
    detail: r.detail,
    contact: r.reporter_contact,
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    doll: dollMap.get(r.target_id) ?? null,
  }));
  return { rows, total: count ?? 0, page, pageSize: REPORT_PAGE_SIZE };
}
