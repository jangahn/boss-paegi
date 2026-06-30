import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { WEAPONS } from "@/lib/weapons";
import { WEAPON_KEYS, MAP_KEYS } from "@/lib/telemetry/budget";
import { log, errInfo } from "@/lib/log";

/**
 * 게임플레이 분석 — telemetry_rollups(일×차원 사전집계)를 읽어 윈도우 합산(JS).
 * 롤업은 작음(차원당 N일 행). 세션 인스펙터만 telemetry_sessions 직접.
 */

export type DimStat = { key: string; sessions: number; hits: number; score: number; attempts: number; switches: number };
export type Funnel = Record<string, number>;
export type SessionRow = {
  id: string; started_at: string; is_anon: boolean; owner_id: string | null;
  end_reason: string | null; duration_ms: number | null; score: number;
  hit_count: number; distinct_weapons: number; distinct_maps: number; device_class: string;
};

/** KST 기준 offsetDays 일 전 날짜 문자열(YYYY-MM-DD). 공유·유입 분석(lib/admin-acquisition)도 재사용. */
export function kstDate(offsetDays = 0): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - offsetDays);
  return kst.toISOString().slice(0, 10);
}

/**
 * KST 기준 offsetDays 일 전의 KST 자정을 UTC instant(ISO)로.
 * 라이브(telemetry_sessions) 윈도우의 시작 경계를 롤업의 `day_kst >= kstDate(days-1)` 와
 * 정확히 일치시키기 위함(둘 다 같은 kstDate 에서 파생 → 재드리프트 방지). KST 는 DST 없음.
 */
function kstDayStartIso(offsetDays = 0): string {
  return new Date(`${kstDate(offsetDays)}T00:00:00+09:00`).toISOString();
}

async function rollupRows(dimType: string, days: number) {
  const admin = createAdminClient();
  const cutoff = kstDate(days - 1);
  const { data, error } = await admin
    .from("telemetry_rollups")
    .select("dim_key,sessions,hits,score,attempts,switches")
    .eq("dim_type", dimType)
    .gte("day_kst", cutoff);
  if (error) {
    log.warn("analytics.rollup_fail", { dimType, ...errInfo(error) });
    return [];
  }
  return data ?? [];
}

/** dim_key 별 윈도우 합산 → hits 내림차순. */
async function dimBalance(dimType: string, days: number): Promise<DimStat[]> {
  const rows = await rollupRows(dimType, days);
  const agg = new Map<string, DimStat>();
  for (const r of rows) {
    const k = r.dim_key as string;
    const cur = agg.get(k) ?? { key: k, sessions: 0, hits: 0, score: 0, attempts: 0, switches: 0 };
    cur.sessions += Number(r.sessions) || 0;
    cur.hits += Number(r.hits) || 0;
    cur.score += Number(r.score) || 0;
    cur.attempts += Number(r.attempts) || 0;
    cur.switches += Number(r.switches) || 0;
    agg.set(k, cur);
  }
  return [...agg.values()].sort((a, b) => b.hits - a.hits);
}

export function getWeaponBalance(days: number): Promise<DimStat[]> {
  return dimBalance("weapon", days);
}
export function getMapBalance(days: number): Promise<DimStat[]> {
  return dimBalance("map", days);
}

/** 펀널 단계 윈도우 합산. */
export async function getFunnel(days: number): Promise<Funnel> {
  const rows = await rollupRows("funnel_step", days);
  const out: Funnel = {};
  for (const r of rows) out[r.dim_key as string] = (out[r.dim_key as string] ?? 0) + (Number(r.sessions) || 0);
  return out;
}

