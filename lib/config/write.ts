import "server-only";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { configTag } from "./get";
import type { DomainKey } from "./keys";

export type UpdateResult =
  | { ok: true; version: number }
  | { ok: false; error: ConfigWriteError };

export type ConfigWriteError = "version_conflict" | "invalid_key" | "update_failed";

/**
 * 설정 1건 원자 업데이트 — admin_update_app_setting RPC(CAS + 감사 한 txn) 호출 후 캐시 무효화.
 * value 는 호출 전에 도메인 schema 로 검증돼 있어야 한다(API 라우트가 검증). adminId=requireAdmin 검증값.
 */
export async function updateSetting(
  key: DomainKey,
  value: unknown,
  baseVersion: number,
  adminId: string,
  note: string | null
): Promise<UpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_update_app_setting", {
    p_key: key,
    p_value: value,
    p_base_version: baseVersion,
    p_admin_id: adminId,
    p_note: note,
  });
  if (error) return { ok: false, error: classifyError(error.message) };

  // Next 16: revalidateTag(tag, profile). 'max' = stale-while-revalidate(문서 권장). 발행 후 다음 읽기에 갱신.
  revalidateTag(configTag(key), "max");
  return { ok: true, version: (data as { version: number }).version };
}

function classifyError(message: string | undefined): ConfigWriteError {
  const m = message ?? "";
  if (m.includes("version_conflict")) return "version_conflict";
  if (m.includes("invalid_key")) return "invalid_key";
  return "update_failed";
}
