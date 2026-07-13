import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { kstDate } from "@/lib/admin-analytics";
import { log, errInfo } from "@/lib/log";

/**
 * 공유·유입 분석 — analytics_rollups(격리 도메인) 윈도우 합산. 무식별 집계.
 * 게임플레이 분석(lib/admin-analytics, telemetry_rollups)과 도메인·성격이 달라 별도 파일로 분리.
 * KST 윈도우 헬퍼(kstDate)만 admin-analytics 에서 재사용(범용 날짜 유틸).
 * metric별 dim 의미는 0049_analytics.sql 주석과 일치(visit_by_source: d1=scope,d2=kind,d3=value 등).
 */

type AnalyticsRollupRow = { metric: string; dim1: string; dim2: string; dim3: string; dim4: string; value: number };

async function analyticsRollupRows(metrics: string[], days: number): Promise<AnalyticsRollupRow[]> {
  const admin = createAdminClient();
  const cutoff = kstDate(days - 1);
  const { data, error } = await admin
    .from("analytics_rollups")
    .select("metric,dim1,dim2,dim3,dim4,value")
    .in("metric", metrics)
    .gte("day_kst", cutoff);
  if (error) {
    log.warn("analytics.rollup_read_fail", errInfo(error));
    return [];
  }
  return (data ?? []) as AnalyticsRollupRow[];
}

const num = (v: unknown) => Number(v) || 0;

export type KeyVal = { key: string; value: number };
export type ShareStats = {
  funnel: { scoreSubmit: number; gameOverShare: number; rate: number | null }; // 게임오버 전환(무식별 근사)
  bySurface: KeyVal[];
  byTarget: KeyVal[];
  byScoreTier: { tier: number; value: number }[];
  byMemberState: KeyVal[];
};

