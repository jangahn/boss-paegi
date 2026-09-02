import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { RETIRED_WEAPONS, WEAPONS } from "@/lib/weapons";
import { WEAPON_KEYS, MAP_KEYS } from "@/lib/telemetry/budget";
import type { StatWindow } from "@/lib/admin-period";
import {
  histogramCount,
  histogramMedian,
  herfindahlOf,
  parseBucketKey,
  type HistBucket,
} from "@/lib/admin-analytics-math";
import {
  readSupabaseRowsPaginated,
  requireSupabaseOptionalData,
  requireSupabaseRows,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";

/**
 * 게임플레이 분석 — 하이브리드(v1.06): 오늘 = `telemetry_rollup_rows_for_day`(단일 소스 RPC) 라이브,
 * 어제까지 = telemetry_rollups(`day_kst < 오늘`만 — 이중계산 차단) 윈도우 합산(JS).
 * 집계 의미(메인무기 tie-break·throughput 게이트·렉 경계 등)의 단일 소스는 0110 SQL 함수다.
 * 중앙값 지표는 일별 히스토그램(sps 폭1·cap3000 / perf 폭1ms·cap200, 0110 불변 상수) 근사 복원.
 * 예외(raw 직조회 유지): 재방문(윈도우 간 회원 distinct — 일단위 분해 불가)·최악 top5(개별 행)·세션 인스펙터.
 */

export type DimStat = { key: string; sessions: number; hits: number; score: number; attempts: number; switches: number };
export type Funnel = Record<string, number>;
export type SessionRow = {
  id: string; started_at: string; is_anon: boolean; owner_id: string | null;
  /** 회원 닉네임(profiles 임베드) — owner_id null(익명·프로필 삭제 잔존)이면 null. */
  owner_name: string | null;
  end_reason: string | null; duration_ms: number | null; score: number;
  hit_count: number; distinct_weapons: number; distinct_maps: number; device_class: string;
};
export type SessionDetail = {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  is_anon: boolean;
  device_class: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  duration_ms: number | null;
  score: number | null;
  hit_count: number | null;
  max_combo: number | null;
  ult_fire_count: number | null;
  distinct_weapons: number | null;
  distinct_maps: number | null;
  apm: number | null;
  tap_share: number | null;
  max_touch: number | null;
  weapon_summary: Record<string, unknown>;
  map_summary: Record<string, unknown>;
  first_hit_ms: number | null;
  first_switch_ms: number | null;
  timeline: unknown[] | null;
  has_gap: boolean;
  suspicious: boolean;
};

/** profiles(display_name) 임베드 → 닉네임 평탄화(주문 어드민 mapOrder 와 동일 관용구). */
function embeddedName(p: { display_name: string | null } | { display_name: string | null }[] | null): string | null {
  const row = Array.isArray(p) ? p[0] : p;
  return row?.display_name ?? null;
}

/** KST 기준 offsetDays 일 전 날짜 문자열(YYYY-MM-DD). 공유·유입 분석(lib/admin-acquisition)도 재사용. */
export function kstDate(offsetDays = 0): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - offsetDays);
  return kst.toISOString().slice(0, 10);
}

/**
 * KST 기준 offsetDays 일 전의 KST 자정을 UTC instant(ISO)로.
 * 라이브(telemetry_sessions) 윈도우의 시작 경계를 롤업의 day_kst 경계와 정확히 일치시키기 위함
 * (둘 다 같은 kstDate 에서 파생 → 재드리프트 방지). KST 는 DST 없음.
 */
function kstDayStartIso(offsetDays = 0): string {
  return new Date(`${kstDate(offsetDays)}T00:00:00+09:00`).toISOString();
}

/* ──────────────────────────────────────────────────────────────────────────
 * 하이브리드 dim 행 fetch — 롤업(어제까지) + 라이브(오늘, per-request 1회 RPC).
 * ────────────────────────────────────────────────────────────────────────── */

type DimRow = {
  dimType: string;
  dimKey: string;
  sessions: number;
  hits: number;
  score: number;
  attempts: number;
  switches: number;
  measureA: number;
};

