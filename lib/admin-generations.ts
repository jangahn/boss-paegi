import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import type { Paged } from "@/lib/admin-types";
import {
  requireSupabaseOptionalData,
  requireSupabasePage,
  requireSupabaseRows,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import {
  requireExactAdminIdCoverage,
  validateAdminRows,
} from "@/lib/admin-read-contract";
import { parseProvenance, type GenProvenance } from "@/lib/character-gen/provenance";
import { INPUT_REJECT_REASONS } from "@/lib/character-gen/face-analysis";
import {
  ADMIN_GENERATION_STATUS_FILTERS,
  deriveAdminGenerationStatus,
  deriveGenerationCreditNote,
  generationThumbnailMode,
  type AdminGenerationStatus,
  type AdminGenerationStatusFilter,
} from "@/lib/character-gen/admin-generation-state";

/**
 * 캐릭터 생성 현황 — 어드민 전용(service_role). 생성 라이프사이클을 상태/회원/캐릭터로 조회.
 * 상태(파생): 생성요청(queued) · 거부(failed+입력 부적합 사유) · 기타실패(failed 그 외) ·
 * 선택 전(done) · 미선택 만료(expired) · 선택완료(picked).
 * 후보 썸네일: done 은 후보 3장 서명, picked 은 고른 캐릭터 1장, expired/그 외는 없음.
 */
export const GEN_PAGE_SIZE = 10;

// '거부'로 분류하는 fail_reason 집합 = 입력 게이트 반려 사유(단일 정본, face-analysis.ts). fal 제출 후
// no-face(recovery)도 no_face 라 함께 '거부'. 나머지 failed(fal_error/timeout/submit_error/…)=기타실패.
const REJECTION_REASONS: readonly string[] = INPUT_REJECT_REASONS;

export type AdminGenStatus = AdminGenerationStatus;
export const GEN_STATUS_FILTERS = ADMIN_GENERATION_STATUS_FILTERS;
export type GenStatusFilter = AdminGenerationStatusFilter;

export type AdminGeneration = {
  id: string;
  ownerId: string;
  ownerName: string | null;
  adminStatus: AdminGenStatus;
  failReason: string | null;
  role: string;
  pickedDollId: string | null;
  pickedIndex: number | null;
  candidateThumbs: string[]; // 서명 URL — done:최대3, picked:1, expired/그외:[]
  candidateCount: number;
  /** DB 영수증 기준: consumed=-1차감 · refunded=차감후환불 · none=미차감. */
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
  credit_lot_id: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string | null;
};

const GEN_ROW_SCHEMA = {
  id: "uuid",
  owner_id: "uuid",
  status: "string",
  fail_reason: "nullableString",
  picked_doll_id: "nullableUuid",
  picked_index: "nullableNonnegativeInteger",
  candidate_urls: "array",
  role: "string",
  credit_lot_id: "nullableUuid",
  refunded_at: "nullableTimestamp",
  created_at: "timestamp",
  updated_at: "nullableTimestamp",
} as const;

function validatedGenerationRows(
  operation: string,
  rows: unknown[],
): GenRow[] {
  const parsed = validateAdminRows<GenRow>(
    operation,
    rows,
    GEN_ROW_SCHEMA,
  );
  for (const row of parsed) {
    if (
      !Array.isArray(row.candidate_urls) ||
      !row.candidate_urls.every(
        (path) => typeof path === "string" && path.length > 0,
      )
    ) {
      throw new SupabaseOperationError(
        operation,
        new Error("invalid_candidate_path"),
      );
    }
  }
  return parsed;
}

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
    "id, owner_id, status, fail_reason, picked_doll_id, picked_index, candidate_urls, role, credit_lot_id, refunded_at, created_at, updated_at";
  const COLS_FALLBACK =
    "id, owner_id, status, picked_doll_id, candidate_urls, role, credit_lot_id, refunded_at, created_at, updated_at";

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
      case "expired":
        q = q.eq("status", "expired");
        break;
      case "picked":
        q = q.eq("status", "picked");
        break;
      case "rejected":
        q = q.eq("status", "failed").in("fail_reason", REJECTION_REASONS as string[]);
        break;
      case "failed":
        // 실패지만 거부(입력 부적합)는 제외 — null(미기록)도 '기타실패'로 포함.
        q = q
          .eq("status", "failed")
          .or(`fail_reason.is.null,fail_reason.not.in.(${REJECTION_REASONS.join(",")})`);
        break;
      // "all" — 상태 무필터
    }
    return q.order("created_at", { ascending: false }).range(from, from + GEN_PAGE_SIZE - 1);
  };

  // FULL/FALLBACK 의 select 문자열이 달라 supabase 추론 타입이 갈라짐 → 공통 결과 타입으로 통일.
  type QResult = {
    data: unknown;
    count: number | null;
    error: { code?: string; message: string } | null;
  };
  let res = (await build(COLS_FULL)) as unknown as QResult;
  // 0046 미적용 — fail_reason/picked_index 없이 재조회(거부/기타실패 필터는 'failed' 전체로 폴백).
  if (
    res.error &&
    ["42703", "PGRST204"].includes(res.error.code ?? "") &&
    /fail_reason|picked_index/.test(res.error.message)
  ) {
    let q = admin.from("ai_generations").select(COLS_FALLBACK, { count: "exact" });
    if (ownerId) q = q.eq("owner_id", ownerId);
    if (dollId) q = q.eq("picked_doll_id", dollId);
    if (status === "requested") q = q.eq("status", "queued");
    else if (status === "unpicked") q = q.eq("status", "done");
    else if (status === "expired") q = q.eq("status", "expired");
    else if (status === "picked") q = q.eq("status", "picked");
    else if (status === "rejected" || status === "failed") q = q.eq("status", "failed");
    res = (await q
      .order("created_at", { ascending: false })
      .range(from, from + GEN_PAGE_SIZE - 1)) as unknown as QResult;
  }

  const pageResult = await requireSupabasePage<GenRow>(
    "admin.generations.list",
    async () => ({
      data: res.data as GenRow[] | null,
      count: res.count,
      error: res.error,
    }),
  );
  const raw = validatedGenerationRows(
    "admin.generations.list",
    pageResult.rows.map((r) => ({
      ...r,
      fail_reason: r.fail_reason ?? null,
      picked_index: r.picked_index ?? null,
    })),
  );

  // 회원 이름 일괄 조회(칩 표시) + picked 캐릭터 이미지 일괄 조회(썸네일).
  const ownerIds = [...new Set(raw.map((r) => r.owner_id))];
  const pickedIds = [...new Set(raw.filter((r) => r.picked_doll_id).map((r) => r.picked_doll_id!))];
  const [nameMap, dollMap] = await Promise.all([
    fetchOwnerNames(admin, ownerIds),
    fetchDollImages(admin, pickedIds),
  ]);

  const rows = await Promise.all(
    raw.map(async (r): Promise<AdminGeneration> => {
      const adminStatus = deriveAdminGenerationStatus(r.status, r.fail_reason);
      const thumbnailMode = generationThumbnailMode(adminStatus);
      const candPaths = Array.isArray(r.candidate_urls) ? (r.candidate_urls as string[]) : [];
      let thumbs: string[] = [];
      if (thumbnailMode === "candidates") {
        thumbs = await Promise.all(
          candPaths.map((p) => signedDollUrl(p, 600, { thumb: true })),
        );
      } else if (thumbnailMode === "picked" && r.picked_doll_id) {
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
        creditNote: deriveGenerationCreditNote(
          r.credit_lot_id,
          r.refunded_at,
        ),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    })
  );

  return {
    rows,
    total: pageResult.count,
    page,
    pageSize: GEN_PAGE_SIZE,
  };
}

