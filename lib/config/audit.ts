import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requireSupabaseOptionalData,
  requireSupabasePage,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import type { DomainKey } from "./keys";

export const AUDIT_PAGE_SIZE = 10;

export type ConfigAuditRow = {
  id: string;
  oldValue: unknown | null;
  newValue: unknown;
  oldVersion: number | null;
  newVersion: number;
  adminId: string;
  adminName: string | null;
  note: string | null;
  createdAt: string;
};

export type ConfigAuditPage = {
  rows: ConfigAuditRow[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 도메인별 콘텐츠 변경 내역(app_settings_audit) — 최신순 페이징 + 어드민 표시명(profiles) 조인.
 * service_role 전용 테이블이라 server-only. old/new 스냅샷이 있어 diff 재구성 가능.
 */
export async function getConfigAudit(
  key: DomainKey,
  opts: { page?: number }
): Promise<ConfigAuditPage> {
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * AUDIT_PAGE_SIZE;
  const to = from + AUDIT_PAGE_SIZE - 1;
  const admin = createAdminClient();
  const { rows: data, count } = await requireSupabasePage<
    Record<string, unknown>
  >("config.audit", () =>
    admin
      .from("app_settings_audit")
      .select(
        "id, old_value, new_value, old_version, new_version, admin_user_id, note, created_at, admin:profiles(display_name)",
        { count: "exact" }
      )
      .eq("key", key)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );

  const validated = validateAdminRows<Record<string, unknown>>(
    "config.audit",
    data,
    {
      id: "uuid",
      old_value: "nullableJsonObject",
      new_value: "jsonObject",
      old_version: "nullableNonnegativeInteger",
      new_version: "nonnegativeInteger",
      admin_user_id: "uuid",
      note: "nullableText",
      created_at: "timestamp",
      admin: "embed",
    },
  );
  const rows: ConfigAuditRow[] = validated.map(
    (r) => {
      const embedded = r.admin as
        | { display_name: string | null }
        | { display_name: string | null }[]
        | null;
      const a = Array.isArray(embedded) ? embedded[0] ?? null : embedded;
      if (a) {
        validateAdminRows("config.audit.admin", [a], {
          display_name: "nullableText",
        });
      }
      if (
        (r.new_version as number) < 1 ||
        (r.old_version !== null && (r.old_version as number) < 1)
      ) {
        throw new SupabaseOperationError(
          "config.audit",
          new Error("version_missing_or_invalid"),
        );
      }
      return {
        id: r.id as string,
        oldValue: r.old_value as unknown | null,
        newValue: r.new_value,
        oldVersion: r.old_version as number | null,
        newVersion: r.new_version as number,
        adminId: r.admin_user_id as string,
        adminName: a?.display_name ?? null,
        note: r.note as string | null,
        createdAt: r.created_at as string,
      };
    }
  );
  return { rows, total: count, page, pageSize: AUDIT_PAGE_SIZE };
}

/**
 * 감사행 단건 조회(롤백 재발행용) — id + key 로 조회해 그 시점 new_value/new_version 반환.
 * key 불일치(타 도메인 auditId)는 null(호출부가 404). service_role 전용.
 */
export async function getConfigAuditEntry(
  key: DomainKey,
  auditId: string
): Promise<{ newValue: unknown; newVersion: number } | null> {
  const admin = createAdminClient();
  const raw = await requireSupabaseOptionalData(
    "config.audit_entry",
    () =>
      admin
        .from("app_settings_audit")
        .select("new_value, new_version")
        .eq("id", auditId)
        .eq("key", key)
        .maybeSingle(),
  );
  if (!raw) return null;
  const data = validateAdminRows<{
    new_value: unknown;
    new_version: number;
  }>("config.audit_entry", [raw], {
    new_value: "jsonObject",
    new_version: "nonnegativeInteger",
  })[0]!;
  if (data.new_version < 1) {
    throw new SupabaseOperationError(
      "config.audit_entry",
      new Error("version_missing_or_invalid"),
    );
  }
  return { newValue: data.new_value, newVersion: data.new_version };
}

/** 현재 발행 버전(app_settings.version) — 롤백 baseVersion(CAS)용. 미발행이면 0. */
export async function getConfigVersion(key: DomainKey): Promise<number> {
  const admin = createAdminClient();
  const raw = await requireSupabaseOptionalData("config.version", () =>
    admin
      .from("app_settings")
      .select("version")
      .eq("key", key)
      .maybeSingle(),
  );
  if (!raw) return 0;
  const data = validateAdminRows<{ version: number }>(
    "config.version",
    [raw],
    { version: "nonnegativeInteger" },
  )[0]!;
  if (!Number.isSafeInteger(data.version) || data.version < 1) {
    throw new SupabaseOperationError(
      "config.version",
      new Error("version_missing_or_invalid"),
    );
  }
  return data.version;
}