const DIM_VALUE_SCHEMA = {
  dim_type: "string",
  dim_key: "string",
  sessions: "nonnegativeNumeric",
  hits: "nonnegativeNumeric",
  score: "nonnegativeNumeric",
  attempts: "nonnegativeNumeric",
  switches: "nonnegativeNumeric",
  measure_a: "nonnegativeNumeric",
} as const;

type RawDimRow = {
  dim_type: string;
  dim_key: string;
  sessions: number | string;
  hits: number | string;
  score: number | string;
  attempts: number | string;
  switches: number | string;
  measure_a: number | string;
};

function toDimRow(r: RawDimRow): DimRow {
  return {
    dimType: r.dim_type,
    dimKey: r.dim_key,
    sessions: Number(r.sessions) || 0,
    hits: Number(r.hits) || 0,
    score: Number(r.score) || 0,
    attempts: Number(r.attempts) || 0,
    switches: Number(r.switches) || 0,
    measureA: Number(r.measure_a) || 0,
  };
}

/** 오늘 하루 라이브 집계 — 렌더당 1회(React cache). cron 이 쓰는 것과 같은 단일 소스 RPC. */
const liveTelemetryToday = cache(async (): Promise<DimRow[]> => {
  const admin = createAdminClient();
  const data = await requireSupabaseRows(
    "admin.analytics.live_today",
    () => admin.rpc("telemetry_rollup_rows_for_day", { p_day: kstDate(0) }),
  );
  return validateAdminRows<RawDimRow>(
    "admin.analytics.live_today",
    data,
    DIM_VALUE_SCHEMA,
  ).map(toDimRow);
});

/** 윈도우 dim 행 = 롤업(day_kst < 오늘, 윈도우 cutoff) + 라이브(오늘). */
async function fetchDimRows(dimTypes: readonly string[], window: StatWindow): Promise<DimRow[]> {
  const admin = createAdminClient();
  const today = kstDate(0);
  const operation = `admin.analytics.rollup.${dimTypes.join("+")}`;
  const data = await readSupabaseRowsPaginated(
    operation,
    (offset, limit) => {
      let q = admin
        .from("telemetry_rollups")
        .select("day_kst,dim_type,dim_key,sessions,hits,score,attempts,switches,measure_a")
        .in("dim_type", [...dimTypes])
        .lt("day_kst", today);
      if (window !== "all") q = q.gte("day_kst", kstDate(window - 1));
      return q
        .order("day_kst", { ascending: true })
        .order("dim_type", { ascending: true })
        .order("dim_key", { ascending: true })
        .range(offset, offset + limit - 1);
    },
    500,
  );
  const rollup = validateAdminRows<RawDimRow & { day_kst: string }>(
    operation,
    data,
    { day_kst: "date", ...DIM_VALUE_SCHEMA },
  ).map(toDimRow);
  const live = (await liveTelemetryToday()).filter((r) => dimTypes.includes(r.dimType));
  return [...rollup, ...live];
}

/** dim_key 별 윈도우 합산 → hits 내림차순. */
async function dimBalance(dimType: string, window: StatWindow): Promise<DimStat[]> {
  const rows = await fetchDimRows([dimType], window);
  const agg = new Map<string, DimStat>();
  for (const r of rows) {
    const cur = agg.get(r.dimKey) ?? { key: r.dimKey, sessions: 0, hits: 0, score: 0, attempts: 0, switches: 0 };
    cur.sessions += r.sessions;
    cur.hits += r.hits;
    cur.score += r.score;
    cur.attempts += r.attempts;
    cur.switches += r.switches;
    agg.set(r.dimKey, cur);
  }
  return [...agg.values()].sort((a, b) => b.hits - a.hits);
}

export function getWeaponBalance(window: StatWindow): Promise<DimStat[]> {
  return dimBalance("weapon", window);
}
export function getMapBalance(window: StatWindow): Promise<DimStat[]> {
  return dimBalance("map", window);
}

/** 펀널 단계 윈도우 합산. */
export async function getFunnel(window: StatWindow): Promise<Funnel> {
  const rows = await fetchDimRows(["funnel_step"], window);
  const out: Funnel = {};
  for (const r of rows) out[r.dimKey] = (out[r.dimKey] ?? 0) + r.sessions;
  return out;
}

