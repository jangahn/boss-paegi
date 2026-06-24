import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
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
  const { data, count, error } = await admin
    .from("app_settings_audit")
    .select(
      "id, old_value, new_value, old_version, new_version, admin_user_id, note, created_at, admin:profiles(display_name)",
      { count: "exact" }
    )
    .eq("key", key)
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) log.warn("config.audit_query_fail", { key, ...errInfo(error) });

  const rows: ConfigAuditRow[] = ((data ?? []) as Array<Record<string, unknown>>).map(
    (r) => {
      const a = r.admin as
        | { display_name?: string }
        | { display_name?: string }[]
        | null;
      const adminName = Array.isArray(a)
        ? a[0]?.display_name ?? null
        : a?.display_name ?? null;
      return {
        id: r.id as string,
        oldValue: r.old_value ?? null,
        newValue: r.new_value,
        oldVersion: (r.old_version as number | null) ?? null,
        newVersion: r.new_version as number,
        adminId: r.admin_user_id as string,
        adminName,
        note: (r.note as string | null) ?? null,
        createdAt: r.created_at as string,
      };
    }
  );
  return { rows, total: count ?? 0, page, pageSize: AUDIT_PAGE_SIZE };
}
