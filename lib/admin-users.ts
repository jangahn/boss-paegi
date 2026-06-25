import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import { log, errInfo } from "@/lib/log";
import type {
  AdminOrder,
  MemberInfo,
  GenerationRow,
  DollRow,
  Paged,
} from "@/lib/admin-types";

/**
 * 유저 검색 + 상세 데이터 — server-only, service_role.
 * 검색: UUID exact(직접 조회) / 이메일·닉네임 부분일치(search_members RPC, 0022).
 * 상세 섹션은 각자 독립 페이징(10/page). PII(email) 는 admin 전용.
 */
export const USER_PAGE_SIZE = 10;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Embed = { display_name: string | null } | { display_name: string | null }[] | null;
const embName = (e: Embed): string | null => (Array.isArray(e) ? e[0] : e)?.display_name ?? null;

type MemberRow = {
  user_id: string;
  gen_credits: number;
  member_since: string;
  email: string | null;
  is_admin: boolean;
  profiles: Embed;
};
const toMemberInfo = (m: MemberRow): MemberInfo => ({
  userId: m.user_id,
  displayName: embName(m.profiles),
  email: m.email,
  genCredits: m.gen_credits,
  memberSince: m.member_since,
  isAdmin: m.is_admin,
});

const MEMBER_SELECT = "user_id, gen_credits, member_since, email, is_admin, profiles(display_name)";

/** 단일 회원 정보(UUID). 비회원/미존재면 null. */
export async function getUserMemberInfo(userId: string): Promise<MemberInfo | null> {
  if (!UUID_RE.test(userId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("member_accounts")
    .select(MEMBER_SELECT)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) {
    if (error) log.warn("admin.member_info_fail", errInfo(error));
    return null;
  }
  return toMemberInfo(data as unknown as MemberRow);
}

/** 회원 부분검색 — UUID exact 또는 이메일/닉네임 ILIKE(search_members RPC). 최대 30. */
export async function searchMembers(q: string): Promise<MemberInfo[]> {
  const query = q.trim();
  if (!query) return [];
  if (UUID_RE.test(query)) {
    const one = await getUserMemberInfo(query);
    return one ? [one] : [];
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("search_members", { p_q: query, p_limit: 30 });
  if (error) {
    log.warn("admin.search_members_fail", errInfo(error));
    return [];
  }
  type Row = {
    user_id: string;
    display_name: string | null;
    email: string | null;
    gen_credits: number;
    member_since: string;
    is_admin: boolean;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    genCredits: r.gen_credits,
    memberSince: r.member_since,
    isAdmin: r.is_admin,
  }));
}

/** 유저 결제(주문) 내역 — 10/page, count:exact. refund_state 포함(머니패스 액션용). */
export async function getUserOrders(userId: string, page = 1): Promise<Paged<AdminOrder>> {
  const p = Math.max(1, page);
  const from = (p - 1) * USER_PAGE_SIZE;
  const admin = createAdminClient();
  const { data, count, error } = await admin
    .from("payapp_orders")
    .select(
      "order_uuid, status, amount, credits, product_id, mul_no, created_at, paid_at, user_id, refund_state",
      { count: "exact" }
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(from, from + USER_PAGE_SIZE - 1);
  if (error) {
    log.warn("admin.user_orders_fail", errInfo(error));
    return { rows: [], total: 0, page: p, pageSize: USER_PAGE_SIZE };
  }
  const rows = ((data ?? []) as Array<Omit<AdminOrder, "display_name">>).map((r) => ({
    ...r,
    display_name: null,
  }));
  return { rows, total: count ?? 0, page: p, pageSize: USER_PAGE_SIZE };
}

/** 유저 AI 생성 내역 — get_user_generations RPC(candidate_urls 배열 미반환, count 만). 10/page. */
export async function getUserGenerations(userId: string, page = 1): Promise<Paged<GenerationRow>> {
  const p = Math.max(1, page);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_user_generations", {
    p_owner: userId,
    p_limit: USER_PAGE_SIZE,
    p_offset: (p - 1) * USER_PAGE_SIZE,
  });
  if (error) {
    log.warn("admin.user_generations_fail", errInfo(error));
    return { rows: [], total: 0, page: p, pageSize: USER_PAGE_SIZE };
  }
  type Row = GenerationRow & { total_count: number | string };
  const raw = (data ?? []) as Row[];
  const total = raw.length ? Number(raw[0].total_count) : 0;
  const rows = raw.map((r) => ({
    id: r.id,
    status: r.status,
    role: r.role,
    picked_doll_id: r.picked_doll_id,
    created_at: r.created_at,
    candidate_count: r.candidate_count,
  }));
  return { rows, total, page: p, pageSize: USER_PAGE_SIZE };
}

/** 유저 캐릭터(dolls) — 10/page, count:exact. takedown 삭제분도 deleted_at 으로 표시(탈퇴=하드삭제는 사라짐). */
export async function getUserDolls(userId: string, page = 1): Promise<Paged<DollRow>> {
  const p = Math.max(1, page);
  const from = (p - 1) * USER_PAGE_SIZE;
  const admin = createAdminClient();
  const { data, count, error } = await admin
    .from("dolls")
    .select("id, image_url, role, created_at, deleted_at", { count: "exact" })
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .range(from, from + USER_PAGE_SIZE - 1);
  if (error) {
    log.warn("admin.user_dolls_fail", errInfo(error));
    return { rows: [], total: 0, page: p, pageSize: USER_PAGE_SIZE };
  }
  // private 버킷 — image_url 서명(순차 ≤page). 삭제/영구삭제는 DollsList 칩이 덮음.
  const rows: DollRow[] = [];
  for (const d of (data ?? []) as DollRow[]) {
    rows.push({ ...d, image_url: (await signedDollUrl(d.image_url)) ?? d.image_url });
  }
  return { rows, total: count ?? 0, page: p, pageSize: USER_PAGE_SIZE };
}