/**
 * 회원 활동(코호트·재방문 — 익명 ephemeral 이라 회원 owner_id 한정).
 * 하이브리드 예외 — "윈도우 내 2회+ 회원" 은 일단위로 분해 불가(월·수 1판씩인 회원은 어느 하루에도
 * 안 잡힘)해서 raw 직조회를 유지한다. 회원 세션은 30일 prune 대상이 아니라 '전체'도 조회되지만,
 * 30MB 예산 초과 삭제(0028)가 오래된 세션부터 지울 수 있어 장기적으론 best-effort.
 */
export async function getMemberActivity(window: StatWindow): Promise<{ sessions: number; members: number; returning: number }> {
  const admin = createAdminClient();
  const cutoffIso = window === "all" ? null : kstDayStartIso(window - 1); // 롤업 day_kst 경계와 정합
  const raw = await readSupabaseRowsPaginated(
    "admin.analytics.member_activity",
    (offset, limit) => {
      let q = admin
        .from("telemetry_sessions")
        .select("owner_id")
        .not("owner_id", "is", null);
      if (cutoffIso) q = q.gte("started_at", cutoffIso);
      // ORDER BY 없는 limit 은 표본이 비결정적 — 최근 우선으로 고정.
      return q
        .order("started_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
    },
    500,
  );
  const data = validateAdminRows<{ owner_id: string }>(
    "admin.analytics.member_activity",
    raw,
    { owner_id: "uuid" },
  );
  const counts = new Map<string, number>();
  for (const r of data) counts.set(r.owner_id as string, (counts.get(r.owner_id as string) ?? 0) + 1);
  const returning = [...counts.values()].filter((n) => n >= 2).length;
  return { sessions: data.length, members: counts.size, returning };
}

/** 최근 세션 목록(인스펙터 진입). */
export async function getRecentSessions(limit = 50): Promise<SessionRow[]> {
  const admin = createAdminClient();
  const data = await requireSupabaseRows(
    "admin.analytics.recent_sessions",
    () =>
      admin
        .from("telemetry_sessions")
        .select(
          "id,started_at,is_anon,owner_id,end_reason,duration_ms,score,hit_count,distinct_weapons,distinct_maps,device_class,profiles(display_name)",
        )
        .order("started_at", { ascending: false })
        .limit(limit),
  );
  const rows = validateAdminRows<
    Omit<SessionRow, "owner_name"> & {
      profiles:
        | { display_name: string | null }
        | { display_name: string | null }[]
        | null;
    }
  >("admin.analytics.recent_sessions", data, {
    id: "uuid",
    started_at: "timestamp",
    is_anon: "boolean",
    owner_id: "nullableUuid",
    end_reason: "nullableString",
    duration_ms: "nullableNonnegativeInteger",
    score: "nonnegativeInteger",
    hit_count: "nonnegativeInteger",
    distinct_weapons: "nonnegativeInteger",
    distinct_maps: "nonnegativeInteger",
    device_class: "string",
    profiles: "embed",
  });
  return rows.map(({ profiles, ...row }) => {
    const values =
      profiles === null ? [] : Array.isArray(profiles) ? profiles : [profiles];
    const profileRows = validateAdminRows<{ display_name: string | null }>(
      "admin.analytics.recent_sessions.profile",
      values,
      { display_name: "nullableString" },
    );
    if (profileRows.length > 1) {
      throw new SupabaseOperationError(
        "admin.analytics.recent_sessions",
        new Error("ambiguous_profile_embed"),
      );
    }
    return { ...row, owner_name: embeddedName(profiles) };
  });
}

/** 세션 상세(타임라인 재생). 없으면 null(pruned/미존재). */
export async function getSessionDetail(
  id: string,
): Promise<SessionDetail | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    "admin.analytics.session_detail",
    () =>
      admin
        .from("telemetry_sessions")
        .select("*, profiles(display_name)")
        .eq("id", id)
        .maybeSingle(),
  );
  if (!data) return null;
  type RawDetail = Omit<SessionDetail, "owner_name" | "score" | "tap_share"> & {
    score: number | string | null;
    tap_share: number | string | null;
    profiles:
      | { display_name: string | null }
      | { display_name: string | null }[]
      | null;
  };
  const detail = validateAdminRows<RawDetail>(
    "admin.analytics.session_detail",
    [data],
    {
      id: "uuid",
      owner_id: "nullableUuid",
      is_anon: "boolean",
      device_class: "string",
      started_at: "timestamp",
      ended_at: "nullableTimestamp",
      end_reason: "nullableString",
      duration_ms: "nullableNonnegativeInteger",
      score: "nullableNonnegativeNumeric",
      hit_count: "nullableNonnegativeInteger",
      max_combo: "nullableNonnegativeInteger",
      ult_fire_count: "nullableNonnegativeInteger",
      distinct_weapons: "nullableNonnegativeInteger",
      distinct_maps: "nullableNonnegativeInteger",
      apm: "nullableNonnegativeInteger",
      tap_share: "nullableNonnegativeNumeric",
      max_touch: "nullableNonnegativeInteger",
      weapon_summary: "jsonObject",
      map_summary: "jsonObject",
      first_hit_ms: "nullableNonnegativeInteger",
      first_switch_ms: "nullableNonnegativeInteger",
      timeline: "nullableArray",
      has_gap: "boolean",
      suspicious: "boolean",
      profiles: "embed",
    },
  )[0];
  const { profiles, ...row } = detail;
  const profileValues =
    profiles === null
      ? []
      : Array.isArray(profiles)
        ? profiles
        : [profiles];
  validateAdminRows(
    "admin.analytics.session_detail.profile",
    profileValues,
    { display_name: "nullableString" },
  );
  if (profileValues.length > 1) {
    throw new SupabaseOperationError(
      "admin.analytics.session_detail",
      new Error("ambiguous_profile_embed"),
    );
  }
  if (detail.tap_share !== null && Number(detail.tap_share) > 1) {
    throw new SupabaseOperationError(
      "admin.analytics.session_detail",
      new Error("invalid_tap_share"),
    );
  }
  validateDimSummary(
    "admin.analytics.session_detail.weapon_summary",
    detail.weapon_summary as DimSummary,
  );
  validateDimSummary(
    "admin.analytics.session_detail.map_summary",
    detail.map_summary as DimSummary,
  );
  const profile = profileValues[0] as
    | { display_name: string | null }
    | undefined;
  return {
    ...(row as Omit<RawDetail, "profiles">),
    score: detail.score === null ? null : Number(detail.score),
    tap_share:
      detail.tap_share === null ? null : Number(detail.tap_share),
    owner_name: profile?.display_name ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * 세션 단위 분석(편중/효율/맵고착/퍼포먼스) — 0110 부터 롤업 dim(sess_*)을 하이브리드로 읽는다.
 * 집계 의미의 단일 소스는 telemetry_rollup_rows_for_day(0110). unknown key 접기·라벨은 표시 관심사라
 * 여기(getter)서 수행. '전체' 윈도우의 과거(0110 백필 이전 소실분)는 잔존 세션 기준 근사 — 페이지가 각주.
 * ────────────────────────────────────────────────────────────────────────── */

/** 표본 절단은 롤업 경로에선 발생하지 않는다 — meta 형태 호환용 상한 상수만 유지. */
const SESSION_FETCH_LIMIT = 5000;
const TAP_KEYS = new Set<string>(WEAPONS.filter((w) => w.category === "tap").map((w) => w.key));
// 은퇴 무기(종이)도 known — 역사 세션의 메인무기·히스토그램이 "알 수 없음" 으로 뭉개지지 않게(어드민은 "(은퇴)" 라벨로 구분)
const KNOWN_WEAPONS = new Set<string>([...WEAPON_KEYS, ...RETIRED_WEAPONS.map((w) => w.key)]);
const KNOWN_MAPS = new Set<string>(MAP_KEYS);
/** 0110 히스토그램 불변 버킷 스펙(저장 포맷) — SQL 상수와 동일해야 한다. */
const SPS_BUCKET_WIDTH = 1;
const PERF_BUCKET_WIDTH = 1;

type DimSummary = Record<string, { hits?: number; score?: number; attempts?: number; switches?: number } | undefined>;

function validateDimSummary(
  operation: string,
  value: DimSummary | null,
): void {
  if (value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.length === 0 ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      throw new SupabaseOperationError(
        operation,
        new Error("invalid_dimension_summary"),
      );
    }
    for (const field of ["hits", "score", "attempts", "switches"] as const) {
      const next = entry[field];
      if (
        next !== undefined &&
        (!Number.isSafeInteger(next) || next < 0)
      ) {
        throw new SupabaseOperationError(
          operation,
          new Error(`invalid_dimension_summary:${field}`),
        );
      }
    }
  }
}

