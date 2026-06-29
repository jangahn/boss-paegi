import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import { log, errInfo } from "@/lib/log";
import type { Paged } from "@/lib/admin-types";

/**
 * 캐릭터 생성 현황 — 어드민 전용(service_role). 생성 라이프사이클을 상태/회원/캐릭터로 조회.
 * 상태(파생): 생성요청(queued) · 거부(failed+no_face) · 기타실패(failed 그 외) · 선택 전(done) · 선택완료(picked).
 * 후보 썸네일: done 은 후보 3장 서명, picked 은 고른 캐릭터 1장(나머지 후보는 pick 시 삭제됨), 그 외 없음.
 */
export const GEN_PAGE_SIZE = 10;

export type AdminGenStatus = "requested" | "rejected" | "failed" | "unpicked" | "picked";
export const GEN_STATUS_FILTERS = [
  "all",
  "requested",
  "rejected",
  "unpicked",
  "picked",
  "failed",
] as const;
export type GenStatusFilter = (typeof GEN_STATUS_FILTERS)[number];

export type AdminGeneration = {
  id: string;
  ownerId: string;
  ownerName: string | null;
  adminStatus: AdminGenStatus;
  failReason: string | null;
  role: string;
  pickedDollId: string | null;
  pickedIndex: number | null;
  candidateThumbs: string[]; // 서명 URL — done:최대3, picked:1, 그외:[]
  candidateCount: number;
  /** 크레딧 변동 추정(PR-D ledger 전까지): consumed=-1차감 · refunded=차감후환불 · none=미차감. */
  creditNote: "consumed" | "refunded" | "none";
  createdAt: string;
  updatedAt: string | null;
};

type GenRow = {
  id: string;
  owner_id: string;
  status: string;
  fail_reason: string | null;
  picked_doll_id: string | null;
  picked_index: number | null;
  candidate_urls: unknown;
  role: string;
  created_at: string;
  updated_at: string | null;
};

const toAdminStatus = (status: string, failReason: string | null): AdminGenStatus => {
  if (status === "picked") return "picked";
  if (status === "done") return "unpicked";
  if (status === "failed") return failReason === "no_face" ? "rejected" : "failed";
  return "requested"; // queued (그리고 알 수 없는 status 안전 기본)
};

const toCreditNote = (
  status: string,
  failReason: string | null
): AdminGeneration["creditNote"] => {
  if (status === "failed") return failReason === "no_credits" ? "none" : "refunded";
  return "consumed"; // queued/done/picked = 제출 시 차감(ops 제외 — 추정)
};

/**
 * 생성 목록 — 상태/회원(owner)/캐릭터(picked_doll) 필터 + 10/page(count:exact, 최신순).
 * 0046(fail_reason/picked_index) 미적용 환경이면 해당 컬럼 없이 폴백(거부 필터·픽 index 만 비활성).
 */
