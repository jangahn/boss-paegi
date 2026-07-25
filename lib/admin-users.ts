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
  UserLotRow,
  RefundRequestRow,
  ReconIssueRow,
} from "@/lib/admin-types";
import { ACTIVE_REQUEST_STATES } from "@/lib/admin-types";

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

/** 유저 결제(주문) 내역 — 10/page, count:exact. 환불 누계(0062) 포함(환불 액션 노출 판정용). */
export async function getUserOrders(userId: string, page = 1): Promise<Paged<AdminOrder>> {
  const p = Math.max(1, page);
  const from = (p - 1) * USER_PAGE_SIZE;
  const admin = createAdminClient();
  const { data, count, error } = await admin
    .from("orders")
    .select(
      "order_uuid, status, amount, credits, product_id, pg_tx_id, payment_id, provider, is_test, pay_channel, created_at, paid_at, user_id, refunded_credits, refunded_amount",
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

/** 통합 크레딧 변동 종류 — 3소스 병합 후의 표시 단위(원장 event_type 과 1:1 아님: refund_commit→refund). */
export type CreditHistoryKind =
  | "signup_bonus"
  | "purchase"
  | "gen_consume"
  | "gen_refund"
  | "cs_adjust"
  | "refund"
  | "refund_policy_close"
  | "expire";

export type CreditHistoryRow = {
  /** 소스 접두(cl:/aa:/lot:) + 원본 행 id — 병합 리스트 key 충돌 방지. */
  id: string;
  kind: CreditHistoryKind;
  delta: number;
  /** 이벤트 직전 잔액 = balanceAfter − delta(표시 델타 기준, 봉투 원장 정의상 항상 성립). '얼마에서 얼마가' 표시용. */
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** 운영자 조정 사유(cs_adjust)만 채움 — 그 외 null. 유저 화면엔 비노출(내부 메모 보호). */
  note: string | null;
  /** 어드민 표기용 ref(생성/주문/로트) — credit_ledger 소스만 채움. 유저 화면엔 비노출. */
  refs: { genId: string | null; orderUuid: string | null; lotId: string | null };
  createdAt: string;
};

/** 병합 조회 소스별 상한(현실적으로 충분 — 초과분은 최신 우선 절단). */
const HISTORY_SOURCE_CAP = 1000;

/**
 * 통합 생성권(크레딧) 변동 내역 — 3소스 시간순 병합(읽기 전용, 스키마 무변경). 유저/어드민 공용.
 *   1) credit_ledger — 구매·생성 차감/환불·만료·환불(refund_reserve/release 는 내부 잠금이라 표시 제외,
 *      refund_commit 만 'refund' 로. 내부환불은 회수량이 같은 attempt 의 예약 delta 에 있음).
 *   2) admin_actions_ledger(cs_adjust) — 운영자 조정.
 *   3) credit_lots(source='signup_bonus') — 가입 보너스(첫 이벤트라 잔액=qty).
 * 각 소스가 그 시점 잔액을 이미 보유 → 병합만으로 연속 타임라인. created_at desc 정렬 후 in-memory 페이징(10/page).
 * 소스별 에러는 빈 배열로 폴백(부분 실패에도 페이지 안전).
 */
export async function getCreditHistory(
  userId: string,
  page = 1
): Promise<Paged<CreditHistoryRow>> {
  const p = Math.max(1, page);
  const admin = createAdminClient();

  const [ledgerRes, adjustRes, lotsRes] = await Promise.all([
    admin
      .from("credit_ledger")
      .select(
        "id, delta, event_type, balance_after, ref_gen_id, ref_order_uuid, ref_lot_id, ref_attempt_id, ref_cancellation_id, created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_SOURCE_CAP),
    admin
      .from("admin_actions_ledger")
      .select("id, credit_delta, after_credits, reason, created_at")
      .eq("target_user_id", userId)
      .eq("action_type", "cs_adjust")
      .order("created_at", { ascending: false })
      .limit(HISTORY_SOURCE_CAP),
    admin
      .from("credit_lots")
      .select("id, qty, granted_at")
      .eq("user_id", userId)
      .eq("source", "signup_bonus")
      .order("granted_at", { ascending: false })
      .limit(HISTORY_SOURCE_CAP),
  ]);

  if (ledgerRes.error) log.warn("admin.credit_history_ledger_fail", errInfo(ledgerRes.error));
  if (adjustRes.error) log.warn("admin.credit_history_adjust_fail", errInfo(adjustRes.error));
  if (lotsRes.error) log.warn("admin.credit_history_lots_fail", errInfo(lotsRes.error));

  type LedgerRaw = {
    id: string;
    delta: number;
    event_type: string;
    balance_after: number | null;
    ref_gen_id: string | null;
    ref_order_uuid: string | null;
    ref_lot_id: string | null;
    ref_attempt_id: string | null;
    ref_cancellation_id: string | null;
    created_at: string;
  };
  const ledgerRows = (ledgerRes.data ?? []) as LedgerRaw[];

  // refund_commit(내부환불)이 참조할 예약 delta(−N) 맵 — reserve 를 버리기 전에 먼저 구성.
  const reserveDeltaByAttempt = new Map<string, number>();
  for (const r of ledgerRows) {
    if (r.event_type === "refund_reserve" && r.ref_attempt_id) {
      reserveDeltaByAttempt.set(r.ref_attempt_id, r.delta);
    }
  }

  // balanceBefore 는 마지막에 일괄 계산(after − delta) → 각 push 는 이를 제외하고 구성.
  const events: Omit<CreditHistoryRow, "balanceBefore">[] = [];

  for (const r of ledgerRows) {
    const refs = { genId: r.ref_gen_id, orderUuid: r.ref_order_uuid, lotId: r.ref_lot_id };
    switch (r.event_type) {
      case "purchase":
      case "gen_consume":
      case "gen_refund":
      case "expire":
      case "refund_policy_close":
        events.push({
          id: `cl:${r.id}`,
          kind: r.event_type,
          delta: r.delta,
          balanceAfter: r.balance_after,
          note: null,
          refs,
          createdAt: r.created_at,
        });
        break;
      case "refund_commit": {
        // 내부환불(ref_attempt_id): 실제 회수량 = 같은 attempt 의 예약(−N) delta.
        // 외부취소(ref_cancellation_id): 이 행 delta 가 이미 −N.
        const delta = r.ref_attempt_id
          ? reserveDeltaByAttempt.get(r.ref_attempt_id) ?? r.delta
          : r.delta;
        events.push({
          id: `cl:${r.id}`,
          kind: "refund",
          delta,
          balanceAfter: r.balance_after,
          note: null,
          refs,
          createdAt: r.created_at,
        });
        break;
      }
      // refund_reserve · refund_release → 내부 잠금(표시 제외).
      default:
        break;
    }
  }

  type AdjustRaw = {
    id: string;
    credit_delta: number;
    after_credits: number;
    reason: string;
    created_at: string;
  };
  for (const a of (adjustRes.data ?? []) as AdjustRaw[]) {
    events.push({
      id: `aa:${a.id}`,
      kind: "cs_adjust",
      delta: a.credit_delta,
      balanceAfter: a.after_credits,
      note: a.reason,
      refs: { genId: null, orderUuid: null, lotId: null },
      createdAt: a.created_at,
    });
  }

  type LotRaw = { id: string; qty: number; granted_at: string };
  for (const l of (lotsRes.data ?? []) as LotRaw[]) {
    events.push({
      id: `lot:${l.id}`,
      kind: "signup_bonus",
      delta: l.qty,
      balanceAfter: l.qty, // 가입은 첫 이벤트라 잔액 = 부여량.
      note: null,
      refs: { genId: null, orderUuid: null, lotId: null },
      createdAt: l.granted_at,
    });
  }

  // created_at desc — 동시각은 id 로 안정 정렬.
  events.sort(
    (x, y) =>
      new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime() ||
      y.id.localeCompare(x.id)
  );

  const total = events.length;
  const from = (p - 1) * USER_PAGE_SIZE;
  // 표시 델타 기준 직전 잔액 유도 — 봉투 원장 정의상 before = after − delta(환불 확정처럼
  // 델타를 예약값으로 치환한 케이스도 balanceAfter 가 예약 반영 후 스냅샷이라 동일하게 성립).
  const rows: CreditHistoryRow[] = events
    .slice(from, from + USER_PAGE_SIZE)
    .map((e) => ({
      ...e,
      balanceBefore: e.balanceAfter == null ? null : e.balanceAfter - e.delta,
    }));
  return { rows, total, page: p, pageSize: USER_PAGE_SIZE };
}

/**
 * 유저 크레딧 로트 현황(0062) — 최신 부여순(granted_at desc, id tiebreak). 유저당 로트 수는
 * 구매+보너스 수준이라 페이징 없이 상한 100(초과분은 사실상 없음 — 초과 시 최신 100만 표시).
 */
export async function getUserLots(userId: string): Promise<UserLotRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("credit_lots")
    .select(
      "id, source, order_uuid, qty, consumed, refunded, refund_reserved, granted_at, expires_at, expired_at, expiration_reason"
    )
    .eq("user_id", userId)
    .order("granted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (error) {
    log.warn("admin.user_lots_fail", errInfo(error));
    return [];
  }
  return (data ?? []) as UserLotRow[];
}

export type UserRefundActivity = {
  /** 진행 중(비종단) 환불 요청 — building·prepared·processing·blocked. */
  requests: RefundRequestRow[];
  /** open 대사 이슈(전 타입). */
  issues: ReconIssueRow[];
};

/** 유저 진행 중 환불 요청 + open 이슈(0062) — 회원 상세 표시 전용(조치는 /admin/refunds). */
export async function getUserRefundActivity(userId: string): Promise<UserRefundActivity> {
  const admin = createAdminClient();
  const [requests, issues] = await Promise.all([
    admin
      .from("refund_requests")
      .select("id, user_id, origin, scope_order_uuid, requested_qty, approved_amount, state, reason, created_at")
      .eq("user_id", userId)
      .in("state", [...ACTIVE_REQUEST_STATES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    admin
      .from("reconciliation_issues")
      .select("id, type, order_uuid, user_id, cancellation_id, state, created_at")
      .eq("user_id", userId)
      .eq("state", "open")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
  ]);
  if (requests.error) log.warn("admin.user_refund_requests_fail", errInfo(requests.error));
  if (issues.error) log.warn("admin.user_refund_issues_fail", errInfo(issues.error));
  // 본인 상세 페이지 문맥이라 display_name 채움 불필요(헤더가 이미 표기) — null 고정.
  const withName = <T>(rows: T[] | null | undefined) =>
    (rows ?? []).map((r) => ({ ...r, display_name: null as string | null }));
  return {
    requests: withName(requests.data as Omit<RefundRequestRow, "display_name">[] | null),
    issues: withName(issues.data as Omit<ReconIssueRow, "display_name">[] | null),
  };
}