/** 표본 메타 — 롤업 경로에선 절단이 없어 isTruncated 항상 false(형태 호환 유지). */
export type SampleMeta = { sampleSize: number; isTruncated: boolean; limit: number };

/** unknown 무기 key 는 'unknown' 으로 묶음(throw 금지). */
function weaponLabel(k: string): string {
  return KNOWN_WEAPONS.has(k) ? k : "unknown";
}

/** sess_stat 스칼라 합산 헬퍼. */
function sumSessStats(rows: DimRow[]): (key: string) => number {
  const agg = new Map<string, number>();
  for (const r of rows) {
    if (r.dimType !== "sess_stat") continue;
    agg.set(r.dimKey, (agg.get(r.dimKey) ?? 0) + r.measureA);
  }
  return (key: string) => agg.get(key) ?? 0;
}

/** 히스토그램 dim 행 → 그룹(라벨)별 버킷 카운트 맵. dim_key 형식 불량은 계약 위반으로 throw. */
function collectHistograms(
  operation: string,
  rows: DimRow[],
  dimType: string,
  groupLabel: (raw: string) => string,
): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (r.dimType !== dimType) continue;
    const parsed = parseBucketKey(r.dimKey);
    if (!parsed) {
      throw new SupabaseOperationError(operation, new Error(`invalid_bucket_key:${r.dimKey}`));
    }
    const label = groupLabel(parsed.group);
    const hist = out.get(label) ?? new Map<number, number>();
    hist.set(parsed.bucket, (hist.get(parsed.bucket) ?? 0) + r.measureA);
    out.set(label, hist);
  }
  return out;
}