/** owner_id → display_name (profiles). 탈퇴/없음은 미포함(칩이 shortId 폴백). */
async function fetchOwnerNames(
  admin: ReturnType<typeof createAdminClient>,
  ownerIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ownerIds.length === 0) return map;
  const data = await requireSupabaseRows(
    "admin.generations.owner_names",
    () =>
      admin
        .from("profiles")
        .select("id, display_name")
        .in("id", ownerIds),
  );
  const profiles = validateAdminRows<{
    id: string;
    display_name: string | null;
  }>("admin.generations.owner_names", data, {
    id: "uuid",
    display_name: "nullableString",
  });
  requireExactAdminIdCoverage(
    "admin.generations.owner_names",
    ownerIds,
    profiles.map((profile) => profile.id),
  );
  for (const p of profiles) {
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
  const data = await requireSupabaseRows(
    "admin.generations.doll_images",
    () =>
      admin
        .from("dolls")
        .select("id, image_url, artifacts_purged_at")
        .in("id", dollIds),
  );
  const dolls = validateAdminRows<{
    id: string;
    image_url: string;
    artifacts_purged_at: string | null;
  }>("admin.generations.doll_images", data, {
    id: "uuid",
    image_url: "string",
    artifacts_purged_at: "nullableTimestamp",
  });
  requireExactAdminIdCoverage(
    "admin.generations.doll_images",
    dollIds,
    dolls.map((doll) => doll.id),
  );
  for (const d of dolls) {
    if (!d.artifacts_purged_at) map.set(d.id, d.image_url); // 영구삭제분은 객체 없음 → 스킵
  }
  return map;
}