/** 공유 분석 — 게임오버 전환 퍼널 + 표면/대상/점수대/회원여부 분포. */
export async function getShareStats(days: number): Promise<ShareStats> {
  const rows = await analyticsRollupRows(
    ["score_submit", "share_game_over", "share_by_surface", "share_by_target", "share_by_score_tier", "share_by_member_state"],
    days
  );
  const sumOf = (m: string) => rows.reduce((s, r) => (r.metric === m ? s + num(r.value) : s), 0);
  const byDim1 = (m: string): KeyVal[] => {
    const agg = new Map<string, number>();
    for (const r of rows) if (r.metric === m) agg.set(r.dim1, (agg.get(r.dim1) ?? 0) + num(r.value));
    return [...agg.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  };
  const scoreSubmit = sumOf("score_submit");
  const gameOverShare = sumOf("share_game_over");
  return {
    funnel: { scoreSubmit, gameOverShare, rate: scoreSubmit > 0 ? gameOverShare / scoreSubmit : null },
    bySurface: byDim1("share_by_surface"),
    byTarget: byDim1("share_by_target"),
    byScoreTier: byDim1("share_by_score_tier")
      .map((d) => ({ tier: Number(d.key), value: d.value }))
      .filter((d) => Number.isFinite(d.tier))
      .sort((a, b) => a.tier - b.tier),
    byMemberState: byDim1("share_by_member_state"),
  };
}

export type SourceConv = { sourceKind: string; sourceValue: string; visits: number; play: number; signup: number };
export type AcquisitionStats = {
  currentBySource: { sourceKind: string; sourceValue: string; visits: number }[]; // 방문 유입 현황(current)
  currentByKind: KeyVal[]; // source_kind 그룹 합계
  conversion: SourceConv[]; // first-touch 기준 방문→플레이→가입(무식별 근사)
  viralLoop: { shares: number; viralInbound: number; byType: KeyVal[] };
};

/** top N + 나머지 '기타' 1행(value 합산). getVal 로 합산 필드 지정. */
function topNWithRest<T>(rows: T[], n: number, getVal: (r: T) => number, makeRest: (sum: number) => T): T[] {
  if (rows.length <= n) return rows;
  const head = rows.slice(0, n);
  const restSum = rows.slice(n).reduce((s, r) => s + getVal(r), 0);
  return restSum > 0 ? [...head, makeRest(restSum)] : head;
}

/** 유입 분석 — 방문 현황(current) + source별 전환(first-touch) + 바이럴 루프. */
export async function getAcquisitionStats(days: number): Promise<AcquisitionStats> {
  const rows = await analyticsRollupRows(
    ["visit_by_source", "conversion_play_by_source", "conversion_signup_by_source", "viral_inbound_by_type", "share_by_surface"],
    days
  );

  // 방문 유입 현황(current): visit_by_source(dim1=scope) 중 current, (dim2=kind, dim3=value) 합산.
  const curMap = new Map<string, { sourceKind: string; sourceValue: string; visits: number }>();
  const curKind = new Map<string, number>();
  // 전환 분모: first-touch 방문 (dim2=kind, dim3=value)
  const ftVisit = new Map<string, number>();
  for (const r of rows) {
    if (r.metric !== "visit_by_source") continue;
    const k = `${r.dim2} ${r.dim3}`;
    if (r.dim1 === "current") {
      const cur = curMap.get(k) ?? { sourceKind: r.dim2, sourceValue: r.dim3, visits: 0 };
      cur.visits += num(r.value);
      curMap.set(k, cur);
      curKind.set(r.dim2, (curKind.get(r.dim2) ?? 0) + num(r.value));
    } else if (r.dim1 === "first_touch") {
      ftVisit.set(k, (ftVisit.get(k) ?? 0) + num(r.value));
    }
  }

  // 전환 분자: conversion_*_by_source(dim1=kind, dim2=value)
  const play = new Map<string, number>();
  const signup = new Map<string, number>();
  for (const r of rows) {
    if (r.metric === "conversion_play_by_source") play.set(`${r.dim1} ${r.dim2}`, (play.get(`${r.dim1} ${r.dim2}`) ?? 0) + num(r.value));
    else if (r.metric === "conversion_signup_by_source") signup.set(`${r.dim1} ${r.dim2}`, (signup.get(`${r.dim1} ${r.dim2}`) ?? 0) + num(r.value));
  }

  // 전환 테이블: first-touch 방문 ∪ 전환이 있는 source 모두 포함
  const convKeys = new Set<string>([...ftVisit.keys(), ...play.keys(), ...signup.keys()]);
  const conversion: SourceConv[] = [...convKeys]
    .map((k) => {
      const [sourceKind, sourceValue] = k.split(" ");
      return { sourceKind, sourceValue, visits: ftVisit.get(k) ?? 0, play: play.get(k) ?? 0, signup: signup.get(k) ?? 0 };
    })
    .sort((a, b) => b.visits - a.visits || b.play - a.play);

  const currentBySource = topNWithRest(
    [...curMap.values()].sort((a, b) => b.visits - a.visits),
    15,
    (r) => r.visits,
    (sum) => ({ sourceKind: "기타", sourceValue: "", visits: sum })
  );
  const currentByKind: KeyVal[] = [...curKind.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);

  const shares = rows.reduce((s, r) => (r.metric === "share_by_surface" ? s + num(r.value) : s), 0);
  // 롤업은 (day_kst, metric, dim1) 단위 행이라 dim1 로 합산해야 한다 — 일별 행을 그대로 쌓으면
  // 멀티데이 윈도우에서 같은 유형 라벨이 값 쪼개진 채 반복 표시됨(타 metric 의 byDim1 과 동일 패턴).
  const viralAgg = new Map<string, number>();
  let viralInbound = 0;
  for (const r of rows)
    if (r.metric === "viral_inbound_by_type") {
      viralAgg.set(r.dim1, (viralAgg.get(r.dim1) ?? 0) + num(r.value));
      viralInbound += num(r.value);
    }
  const viralByType: KeyVal[] = [...viralAgg.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);

  return { currentBySource, currentByKind, conversion, viralLoop: { shares, viralInbound, byType: viralByType } };
}