function histEntries(hist: Map<number, number> | undefined): HistBucket[] {
  return [...(hist ?? new Map<number, number>()).entries()].map(([bucket, count]) => ({ bucket, count }));
}

export type WeaponConcentration = SampleMeta & {
  /** 무기를 1개 이상 쓴 세션 수(편중 분모) */
  weaponSessions: number;
  /** 단일무기 세션 비율(0~1) */
  singleWeaponPct: number;
  avgDistinctWeapons: number;
  /** 메인무기별 세션 수(unknown 묶음) — 표본수=값 */
  mainWeaponDist: Record<string, number>;
  /** tap 카테고리 hit 비중(known 무기 기준) */
  tapCategoryShare: number;
  /** known 무기 hit / 전체 hit (unknown 커버리지) */
  knownHitCoverage: number;
  /** 세션 평균 집중도(주력) — 세션별 HHI 평균 */
  avgSessionConcentration: number | null;
  /** 전체 타격분포 집중도(보조) */
  aggregateHitConcentration: number | null;
};

export async function getWeaponConcentration(window: StatWindow): Promise<WeaponConcentration> {
  const rows = await fetchDimRows(["sess_stat", "sess_main_weapon", "weapon"], window);
  const stat = sumSessStats(rows);
  const mainWeaponDist: Record<string, number> = {};
  const knownAgg: Record<string, number> = {};
  let tapHits = 0;
  let knownHits = 0;
  let allHits = 0;
  for (const r of rows) {
    if (r.dimType === "sess_main_weapon") {
      const label = weaponLabel(r.dimKey);
      mainWeaponDist[label] = (mainWeaponDist[label] ?? 0) + r.measureA;
    } else if (r.dimType === "weapon") {
      allHits += r.hits;
      if (KNOWN_WEAPONS.has(r.dimKey)) {
        knownHits += r.hits;
        knownAgg[r.dimKey] = (knownAgg[r.dimKey] ?? 0) + r.hits;
        if (TAP_KEYS.has(r.dimKey)) tapHits += r.hits;
      }
    }
  }
  const weaponSessions = stat("weapon_sessions");
  const hhiSessions = stat("hhi_sessions");
  return {
    sampleSize: stat("sessions_total"),
    isTruncated: false,
    limit: SESSION_FETCH_LIMIT,
    weaponSessions,
    singleWeaponPct: weaponSessions > 0 ? stat("single_weapon_sessions") / weaponSessions : 0,
    avgDistinctWeapons: weaponSessions > 0 ? stat("distinct_weapons_sum") / weaponSessions : 0,
    mainWeaponDist,
    tapCategoryShare: knownHits > 0 ? tapHits / knownHits : 0,
    knownHitCoverage: allHits > 0 ? knownHits / allHits : 1,
    avgSessionConcentration: hhiSessions > 0 ? stat("hhi_sum") / hhiSessions : null,
    aggregateHitConcentration: herfindahlOf(knownAgg),
  };
}

