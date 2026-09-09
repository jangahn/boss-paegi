import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabasePage } from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";

// 「공유·유입」 원본 이벤트(analytics_events raw) 조회 — 집계(admin-acquisition)와 파일을 분리해 작게 유지(v1.31).
// 규약: 최신순(created_at desc, id desc — 정렬키=표시키·id tiebreaker), 50건 페이지, 종류 필터만.
// UA·레퍼러 원문은 저장 시점에 파싱하지 않고(어떤 앱/브라우저가 오는지 미리 알 수 없음) 그대로 보여준다.
// raw 는 90일 prune 대상이므로 이 화면도 최근 90일이 상한이다. 식별자 컬럼은 없다(무식별 도메인).

import { type AnalyticsEventKind } from "@/lib/admin-acquisition-labels";

export { ANALYTICS_EVENT_KINDS, isAnalyticsEventKind, type AnalyticsEventKind } from "@/lib/admin-acquisition-labels";

export const ANALYTICS_EVENTS_PAGE_SIZE = 50;

export type AnalyticsEventRow = {
  id: string;
  created_at: string;
  day_kst: string;
  kind: AnalyticsEventKind;
  member_state: string;
  source_scope: string | null;
  source_kind: string | null;
  source_value: string | null;
  referrer_domain: string | null;
  utm_source: string | null;
  viral_type: string | null;
  landing: string | null;
  surface: string | null;
  target: string | null;
  score_tier: number | null;
  conversion_step: string | null;
  ua: string | null;
  referrer_url: string | null;
};

const SELECT =
  "id,created_at,day_kst,kind,member_state,source_scope,source_kind,source_value,referrer_domain,utm_source,viral_type,landing,surface,target,score_tier,conversion_step,ua,referrer_url";

export type AnalyticsEventsPage = {
  rows: AnalyticsEventRow[];
  total: number;
  page: number;
  pageSize: number;
};

export async function getAnalyticsEvents(opts: {
  page?: number;
  kind?: AnalyticsEventKind | null;
}): Promise<AnalyticsEventsPage> {
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * ANALYTICS_EVENTS_PAGE_SIZE;
  const to = from + ANALYTICS_EVENTS_PAGE_SIZE - 1;
  const admin = createAdminClient();

  let qb = admin
    .from("analytics_events")
    .select(SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (opts.kind) qb = qb.eq("kind", opts.kind);

  const result = await requireSupabasePage("admin.acquisition.events", () => qb.range(from, to));
  const rows = validateAdminRows<AnalyticsEventRow>("admin.acquisition.events", result.rows, {
    id: "uuid",
    created_at: "timestamp",
    day_kst: "date",
    kind: "string",
    member_state: "string",
    source_scope: "nullableString",
    source_kind: "nullableString",
    source_value: "nullableString",
    referrer_domain: "nullableString",
    utm_source: "nullableString",
    viral_type: "nullableString",
    landing: "nullableString",
    surface: "nullableString",
    target: "nullableString",
    score_tier: "nullableSafeInteger",
    conversion_step: "nullableString",
    ua: "nullableText",
    referrer_url: "nullableText",
  });
  return { rows, total: result.count, page, pageSize: ANALYTICS_EVENTS_PAGE_SIZE };
}
