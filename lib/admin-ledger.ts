import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import type { LedgerRow, LedgerPage, LedgerActionType } from "@/lib/admin-types";

/**
 * 처리 내역(admin_actions_ledger) — server-only, service_role.
 * admin_user_id / target_user_id 둘 다 profiles 를 가리켜 PostgREST FK 별칭으로 분리 임베드.
 * count:'exact' 로 정확 total(페이징). 캐스트 불필요 → RPC 없이 직접 쿼리.
 */
export const LEDGER_PAGE_SIZE = 10;

// 두 FK 가 같은 profiles 를 참조 → 제약명으로 명시 disambiguation(0020 정의명).
const LEDGER_SELECT =
  "id, created_at, action_type, admin_user_id, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason, metadata, " +
  "admin:profiles!admin_actions_ledger_admin_user_id_fkey(display_name), " +
  "target:profiles!admin_actions_ledger_target_user_id_fkey(display_name)";

type Embed = { display_name: string | null } | { display_name: string | null }[] | null;
type RawLedgerRow = Omit<LedgerRow, "admin_name" | "target_name"> & {
  admin: Embed;
  target: Embed;
};

const name = (e: Embed): string | null => {
  const v = Array.isArray(e) ? e[0] : e;
  return v?.display_name ?? null;
};

export async function getLedger(opts: {
  page?: number;
  actionType?: LedgerActionType | null;
}): Promise<LedgerPage> {
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * LEDGER_PAGE_SIZE;
  const to = from + LEDGER_PAGE_SIZE - 1;
  const admin = createAdminClient();

  let qb = admin
    .from("admin_actions_ledger")
    .select(LEDGER_SELECT, { count: "exact" })
    .order("created_at", { ascending: false });
  if (opts.actionType) qb = qb.eq("action_type", opts.actionType);

  const { data, count, error } = await qb.range(from, to);
  if (error) {
    log.warn("admin.ledger_fail", errInfo(error));
    return { rows: [], total: 0, page, pageSize: LEDGER_PAGE_SIZE };
  }
  const rows: LedgerRow[] = ((data ?? []) as unknown as RawLedgerRow[]).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    action_type: r.action_type,
    admin_user_id: r.admin_user_id,
    admin_name: name(r.admin),
    target_user_id: r.target_user_id,
    target_name: name(r.target),
    order_uuid: r.order_uuid,
    credit_delta: r.credit_delta,
    order_amount: r.order_amount,
    before_credits: r.before_credits,
    after_credits: r.after_credits,
    reason: r.reason,
    metadata: r.metadata,
  }));
  return { rows, total: count ?? 0, page, pageSize: LEDGER_PAGE_SIZE };
}