export type WeaponThroughputRow = {
  weapon: string;
  allN: number;
  pureN: number;
  /** 메인무기 기준 점수/초 중앙값(히스토그램 근사) */
  medianAll: number | null;
  /** 단일무기(pure) 세션 점수/초 중앙값(히스토그램 근사) */
  medianPure: number | null;
};
export type WeaponThroughput = SampleMeta & {
  totalSessions: number;
  /** throughput 계산에 쓰인 세션(완료·유효 duration) */
  eligibleSessions: number;
  excludedSessions: number;
  rows: WeaponThroughputRow[];
};

export async function getWeaponThroughput(window: StatWindow): Promise<WeaponThroughput> {
  const rows = await fetchDimRows(["sess_stat", "sess_sps_all", "sess_sps_pure"], window);
  const stat = sumSessStats(rows);
  const all = collectHistograms("admin.analytics.sps_hist", rows, "sess_sps_all", weaponLabel);
  const pure = collectHistograms("admin.analytics.sps_hist", rows, "sess_sps_pure", weaponLabel);

  const keys = new Set<string>([...all.keys(), ...pure.keys()]);
  const out: WeaponThroughputRow[] = [];
  for (const k of keys) {
    const a = histEntries(all.get(k));
    const p = histEntries(pure.get(k));
    out.push({
      weapon: k,
      allN: histogramCount(a),
      pureN: histogramCount(p),
      medianAll: histogramMedian(a, SPS_BUCKET_WIDTH),
      medianPure: histogramMedian(p, SPS_BUCKET_WIDTH),
    });
  }
  out.sort((x, y) => (y.medianPure ?? y.medianAll ?? 0) - (x.medianPure ?? x.medianAll ?? 0));

  const totalSessions = stat("sessions_total");
  const eligibleSessions = stat("throughput_eligible");
  return {
    sampleSize: totalSessions,
    isTruncated: false,
    limit: SESSION_FETCH_LIMIT,
    totalSessions,
    eligibleSessions,
    excludedSessions: Math.max(0, totalSessions - eligibleSessions),
    rows: out,
  };
}

export type MapStickiness = SampleMeta & {
  /** 맵 데이터가 있는 세션 수(분모) */
  validMapSessions: number;
  singleMapPct: number;
  avgDistinctMaps: number;
  /** 세션당 맵 전환 이벤트 수 */
  mapSwitchRate: number;
  /** 시작맵별 세션 수(unknown 묶음) */
  startMapDist: Record<string, number>;
};

export async function getMapStickiness(window: StatWindow): Promise<MapStickiness> {
  const rows = await fetchDimRows(["sess_stat", "sess_start_map"], window);
  const stat = sumSessStats(rows);
  const startMapDist: Record<string, number> = {};
  for (const r of rows) {
    if (r.dimType !== "sess_start_map") continue;
    const label = KNOWN_MAPS.has(r.dimKey) ? r.dimKey : "unknown";
    startMapDist[label] = (startMapDist[label] ?? 0) + r.measureA;
  }
  const valid = stat("map_sessions");
  return {
    sampleSize: stat("sessions_total"),
    isTruncated: false,
    limit: SESSION_FETCH_LIMIT,
    validMapSessions: valid,
    singleMapPct: valid > 0 ? stat("single_map_sessions") / valid : 0,
    avgDistinctMaps: valid > 0 ? stat("distinct_maps_sum") / valid : 0,
    mapSwitchRate: valid > 0 ? stat("map_switch_sum") / valid : 0,
    startMapDist,
  };
}

// ── 디바이스 렌더 퍼포먼스(렉 진단) — 세션수·렉수는 sess_perf_dev 정확값, 중앙값은 히스토그램 근사 ──

