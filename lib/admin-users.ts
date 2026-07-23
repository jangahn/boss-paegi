import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import { log, errInfo } from "@/lib/log";
import type {
  AdminOrder,
  MemberInfo,
  WithdrawnMatch,
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

type ProfEmbed = { display_name: string | null; deleted_at: string | null };
type Embed = ProfEmbed | ProfEmbed[] | null;
const emb = (e: Embed): ProfEmbed | null => (Array.isArray(e) ? e[0] ?? null : e);

type MemberRow = {
  user_id: string;
  gen_credits: number;
  member_since: string;
  email: string | null;
  is_admin: boolean;
  abuse_status: string | null;
  profiles: Embed;
};
const toMemberInfo = (m: MemberRow): MemberInfo => ({
  userId: m.user_id,
  displayName: emb(m.profiles)?.display_name ?? null,
  email: m.email,
  genCredits: m.gen_credits,
  memberSince: m.member_since,
  isAdmin: m.is_admin,
  deletedAt: emb(m.profiles)?.deleted_at ?? null,
  abuseStatus: m.abuse_status ?? "clean",
});

const MEMBER_SELECT =
  "user_id, gen_credits, member_since, email, is_admin, abuse_status, profiles(display_name, deleted_at)";

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

/**
 * 탈퇴자 원본 이메일 검색(0037) — 탈퇴 시 member_accounts.email·닉네임이 스크럽돼 search_members
 * 로는 못 찾으므로, auth.identities 의 원본 이메일로 조회(어드민 재활성 진입용).
 */
export async function findWithdrawnByEmail(email: string): Promise<WithdrawnMatch[]> {
  const q = email.trim();
  if (q.length < 3) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_find_withdrawn_by_email", { p_email: q });
  if (error) {
    log.warn("admin.find_withdrawn_fail", errInfo(error));
    return [];
  }
  return ((data ?? []) as {
    user_id: string;
    original_email: string | null;
    deleted_at: string;
    last_sign_in_at: string | null;
  }[]).map((r) => ({
    userId: r.user_id,
    originalEmail: r.original_email,
    deletedAt: r.deleted_at,
    lastSignInAt: r.last_sign_in_at,
  }));
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
    deletedAt: null, // search_members 는 활성 회원 검색 경로 — 탈퇴 상태는 상세에서 재조회.
    abuseStatus: "clean", // 검색 결과엔 없음 — 정지 여부는 상세(getUserMemberInfo)에서 재조회.
  }));
}

/**
 * 전체 활성 회원 목록 — 최신 가입순, 10/page(count:exact). 검색어 없을 때의 기본 목록.
 * 탈퇴(profiles.deleted_at)는 제외 — search_members(활성만)와 동일 의미. 탈퇴자는 이메일 검색으로.
 */
export async function listMembers(page = 1): Promise<Paged<MemberInfo>> {
  const p = Math.max(1, page);
  const from = (p - 1) * USER_PAGE_SIZE;
  const admin = createAdminClient();
  const { data, count, error } = await admin
    .from("member_accounts")
    .select(
      "user_id, gen_credits, member_since, email, is_admin, abuse_status, profiles!inner(display_name, deleted_at)",
      { count: "exact" }
    )
    .is("profiles.deleted_at", null)
    .order("member_since", { ascending: false })
    .range(from, from + USER_PAGE_SIZE - 1);
  if (error) {
    log.warn("admin.list_members_fail", errInfo(error));
    return { rows: [], total: 0, page: p, pageSize: USER_PAGE_SIZE };
  }
  const rows = ((data ?? []) as unknown as MemberRow[]).map(toMemberInfo);
  return { rows, total: count ?? 0, page: p, pageSize: USER_PAGE_SIZE };
}

/** 유저 결제(주문) 내역 — 10/page, count:exact. refund_state 포함(머니패스 액션용). */
export async function getUserOrders(userId: string, page = 1): Promise<Paged<AdminOrder>> {
  const p = Math.max(1, page);
  const from = (p - 1) * USER_PAGE_SIZE;
  const admin = createAdminClient();
  const { data, count, error } = await admin
    .from("orders")
    .select(
      "order_uuid, status, amount, credits, product_id, pg_tx_id, payment_id, provider, is_test, pay_channel, created_at, paid_at, user_id, refund_state",
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
    .select("id, image_url, role, created_at, deleted_at, artifacts_purged_at", {
      count: "exact",
    })
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .range(from, from + USER_PAGE_SIZE - 1);
  if (error) {
    log.warn("admin.user_dolls_fail", errInfo(error));
    return { rows: [], total: 0, page: p, pageSize: USER_PAGE_SIZE };
  }
  // private 버킷 — 공개·숨김은 서명(어드민 얼굴 확인), 영구삭제(purged)는 객체 없음→경로 그대로(칩 placeholder 가 덮음).
  const rows: DollRow[] = [];
  for (const d of (data ?? []) as DollRow[]) {
    rows.push({
      ...d,
      image_url: d.artifacts_purged_at
        ? d.image_url
        : (await signedDollUrl(d.image_url, 600, { thumb: true })) ?? d.image_url,
    });
  }
  return { rows, total: count ?? 0, page: p, pageSize: USER_PAGE_SIZE };
}

export type CreditLedgerRow = {
  id: string;
  delta: number;
  eventType: string;
  balanceAfter: number | null;
  refGenId: string | null;
  refOrderUuid: string | null;
  createdAt: string;
};

/**
 * 유저 크레딧 변동(생성 차감/환불·충전) — 10/page, count:exact. credit_ledger(0047).
 * 0047 미적용이면 쿼리 에러 → 빈 결과(섹션만 비고 페이지 안전). 운영자 조정/환불은 별도 '크레딧 조정' 섹션.
 */
export async function getUserCreditLedger(
  userId: string,
  page = 1
): Promise<Paged<CreditLedgerRow>> {
  const p = Math.max(1, page);
  const from = (p - 1) * USER_PAGE_SIZE;
  const admin = createAdminClient();
  const { data, count, error } = await admin
    .from("credit_ledger")
    .select("id, delta, event_type, balance_after, ref_gen_id, ref_order_uuid, created_at", {
      count: "exact",
    })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(from, from + USER_PAGE_SIZE - 1);
  if (error) {
    log.warn("admin.user_credit_ledger_fail", errInfo(error));
    return { rows: [], total: 0, page: p, pageSize: USER_PAGE_SIZE };
  }
  type Row = {
    id: string;
    delta: number;
    event_type: string;
    balance_after: number | null;
    ref_gen_id: string | null;
    ref_order_uuid: string | null;
    created_at: string;
  };
  const rows = ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    delta: r.delta,
    eventType: r.event_type,
    balanceAfter: r.balance_after,
    refGenId: r.ref_gen_id,
    refOrderUuid: r.ref_order_uuid,
    createdAt: r.created_at,
  }));
  return { rows, total: count ?? 0, page: p, pageSize: USER_PAGE_SIZE };
}
