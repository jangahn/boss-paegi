import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import type { Paged } from "@/lib/admin-types";
import {
  requireSupabaseOptionalData,
  requireSupabasePage,
  requireSupabaseRows,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { isRoleId, type RoleId } from "@/lib/roles/ids";
import { asGender, isGender, type Gender } from "@/lib/gender";
import { isAdminMutationOperation } from "@/lib/admin-mutation";

/**
 * 캐릭터(dolls) — 어드민 전용(service_role). 생성 기록(ai_generations, 과정의 불변 기록)과 달리 **지금 살아 있는 결과물**의
 * 현재 상태를 다룬다(v1.29). 상태(파생): 공개(deleted_at null) · 숨김(takedown, 복구 가능) · 영구삭제(artifacts_purged_at).
 * 롤·성별은 캐릭터의 현재 속성 — 어드민 캐릭터 상세에서만 바뀐다(유저 불가).
 */

export const DOLL_PAGE_SIZE = 10;

export const DOLL_STATE_FILTERS = ["all", "public", "hidden", "purged"] as const;
export type DollStateFilter = (typeof DOLL_STATE_FILTERS)[number];
export type DollState = Exclude<DollStateFilter, "all">;

export function deriveDollState(row: {
  deleted_at: string | null;
  artifacts_purged_at: string | null;
}): DollState {
  if (row.artifacts_purged_at) return "purged";
  if (row.deleted_at) return "hidden";
  return "public";
}

export type AdminDoll = {
  id: string;
  ownerId: string;
  ownerName: string | null;
  role: RoleId;
  gender: Gender;
  state: DollState;
  /** 서명 썸네일(영구삭제는 객체 없음 → null). */
  thumb: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type DollRow = {
  id: string;
  owner_id: string;
  image_url: string;
  role: string;
  gender: string;
  version: number;
  deleted_at: string | null;
  artifacts_purged_at: string | null;
  created_at: string;
  updated_at: string;
};

const DOLL_ROW_SCHEMA = {
  id: "uuid",
  owner_id: "uuid",
  image_url: "string",
  role: "string",
  gender: "string",
  version: "nonnegativeInteger",
  deleted_at: "nullableTimestamp",
  artifacts_purged_at: "nullableTimestamp",
  created_at: "timestamp",
  updated_at: "timestamp",
} as const;

const DOLL_COLS =
  "id, owner_id, image_url, role, gender, version, deleted_at, artifacts_purged_at, created_at, updated_at";

async function fetchOwnerNames(
  admin: ReturnType<typeof createAdminClient>,
  ownerIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(ownerIds)];
  if (ids.length === 0) return map;
  const data = await requireSupabaseRows(
    "admin.dolls.owner_names",
    () => admin.from("profiles").select("id, display_name").in("id", ids),
  );
  const profiles = validateAdminRows<{ id: string; display_name: string | null }>(
    "admin.dolls.owner_names",
    data,
    { id: "uuid", display_name: "nullableString" },
  );
  for (const p of profiles) {
    if (p.display_name) map.set(p.id, p.display_name);
  }
  return map;
}

async function toAdminDolls(
  admin: ReturnType<typeof createAdminClient>,
  rows: DollRow[],
): Promise<AdminDoll[]> {
  const nameMap = await fetchOwnerNames(admin, rows.map((r) => r.owner_id));
  return Promise.all(
    rows.map(async (r) => {
      const state = deriveDollState(r);
      const thumb = state === "purged" ? null : await signedDollUrl(r.image_url, 600, { thumb: true });
      return {
        id: r.id,
        ownerId: r.owner_id,
        ownerName: nameMap.get(r.owner_id) ?? null,
        // 렌더는 관용(asRole 대신 isRoleId 게이트 + boss 폴백) — DB CHECK 가 7롤을 보장하므로 폴백은 방어용.
        role: isRoleId(r.role) ? r.role : "boss",
        gender: asGender(r.gender),
        state,
        thumb,
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }),
  );
}

/**
 * 캐릭터 목록 — 상태·롤·성별·회원 필터 + 10/page(count:exact, 최신순, id tiebreaker).
 */
export async function listDolls(opts: {
  state: DollStateFilter;
  role: RoleId | null;
  gender: Gender | null;
  ownerId: string | null;
  page: number;
}): Promise<Paged<AdminDoll>> {
  const page = Math.max(1, opts.page);
  const from = (page - 1) * DOLL_PAGE_SIZE;
  const admin = createAdminClient();
  const result = await requireSupabasePage<DollRow>(
    "admin.dolls.list",
    () => {
      let q = admin.from("dolls").select(DOLL_COLS, { count: "exact" });
      if (opts.ownerId) q = q.eq("owner_id", opts.ownerId);
      if (opts.role) q = q.eq("role", opts.role);
      if (opts.gender) q = q.eq("gender", opts.gender);
      switch (opts.state) {
        case "public":
          q = q.is("deleted_at", null);
          break;
        case "hidden":
          q = q.not("deleted_at", "is", null).is("artifacts_purged_at", null);
          break;
        case "purged":
          q = q.not("artifacts_purged_at", "is", null);
          break;
        // "all"
      }
      return q
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + DOLL_PAGE_SIZE - 1);
    },
  );
  const rows = validateAdminRows<DollRow>("admin.dolls.list", result.rows, DOLL_ROW_SCHEMA);
  return {
    rows: await toAdminDolls(admin, rows),
    total: result.count,
    page,
    pageSize: DOLL_PAGE_SIZE,
  };
}

/** 캐릭터 상세의 소스 생성 요약(생성 시 선택 롤·판정 성별) — 기록 없으면 null(기능 배포 이전 캐릭터). */
export type DollSourceGeneration = {
  id: string;
  role: string;
  gender: Gender;
  status: string;
  createdAt: string;
};

/** 캐릭터 속성 변경 이력 — admin_mutation_requests receipt(0121 성별 전용 + 0123 롤·성별). */
export type DollProfileChange = {
  requestId: string;
  operation: string;
  adminUserId: string;
  adminName: string | null;
  previousRole: string | null;
  nextRole: string | null;
  previousGender: string | null;
  nextGender: string | null;
  noOp: boolean;
  completedAt: string;
};

export type AdminDollDetail = AdminDoll & {
  /** 이 캐릭터의 대기 신고 수(content_reports pending). */
  pendingReports: number;
  source: DollSourceGeneration | null;
  changes: DollProfileChange[];
};

const DOLL_PROFILE_OPERATIONS = ["doll_gender_update", "doll_profile_update"] as const;

export async function getDoll(id: string): Promise<AdminDollDetail | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    "admin.dolls.detail",
    () => admin.from("dolls").select(DOLL_COLS).eq("id", id).maybeSingle(),
  );
  if (!data) return null;
  const row = validateAdminRows<DollRow>("admin.dolls.detail", [data], DOLL_ROW_SCHEMA)[0];
  const [doll] = await toAdminDolls(admin, [row]);

  const pendingRows = await requireSupabaseRows(
    "admin.dolls.pending_reports",
    () =>
      admin
        .from("content_reports")
        .select("id")
        .eq("target_type", "doll")
        .eq("target_id", id)
        .eq("status", "pending"),
  );
  const pendingReports = validateAdminRows<{ id: string }>(
    "admin.dolls.pending_reports",
    pendingRows,
    { id: "uuid" },
  ).length;

  const sourceData = await requireSupabaseOptionalData(
    "admin.dolls.source_generation",
    () =>
      admin
        .from("ai_generations")
        .select("id, role, gender, status, created_at")
        .eq("picked_doll_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
  );
  const source = sourceData
    ? (() => {
        const g = validateAdminRows<{
          id: string;
          role: string;
          gender: string;
          status: string;
          created_at: string;
        }>("admin.dolls.source_generation", [sourceData], {
          id: "uuid",
          role: "string",
          gender: "string",
          status: "string",
          created_at: "timestamp",
        })[0];
        return { id: g.id, role: g.role, gender: asGender(g.gender), status: g.status, createdAt: g.created_at };
      })()
    : null;

  const receiptRows = await requireSupabaseRows(
    "admin.dolls.profile_changes",
    () =>
      admin
        .from("admin_mutation_requests")
        .select("request_id, operation, admin_user_id, result, completed_at")
        .eq("target_key", id)
        .in("operation", [...DOLL_PROFILE_OPERATIONS])
        .eq("state", "completed")
        .order("completed_at", { ascending: false })
        .limit(20),
  );
  const receipts = validateAdminRows<{
    request_id: string;
    operation: string;
    admin_user_id: string;
    result: unknown;
    completed_at: string;
  }>("admin.dolls.profile_changes", receiptRows, {
    request_id: "uuid",
    operation: "string",
    admin_user_id: "uuid",
    result: "jsonObject",
    completed_at: "timestamp",
  });
  const adminNames = await fetchOwnerNames(admin, receipts.map((r) => r.admin_user_id));
  const changes: DollProfileChange[] = receipts
    .filter((r) => isAdminMutationOperation(r.operation))
    .map((r) => {
      const res = r.result as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      return {
        requestId: r.request_id,
        operation: r.operation,
        adminUserId: r.admin_user_id,
        adminName: adminNames.get(r.admin_user_id) ?? null,
        previousRole: str(res.previousRole),
        nextRole: str(res.nextRole),
        previousGender: isGender(res.previousGender) ? res.previousGender : str(res.previousGender),
        nextGender: isGender(res.nextGender) ? res.nextGender : str(res.nextGender),
        noOp: res.noOp === true,
        completedAt: r.completed_at,
      };
    });

  return { ...doll, pendingReports, source, changes };
}
