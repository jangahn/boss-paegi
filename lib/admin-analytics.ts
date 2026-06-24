import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
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

/** KST 기준 offsetDays 일 전 날짜 문자열(YYYY-MM-DD). */
function kstDate(offsetDays = 0): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - offsetDays);
  return kst.toISOString().slice(0, 10);
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
  const cutoffIso = new Date(Date.now() - days * 86400 * 1000).toISOString();
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