/** 회원 활동(코호트·재방문 — 익명 ephemeral 이라 회원 owner_id 한정). */
export async function getMemberActivity(days: number): Promise<{ sessions: number; members: number; returning: number }> {
  const admin = createAdminClient();
  const cutoffIso = kstDayStartIso(days - 1); // 롤업 day_kst 경계와 정합(KST 자정 기준)
  const { data, error } = await admin
    .from("telemetry_sessions")
    .select("owner_id")
    .not("owner_id", "is", null)
    .gte("started_at", cutoffIso)
    .limit(5000);
  if (error || !data) {
    if (error) log.warn("analytics.member_activity_fail", errInfo(error));
    return { sessions: 0, members: 0, returning: 0 };
  }
  const counts = new Map<string, number>();
  for (const r of data) counts.set(r.owner_id as string, (counts.get(r.owner_id as string) ?? 0) + 1);
  const returning = [...counts.values()].filter((n) => n >= 2).length;
  return { sessions: data.length, members: counts.size, returning };
}

/** 최근 세션 목록(인스펙터 진입). */
export async function getRecentSessions(limit = 50): Promise<SessionRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("telemetry_sessions")
    .select("id,started_at,is_anon,owner_id,end_reason,duration_ms,score,hit_count,distinct_weapons,distinct_maps,device_class")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) {
    log.warn("analytics.recent_fail", errInfo(error));
    return [];
  }
  return (data ?? []) as SessionRow[];
}

