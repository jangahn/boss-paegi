import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LedgerRow, LedgerPage, LedgerActionType } from "@/lib/admin-types";
import { requireSupabasePage } from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";

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
  const values = e === null ? [] : Array.isArray(e) ? e : [e];
  const parsed = validateAdminRows<{ display_name: string | null }>(
    "admin.ledger.profile",
    values,
    { display_name: "nullableString" },
  );
  const v = parsed[0] ?? null;
  return v?.display_name ?? null;
};

export async function getLedger(opts: {
  page?: number;
  actionType?: LedgerActionType | null;
  targetUserId?: string | null;
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
  if (opts.targetUserId) qb = qb.eq("target_user_id", opts.targetUserId);

  const result = await requireSupabasePage(
    "admin.ledger",
    () => qb.range(from, to),
  );
  const raw = validateAdminRows<RawLedgerRow>(
    "admin.ledger",
    result.rows,
    {
      id: "uuid",
      created_at: "timestamp",
      action_type: "string",
      admin_user_id: "uuid",
      target_user_id: "uuid",
      order_uuid: "nullableUuid",
      credit_delta: "safeInteger",
      order_amount: "nullableNonnegativeInteger",
      before_credits: "nonnegativeInteger",
      after_credits: "nonnegativeInteger",
      reason: "string",
      metadata: "nullableJsonObject",
      admin: "embed",
      target: "embed",
    },
  );
  const rows: LedgerRow[] = raw.map((r) => ({
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
  return {
    rows,
    total: result.count,
    page,
    pageSize: LEDGER_PAGE_SIZE,
  };
}