export async function listGenerations(opts: {
  status: GenStatusFilter;
  ownerId: string | null;
  dollId: string | null;
  page: number;
}): Promise<Paged<AdminGeneration>> {
  const { status, ownerId, dollId } = opts;
  const page = Math.max(1, opts.page);
  const from = (page - 1) * GEN_PAGE_SIZE;
  const admin = createAdminClient();

  const COLS_FULL =
    "id, owner_id, status, fail_reason, picked_doll_id, picked_index, candidate_urls, role, created_at, updated_at";
  const COLS_FALLBACK =
    "id, owner_id, status, picked_doll_id, candidate_urls, role, created_at, updated_at";

  const build = (cols: string) => {
    let q = admin.from("ai_generations").select(cols, { count: "exact" });
    if (ownerId) q = q.eq("owner_id", ownerId);
    if (dollId) q = q.eq("picked_doll_id", dollId);
    switch (status) {
      case "requested":
        q = q.eq("status", "queued");
        break;
      case "unpicked":
        q = q.eq("status", "done");
        break;
      case "picked":
        q = q.eq("status", "picked");
        break;
      case "rejected":
        q = q.eq("status", "failed").eq("fail_reason", "no_face");
        break;
      case "failed":
        // 실패지만 거부(no_face)는 제외 — null(미기록)도 '기타실패'로 포함.
        q = q.eq("status", "failed").or("fail_reason.is.null,fail_reason.neq.no_face");
        break;
      // "all" — 상태 무필터
    }
    return q.order("created_at", { ascending: false }).range(from, from + GEN_PAGE_SIZE - 1);
  };

  // FULL/FALLBACK 의 select 문자열이 달라 supabase 추론 타입이 갈라짐 → 공통 결과 타입으로 통일.
  type QResult = { data: unknown; count: number | null; error: { message: string } | null };
  let res = (await build(COLS_FULL)) as unknown as QResult;
  // 0046 미적용 — fail_reason/picked_index 없이 재조회(거부/기타실패 필터는 'failed' 전체로 폴백).
  if (res.error && /fail_reason|picked_index/.test(res.error.message)) {
    let q = admin.from("ai_generations").select(COLS_FALLBACK, { count: "exact" });
    if (ownerId) q = q.eq("owner_id", ownerId);
    if (dollId) q = q.eq("picked_doll_id", dollId);
    if (status === "requested") q = q.eq("status", "queued");
    else if (status === "unpicked") q = q.eq("status", "done");
    else if (status === "picked") q = q.eq("status", "picked");
    else if (status === "rejected" || status === "failed") q = q.eq("status", "failed");
    res = (await q
      .order("created_at", { ascending: false })
      .range(from, from + GEN_PAGE_SIZE - 1)) as unknown as QResult;
  }

  if (res.error) {
    log.warn("admin.list_generations_fail", errInfo(res.error));
    return { rows: [], total: 0, page, pageSize: GEN_PAGE_SIZE };
  }
  const raw = ((res.data as GenRow[] | null) ?? []).map((r) => ({
    ...r,
    fail_reason: r.fail_reason ?? null,
    picked_index: r.picked_index ?? null,
  }));

  // 회원 이름 일괄 조회(칩 표시) + picked 캐릭터 이미지 일괄 조회(썸네일).
  const ownerIds = [...new Set(raw.map((r) => r.owner_id))];
  const pickedIds = [...new Set(raw.filter((r) => r.picked_doll_id).map((r) => r.picked_doll_id!))];
  const [nameMap, dollMap] = await Promise.all([
    fetchOwnerNames(admin, ownerIds),
    fetchDollImages(admin, pickedIds),
  ]);

  const rows = await Promise.all(
    raw.map(async (r): Promise<AdminGeneration> => {
      const adminStatus = toAdminStatus(r.status, r.fail_reason);
      const candPaths = Array.isArray(r.candidate_urls) ? (r.candidate_urls as string[]) : [];
      let thumbs: string[] = [];
      if (adminStatus === "unpicked") {
        thumbs = (
          await Promise.all(candPaths.map((p) => signedDollUrl(p, 600, { thumb: true })))
        ).filter((u): u is string => !!u);
      } else if (adminStatus === "picked" && r.picked_doll_id) {
        const img = dollMap.get(r.picked_doll_id);
        if (img) {
          const s = await signedDollUrl(img, 600, { thumb: true });
          if (s) thumbs = [s];
        }
      }
      return {
        id: r.id,
        ownerId: r.owner_id,
        ownerName: nameMap.get(r.owner_id) ?? null,
        adminStatus,
        failReason: r.fail_reason,
        role: r.role,
        pickedDollId: r.picked_doll_id,
        pickedIndex: r.picked_index,
        candidateThumbs: thumbs,
        candidateCount: candPaths.length,
        creditNote: toCreditNote(r.status, r.fail_reason),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    })
  );

  return { rows, total: res.count ?? 0, page, pageSize: GEN_PAGE_SIZE };
}

/** owner_id → display_name (profiles). 탈퇴/없음은 미포함(칩이 shortId 폴백). */
async function fetchOwnerNames(
  admin: ReturnType<typeof createAdminClient>,
  ownerIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ownerIds.length === 0) return map;
  const { data, error } = await admin
    .from("profiles")
    .select("id, display_name")
    .in("id", ownerIds);
  if (error) {
    log.warn("admin.gen_owner_names_fail", errInfo(error));
    return map;
  }
  for (const p of (data ?? []) as { id: string; display_name: string | null }[]) {
    if (p.display_name) map.set(p.id, p.display_name);
  }
  return map;
}

/** picked_doll_id → image_url (dolls, 미purge만). 썸네일 서명용. */
async function fetchDollImages(
  admin: ReturnType<typeof createAdminClient>,
  dollIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (dollIds.length === 0) return map;
  const { data, error } = await admin
    .from("dolls")
    .select("id, image_url, artifacts_purged_at")
    .in("id", dollIds);
  if (error) {
    log.warn("admin.gen_doll_images_fail", errInfo(error));
    return map;
  }
  for (const d of (data ?? []) as {
    id: string;
    image_url: string;
    artifacts_purged_at: string | null;
  }[]) {
    if (!d.artifacts_purged_at) map.set(d.id, d.image_url); // 영구삭제분은 객체 없음 → 스킵
  }
  return map;
}