export type AdminGenerationDetail = AdminGeneration & {
  /** gen_params provenance(검증됨) 또는 null(레거시/미지원 — 상세에서 '기록 이전' 표기). */
  provenance: GenProvenance | null;
  /** 후보 index → 서명 썸네일. done: 남은 후보 / picked: 선택 doll / expired·그 외: 없음. */
  candidateThumbByIndex: Record<number, string>;
};

/**
 * 생성 단건 상세(어드민 전용) — provenance(gen_params) + 후보별 썸네일 + owner. gen_params 는 safeParse
 * 라 구버전·NULL·미지원 schemaVersion 에도 페이지가 깨지지 않는다(provenance=null). 원가·fal 링크 미포함.
 */
export async function getGeneration(id: string): Promise<AdminGenerationDetail | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    "admin.generations.detail",
    () =>
      admin
        .from("ai_generations")
        .select(
          "id, owner_id, status, fail_reason, picked_doll_id, picked_index, candidate_urls, role, credit_lot_id, refunded_at, gen_params, created_at, updated_at",
        )
        .eq("id", id)
        .maybeSingle(),
  );
  if (!data) return null;
  const r = validatedGenerationRows("admin.generations.detail", [
    data,
  ])[0] as GenRow & { gen_params: unknown };
  const adminStatus = deriveAdminGenerationStatus(r.status, r.fail_reason);
  const thumbnailMode = generationThumbnailMode(adminStatus);

  const nameMap = await fetchOwnerNames(admin, [r.owner_id]);
  const dollMap = r.picked_doll_id
    ? await fetchDollImages(admin, [r.picked_doll_id])
    : new Map<string, string>();

  const candPaths = Array.isArray(r.candidate_urls) ? (r.candidate_urls as string[]) : [];
  const idxOf = (p: string): number => {
    const m = /\/(\d+)\.jpg$/.exec(p);
    return m ? Number(m[1]) : -1;
  };
  const candidateThumbByIndex: Record<number, string> = {};
  if (thumbnailMode === "candidates") {
    await Promise.all(
      candPaths.map(async (p) => {
        const i = idxOf(p);
        if (i < 0) return;
        const s = await signedDollUrl(p, 600, { thumb: true });
        if (s) candidateThumbByIndex[i] = s;
      })
    );
  } else if (thumbnailMode === "picked" && r.picked_doll_id && r.picked_index != null) {
    const img = dollMap.get(r.picked_doll_id);
    if (img) {
      const s = await signedDollUrl(img, 600, { thumb: true });
      if (s) candidateThumbByIndex[r.picked_index] = s;
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
    candidateThumbs: Object.values(candidateThumbByIndex),
    candidateCount: candPaths.length,
    creditNote: deriveGenerationCreditNote(
      r.credit_lot_id,
      r.refunded_at,
    ),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    provenance: parseProvenance(r.gen_params),
    candidateThumbByIndex,
  };
}
