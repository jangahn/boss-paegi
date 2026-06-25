import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

/**
 * 모더레이션(신고 큐 + 물리삭제 미확정) 조회 — server-only, service_role.
 * 출시 규모에선 pending 전량을 한 번에(QUEUE_CAP) 가져와 doll 별 건수까지 계산.
 */
const QUEUE_CAP = 200;

export type ReportRow = {
  id: string;
  dollId: string;
  reason: string;
  detail: string | null;
  contact: string | null;
  created_at: string;
  doll: {
    image_url: string | null;
    owner_id: string | null;
    owner_name: string | null;
    deleted_at: string | null;
    artifacts_purged_at: string | null;
  } | null;
  dollPendingCount: number;
};

export type PurgePendingDoll = {
  id: string;
  image_url: string | null;
  deleted_at: string | null;
};

export async function getReportQueue(): Promise<{ rows: ReportRow[]; capped: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("content_reports")
    .select("id, target_id, reason, detail, reporter_contact, created_at")
    .eq("target_type", "doll")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(QUEUE_CAP + 1);
  if (error) {
    log.warn("admin.report_queue_fail", errInfo(error));
    return { rows: [], capped: false };
  }
  const list = (data ?? []) as {
    id: string;
    target_id: string;
    reason: string;
    detail: string | null;
    reporter_contact: string | null;
    created_at: string;
  }[];
  const capped = list.length > QUEUE_CAP;
  const page = capped ? list.slice(0, QUEUE_CAP) : list;
  if (capped) log.warn("admin.report_queue_capped", { cap: QUEUE_CAP });

  // doll 별 pending 건수.
  const countByDoll = new Map<string, number>();
  for (const r of page) countByDoll.set(r.target_id, (countByDoll.get(r.target_id) ?? 0) + 1);

  // doll 정보 일괄 조회(content_reports.target_id 는 FK 아님 → 수동 조인).
  const dollMap = new Map<string, ReportRow["doll"]>();
  const ids = [...countByDoll.keys()];
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
      dollMap.set(d.id as string, {
        image_url: (d.image_url as string | null) ?? null,
        owner_id: (d.owner_id as string | null) ?? null,
        owner_name: ownerName,
        deleted_at: (d.deleted_at as string | null) ?? null,
        artifacts_purged_at: (d.artifacts_purged_at as string | null) ?? null,
      });
    }
  }

  const rows: ReportRow[] = page.map((r) => ({
    id: r.id,
    dollId: r.target_id,
    reason: r.reason,
    detail: r.detail,
    contact: r.reporter_contact,
    created_at: r.created_at,
    doll: dollMap.get(r.target_id) ?? null,
    dollPendingCount: countByDoll.get(r.target_id) ?? 1,
  }));
  return { rows, capped };
}

/** takedown 됐는데 storage 물리삭제가 미확정(=실패/대기)인 doll — "파일 삭제 확인 필요". */
export async function getPurgePendingDolls(): Promise<PurgePendingDoll[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("dolls")
    .select("id, image_url, deleted_at")
    .not("deleted_at", "is", null)
    .is("artifacts_purged_at", null)
    .order("deleted_at", { ascending: false })
    .limit(50);
  if (error) {
    log.warn("admin.purge_pending_fail", errInfo(error));
    return [];
  }
  return (data ?? []) as PurgePendingDoll[];
}