export type DevicePerfStat = {
  deviceClass: string;
  sessions: number;
  medAvgMs: number;
  medP95Ms: number;
  estFps: number; // 1000 / medAvgMs
  lagRate: number; // p95 > 33ms 비율(0~1)
};
export type WorstPerfSession = {
  id: string;
  deviceClass: string;
  dpr: number;
  refreshHz: number;
  avgMs: number;
  p95Ms: number;
  durationMs: number | null;
};
export type DevicePerf = {
  byDevice: DevicePerfStat[];
  worst: WorstPerfSession[];
  perfSessions: number; // perf 실데이터 세션 수(avg>0)
  meta: SampleMeta;
};

type PerfRow = {
  id: string;
  device_class: string;
  dpr: number | null;
  refresh_hz: number | null;
  avg_frame_ms: number;
  p95_frame_ms: number;
  duration_ms: number | null;
};

const PERF_SELECT = "id, device_class, dpr, refresh_hz, avg_frame_ms, p95_frame_ms, duration_ms";

export async function getDevicePerf(window: StatWindow): Promise<DevicePerf> {
  const admin = createAdminClient();
  const cutoffIso = window === "all" ? null : kstDayStartIso(window - 1);
  const [rows, worstData] = await Promise.all([
    fetchDimRows(["sess_perf_dev", "sess_perf_avg", "sess_perf_p95"], window),
    // 최악 top5 는 개별 세션 행이라 raw 직조회 유지(하이브리드 예외) — '전체'는 잔존 세션 한정.
    requireSupabaseRows(
      "admin.analytics.device_perf.worst",
      () => {
        let q = admin
          .from("telemetry_sessions")
          .select(PERF_SELECT)
          .gt("avg_frame_ms", 0); // 실프레임 표본 세션만(무플레이/배포前 0 제외)
        if (cutoffIso) q = q.gte("started_at", cutoffIso);
        return q.order("p95_frame_ms", { ascending: false }).limit(5);
      },
    ),
  ]);
  const worstRows = validateAdminRows<PerfRow>(
    "admin.analytics.device_perf.worst",
    worstData,
    {
      id: "uuid",
      device_class: "string",
      dpr: "nullableNonnegativeNumeric",
      refresh_hz: "nullableNonnegativeNumeric",
      avg_frame_ms: "nonnegativeNumeric",
      p95_frame_ms: "nonnegativeNumeric",
      duration_ms: "nullableNonnegativeInteger",
    },
  );

  const avgHists = collectHistograms("admin.analytics.perf_hist", rows, "sess_perf_avg", (g) => g);
  const p95Hists = collectHistograms("admin.analytics.perf_hist", rows, "sess_perf_p95", (g) => g);
  const byClass = new Map<string, { sessions: number; lag: number }>();
  for (const r of rows) {
    if (r.dimType !== "sess_perf_dev") continue;
    const cur = byClass.get(r.dimKey) ?? { sessions: 0, lag: 0 };
    cur.sessions += r.sessions;
    cur.lag += r.measureA;
    byClass.set(r.dimKey, cur);
  }
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const byDevice: DevicePerfStat[] = [...byClass.entries()]
    .map(([deviceClass, g]) => {
      const medAvg = histogramMedian(histEntries(avgHists.get(deviceClass)), PERF_BUCKET_WIDTH) ?? 0;
      const medP95 = histogramMedian(histEntries(p95Hists.get(deviceClass)), PERF_BUCKET_WIDTH) ?? 0;
      return {
        deviceClass,
        sessions: g.sessions,
        medAvgMs: round1(medAvg),
        medP95Ms: round1(medP95),
        estFps: medAvg > 0 ? Math.round(1000 / medAvg) : 0,
        lagRate: g.sessions > 0 ? g.lag / g.sessions : 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  const worst: WorstPerfSession[] = worstRows.map((r) => ({
    id: r.id,
    deviceClass: r.device_class,
    dpr: Number(r.dpr) || 0,
    refreshHz: Number(r.refresh_hz) || 0,
    avgMs: round1(r.avg_frame_ms),
    p95Ms: round1(r.p95_frame_ms),
    durationMs: r.duration_ms,
  }));

  const perfSessions = [...byClass.values()].reduce((s, g) => s + g.sessions, 0);
  return {
    byDevice,
    worst,
    perfSessions,
    meta: { sampleSize: perfSessions, isTruncated: false, limit: SESSION_FETCH_LIMIT },
  };
}