/** 세션 상세(타임라인 재생). 없으면 null(pruned/미존재). */
export async function getSessionDetail(id: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("telemetry_sessions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    log.warn("analytics.detail_fail", { id, ...errInfo(error) });
    return null;
  }
  return data;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 세션 단위 분석(편중/효율/맵고착) — telemetry_rollups 가 아니라 telemetry_sessions
 * 를 윈도우 직접 조회(getMemberActivity 와 동일 패턴). 세션 단위 facts(단일무기율·메인무기·
 * score/sec)는 per-dim 롤업 모양에 안 맞아 여기서 JS 집계. 익명+회원 공통(summary 는 둘 다 저장).
 * 표본/truncation 메타를 항상 동봉해 어드민이 "전체 통계 vs 표본"을 오해하지 않게 한다.
 * ────────────────────────────────────────────────────────────────────────── */

const SESSION_FETCH_LIMIT = 5000;
const TAP_KEYS = new Set<string>(WEAPONS.filter((w) => w.category === "tap").map((w) => w.key));
const KNOWN_WEAPONS = new Set<string>(WEAPON_KEYS);
const KNOWN_MAPS = new Set<string>(MAP_KEYS);
/** 메인무기 동률 시 3순위 tie-break — 고정 무기 순서 */
const WEAPON_ORDER: readonly string[] = WEAPON_KEYS;
const COMPLETED_END_REASONS = new Set(["normal", "time_limit", "score_limit"]);
/** throughput 유효 최소 플레이 시간(짧은 세션 점수/초 노이즈 제거) */
const MIN_VALID_DURATION_MS = 3000;

type DimSummary = Record<string, { hits?: number; score?: number; attempts?: number; switches?: number } | undefined>;
type SessionShapeRow = {
  id: string;
  end_reason: string | null;
  score: number | null;
  duration_ms: number | null;
  distinct_weapons: number | null;
  distinct_maps: number | null;
  weapon_summary: DimSummary | null;
  map_summary: DimSummary | null;
  start_map: string | null;
};

/** 표본/절단 메타 — 모든 세션단위 집계 반환에 공통 동봉 */
export type SampleMeta = { sampleSize: number; isTruncated: boolean; limit: number };

function emptyMeta(): SampleMeta {
  return { sampleSize: 0, isTruncated: false, limit: SESSION_FETCH_LIMIT };
}

/** 윈도우 내 세션 shape 조회 — 필요 컬럼만(timeline 제외), limit+1 로 절단 판정. */
async function fetchSessionsWindow(
  days: number
): Promise<{ rows: SessionShapeRow[]; meta: SampleMeta }> {
  const admin = createAdminClient();
  const cutoffIso = kstDayStartIso(days - 1); // 롤업 day_kst 경계와 정합(KST 자정 기준)
  const { data, error } = await admin
    .from("telemetry_sessions")
    .select(
      "id,end_reason,score,duration_ms,distinct_weapons,distinct_maps,weapon_summary,map_summary,start_map"
    )
    .gte("started_at", cutoffIso)
    .order("started_at", { ascending: false })
    .limit(SESSION_FETCH_LIMIT + 1); // +1 로 5000 초과 여부(절단) 판정
  if (error || !data) {
    if (error) log.warn("analytics.sessions_window_fail", errInfo(error));
    return { rows: [], meta: emptyMeta() };
  }
  const isTruncated = data.length > SESSION_FETCH_LIMIT;
  const rows = (isTruncated ? data.slice(0, SESSION_FETCH_LIMIT) : data) as SessionShapeRow[];
  return { rows, meta: { sampleSize: rows.length, isTruncated, limit: SESSION_FETCH_LIMIT } };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pushTo(map: Map<string, number[]>, key: string, val: number): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

/** summary 에서 hits>0 인 무기/맵 hit 맵 추출(숫자화). */
function hitsOf(sum: DimSummary | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (sum && typeof sum === "object") {
    for (const [k, v] of Object.entries(sum)) {
      const h = Number(v?.hits) || 0;
      if (h > 0) out[k] = h;
    }
  }
  return out;
}

/** distinct 무기수 — summary(hits>0 key) 우선, 없으면 컬럼 fallback. */
function distinctWeaponsOf(row: SessionShapeRow): number {
  const fromSummary = Object.keys(hitsOf(row.weapon_summary)).length;
  return fromSummary > 0 ? fromSummary : Math.max(0, Number(row.distinct_weapons) || 0);
}

/** 메인무기 — hits desc → score desc → 고정 WEAPON_ORDER. unknown key 는 그대로 반환(상위에서 묶음). */
function mainWeaponOf(sum: DimSummary | null): string | null {
  if (!sum || typeof sum !== "object") return null;
  let best: string | null = null;
  let bh = -1;
  let bs = -1;
  let bo = Number.POSITIVE_INFINITY;
  for (const [k, v] of Object.entries(sum)) {
    const h = Number(v?.hits) || 0;
    if (h <= 0) continue;
    const sc = Number(v?.score) || 0;
    const idx = WEAPON_ORDER.indexOf(k);
    const o = idx < 0 ? Number.POSITIVE_INFINITY : idx;
    if (h > bh || (h === bh && (sc > bs || (sc === bs && o < bo)))) {
      best = k;
      bh = h;
      bs = sc;
      bo = o;
    }
  }
  return best;
}

/** unknown 무기 key 는 'unknown' 으로 묶음(throw 금지). */
function weaponLabel(k: string): string {
  return KNOWN_WEAPONS.has(k) ? k : "unknown";
}

/** 단일 hit 분포의 Herfindahl(Σshare²). 빈 분포는 null. */
function herfindahl(hits: Record<string, number>): number | null {
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let h = 0;
  for (const v of Object.values(hits)) {
    const sh = v / total;
    h += sh * sh;
  }
  return h;
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

export async function getWeaponConcentration(days: number): Promise<WeaponConcentration> {
  const { rows, meta } = await fetchSessionsWindow(days);
  let weaponSessions = 0;
  let singleWeapon = 0;
  let distinctSum = 0;
  const mainWeaponDist: Record<string, number> = {};
  const aggHits: Record<string, number> = {};
  const sessionHHIs: number[] = [];
  let tapHits = 0;
  let knownHits = 0;
  let allHits = 0;

  for (const row of rows) {
    const hits = hitsOf(row.weapon_summary);
    const dw = distinctWeaponsOf(row);
    if (dw < 1) continue; // 타격 무기 없는 세션 제외
    weaponSessions += 1;
    distinctSum += dw;
    if (dw === 1) singleWeapon += 1;
    const main = mainWeaponOf(row.weapon_summary);
    if (main) mainWeaponDist[weaponLabel(main)] = (mainWeaponDist[weaponLabel(main)] ?? 0) + 1;
    const hhi = herfindahl(hits);
    if (hhi !== null) sessionHHIs.push(hhi);
    for (const [k, h] of Object.entries(hits)) {
      allHits += h;
      aggHits[weaponLabel(k)] = (aggHits[weaponLabel(k)] ?? 0) + h;
      if (KNOWN_WEAPONS.has(k)) {
        knownHits += h;
        if (TAP_KEYS.has(k)) tapHits += h;
      }
    }
  }

  // aggregateHitConcentration 은 known 무기 분포 기준(unknown 묶음 제외해 무기 간 비교 일관)
  const knownAgg: Record<string, number> = {};
  for (const [k, h] of Object.entries(aggHits)) if (k !== "unknown") knownAgg[k] = h;

  return {
    ...meta,
    weaponSessions,
    singleWeaponPct: weaponSessions > 0 ? singleWeapon / weaponSessions : 0,
    avgDistinctWeapons: weaponSessions > 0 ? distinctSum / weaponSessions : 0,
    mainWeaponDist,
    tapCategoryShare: knownHits > 0 ? tapHits / knownHits : 0,
    knownHitCoverage: allHits > 0 ? knownHits / allHits : 1,
    avgSessionConcentration:
      sessionHHIs.length > 0 ? sessionHHIs.reduce((a, b) => a + b, 0) / sessionHHIs.length : null,
    aggregateHitConcentration: herfindahl(knownAgg),
  };
}

export type WeaponThroughputRow = {
  weapon: string;
  allN: number;
  pureN: number;
  /** 메인무기 기준 점수/초 중앙값(근사) */
  medianAll: number | null;
  /** 단일무기(pure) 세션 점수/초 중앙값 */
  medianPure: number | null;
};
export type WeaponThroughput = SampleMeta & {
  totalSessions: number;
  /** throughput 계산에 쓰인 세션(완료·유효 duration) */
  eligibleSessions: number;
  excludedSessions: number;
  rows: WeaponThroughputRow[];
};

export async function getWeaponThroughput(days: number): Promise<WeaponThroughput> {
  const { rows, meta } = await fetchSessionsWindow(days);
  const all = new Map<string, number[]>();
  const pure = new Map<string, number[]>();
  let eligible = 0;

  for (const row of rows) {
    const reason = row.end_reason ?? "";
    const dur = Number(row.duration_ms) || 0;
    const score = Number(row.score) || 0;
    // 완료 세션 + 유효 duration 만 — 부분세션(abandon/reload/hidden_timeout)·초단기 제외
    if (!COMPLETED_END_REASONS.has(reason) || dur <= MIN_VALID_DURATION_MS) continue;
    const main = mainWeaponOf(row.weapon_summary);
    if (!main) continue;
    eligible += 1;
    const key = weaponLabel(main);
    const sps = score / (dur / 1000);
    pushTo(all, key, sps);
    if (distinctWeaponsOf(row) === 1) pushTo(pure, key, sps);
  }

  const keys = new Set<string>([...all.keys(), ...pure.keys()]);
  const out: WeaponThroughputRow[] = [];
  for (const k of keys) {
    const a = all.get(k) ?? [];
    const p = pure.get(k) ?? [];
    out.push({ weapon: k, allN: a.length, pureN: p.length, medianAll: median(a), medianPure: median(p) });
  }
  out.sort((x, y) => (y.medianPure ?? y.medianAll ?? 0) - (x.medianPure ?? x.medianAll ?? 0));

  return {
    ...meta,
    totalSessions: rows.length,
    eligibleSessions: eligible,
    excludedSessions: rows.length - eligible,
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

export async function getMapStickiness(days: number): Promise<MapStickiness> {
  const { rows, meta } = await fetchSessionsWindow(days);
  let valid = 0;
  let singleMap = 0;
  let distinctSum = 0;
  let switchSum = 0;
  const startMapDist: Record<string, number> = {};

  for (const row of rows) {
    if (!row.start_map) continue; // 맵 데이터 없는 세션 제외
    valid += 1;
    const dm = Math.max(0, Number(row.distinct_maps) || 0);
    distinctSum += dm;
    if (dm === 1) singleMap += 1;
    const startKey = KNOWN_MAPS.has(row.start_map) ? row.start_map : "unknown";
    startMapDist[startKey] = (startMapDist[startKey] ?? 0) + 1;
    const ms = row.map_summary;
    if (ms && typeof ms === "object") {
      for (const v of Object.values(ms)) switchSum += Number(v?.switches) || 0;
    }
  }

  return {
    ...meta,
    validMapSessions: valid,
    singleMapPct: valid > 0 ? singleMap / valid : 0,
    avgDistinctMaps: valid > 0 ? distinctSum / valid : 0,
    mapSwitchRate: valid > 0 ? switchSum / valid : 0,
    startMapDist,
  };
}

// ── 디바이스 렌더 퍼포먼스(렉 진단) — telemetry_sessions perf 컬럼(mig 0033) 직접 조회 ──
//   avg_frame_ms>0(실프레임 표본 있는 세션)만 — 무플레이/배포前 0 디폴트는 제외.
const PERF_LAG_P95_MS = 33; // p95 프레임타임 33ms ≈ 30fps 미달 스파이크 = "렉 세션"

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
};

export async function getDevicePerf(days: number): Promise<DevicePerf> {
  const admin = createAdminClient();
  const start = kstDayStartIso(days - 1);
  const { data, error } = await admin
    .from("telemetry_sessions")
    .select("id, device_class, dpr, refresh_hz, avg_frame_ms, p95_frame_ms, duration_ms")
    .gte("started_at", start)
    .gt("avg_frame_ms", 0) // 실프레임 표본 세션만(무플레이/배포前 0 제외)
    .order("p95_frame_ms", { ascending: false })
    .limit(5000);
  if (error) {
    log.warn("analytics.device_perf_fail", errInfo(error));
    return { byDevice: [], worst: [], perfSessions: 0 };
  }
  const rows = (data ?? []) as {
    id: string;
    device_class: string;
    dpr: number | null;
    refresh_hz: number | null;
    avg_frame_ms: number;
    p95_frame_ms: number;
    duration_ms: number | null;
  }[];

  const byClass = new Map<string, { avgs: number[]; p95s: number[]; lag: number }>();
  for (const r of rows) {
    const g = byClass.get(r.device_class) ?? { avgs: [], p95s: [], lag: 0 };
    g.avgs.push(r.avg_frame_ms);
    g.p95s.push(r.p95_frame_ms);
    if (r.p95_frame_ms > PERF_LAG_P95_MS) g.lag += 1;
    byClass.set(r.device_class, g);
  }
  const byDevice: DevicePerfStat[] = [...byClass.entries()]
    .map(([deviceClass, g]) => {
      const medAvg = median(g.avgs) ?? 0;
      return {
        deviceClass,
        sessions: g.avgs.length,
        medAvgMs: Math.round(medAvg * 10) / 10,
        medP95Ms: Math.round((median(g.p95s) ?? 0) * 10) / 10,
        estFps: medAvg > 0 ? Math.round(1000 / medAvg) : 0,
        lagRate: g.avgs.length ? g.lag / g.avgs.length : 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  // 가장 느린 세션 top-5 (쿼리에서 p95 desc 정렬됨)
  const worst: WorstPerfSession[] = rows.slice(0, 5).map((r) => ({
    id: r.id,
    deviceClass: r.device_class,
    dpr: Number(r.dpr) || 0,
    refreshHz: Number(r.refresh_hz) || 0,
    avgMs: Math.round(r.avg_frame_ms * 10) / 10,
    p95Ms: Math.round(r.p95_frame_ms * 10) / 10,
    durationMs: r.duration_ms,
  }));

  return { byDevice, worst, perfSessions: rows.length };
}
