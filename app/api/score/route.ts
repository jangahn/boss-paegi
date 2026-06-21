import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MAX_DURATION_MS,
  scoreCeiling,
} from "@/lib/score-limits";
import {
  buildGameplayStats,
  validateGameplayStats,
  type GameplayStats,
} from "@/lib/stats";
import { matchPersona } from "@/lib/persona";
import { evaluateBadges } from "@/lib/badges";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    score?: number;
    weapon?: string;
    durationMs?: number;
    dollId?: string | null;
    maxCombo?: number;
    /** 플레이 해석 리포트용 상세 스탯 (bgVisits 포함). 검증·저장은 best-effort. */
    gameplayStats?: GameplayStats;
  } | null;

  if (
    typeof body?.score !== "number" ||
    typeof body?.weapon !== "string" ||
    typeof body?.durationMs !== "number"
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (body.durationMs <= 0 || body.durationMs > MAX_DURATION_MS) {
    return NextResponse.json({ error: "invalid_duration" }, { status: 400 });
  }
  // 평균 점수/sec 가 합리적 cap 이하면 OK. 명백히 비현실적인 케이스만 거부.
  // (클라이언트가 같은 공식으로 제출 전 클램프 — 정상 플레이는 여기 안 걸림)
  const ceiling = scoreCeiling(body.durationMs);
  if (body.score < 0 || body.score > ceiling) {
    // 클라가 클램프하므로 여기 걸리면 비정상(치팅 의심 또는 클램프 버그) — 추적
    log.warn("score.out_of_range", {
      userId: user.id,
      score: body.score,
      ceiling,
      durationMs: body.durationMs,
      weapon: body.weapon,
    });
    return NextResponse.json(
      { error: "score_out_of_range", ceiling },
      { status: 400 }
    );
  }
  if (body.weapon.length > 20) {
    return NextResponse.json({ error: "invalid_weapon" }, { status: 400 });
  }

  const maxCombo =
    typeof body.maxCombo === "number"
      ? Math.min(Math.max(0, Math.round(body.maxCombo)), 99999)
      : 0;

  const baseRow = {
    owner_id: user.id,
    doll_id: body.dollId ?? null,
    score: body.score,
    weapon: body.weapon,
    duration_ms: Math.round(body.durationMs),
  };

  let { data, error } = await supabase
    .from("scores")
    .insert({ ...baseRow, max_combo: maxCombo })
    .select("id")
    .single();

  // migration 0003 (max_combo 컬럼) 미적용 환경 fallback — 점수 저장은 항상 성공해야
  if (error && error.message.includes("max_combo")) {
    log.warn("score.maxcombo_col_missing", { userId: user.id });
    ({ data, error } = await supabase
      .from("scores")
      .insert(baseRow)
      .select("id")
      .single());
  }

  if (error || !data) {
    log.error("score.insert_fail", {
      userId: user.id,
      score: body.score,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "insert_failed", detail: error?.message },
      { status: 500 }
    );
  }

  log.info("score.save_success", {
    userId: user.id,
    scoreId: data.id,
    score: body.score,
    maxCombo,
    weapon: body.weapon,
    durationMs: Math.round(body.durationMs),
    hasDoll: !!body.dollId,
  });

  // ── 부가 리포트(스탯·페르소나·뱃지·백분위) — best-effort. 점수 저장과 완전 분리. ──
  let personaId: string | null = null;
  let percentile: number | null = null;
  let newBadges: string[] = [];
  let collectedCount = 0;
  const raw = body.gameplayStats;
  if (raw && typeof raw === "object" && typeof raw.hitCount === "number") {
    try {
      // 클라 신뢰 최소화 — weaponCounts 로 categoryCounts 재파생, durationMs 는 서버 제출값.
      const canonical = buildGameplayStats({
        hitCount: raw.hitCount,
        maxCombo,
        durationMs: body.durationMs,
        weaponCounts: raw.weaponCounts ?? {},
        weaponScores: raw.weaponScores ?? {},
        ultScore: Math.min(Math.max(0, raw.ultScore ?? 0), body.score),
        ultimateCount: raw.ultimateCount ?? 0,
        firstHitMs: typeof raw.firstHitMs === "number" ? raw.firstHitMs : null,
        bgVisits: Array.isArray(raw.bgVisits) ? raw.bgVisits.slice(0, 12) : [],
      });
      if (validateGameplayStats(canonical, body.score)) {
        personaId = matchPersona(canonical).id;
        const earned = evaluateBadges(canonical, body.score);
        const admin = createAdminClient();

        // 백분위 (전체 플레이 기준) — best-effort
        try {
          const { data: pct } = await admin.rpc("get_score_percentile", {
            p_score: body.score,
          });
          if (typeof pct === "number") percentile = pct;
        } catch (e) {
          log.warn("percentile.error", { scoreId: data.id, ...errInfo(e) });
        }

        // score_stats — 스탯 + 페르소나 + 이번 판 뱃지 + 백분위 스냅샷
        const { error: statsErr } = await admin.from("score_stats").insert({
          score_id: data.id,
          gameplay_stats: canonical,
          persona_id: personaId,
          badge_ids: earned,
          percentile,
        });
        if (statsErr)
          log.warn("score_stats.insert_fail", {
            scoreId: data.id,
            ...errInfo(statsErr),
          });

        // user_badges 누적 — 신규만 insert(ignoreDuplicates → 반환=새로 획득분)
        if (earned.length) {
          const { data: ins, error: bErr } = await admin
            .from("user_badges")
            .upsert(
              earned.map((badge_id) => ({
                owner_id: user.id,
                badge_id,
                first_score_id: data.id,
              })),
              { onConflict: "owner_id,badge_id", ignoreDuplicates: true }
            )
            .select("badge_id");
          if (bErr)
            log.warn("user_badges.insert_fail", {
              scoreId: data.id,
              ...errInfo(bErr),
            });
          else newBadges = (ins ?? []).map((r) => r.badge_id as string);
        }

        // 수집 카운트 (종료화면 N/M 표시)
        const { count } = await admin
          .from("user_badges")
          .select("badge_id", { count: "exact", head: true })
          .eq("owner_id", user.id);
        collectedCount = count ?? 0;
      } else {
        log.warn("score_stats.validation_fail", {
          scoreId: data.id,
          score: body.score,
        });
      }
    } catch (e) {
      log.warn("score_stats.error", { scoreId: data.id, ...errInfo(e) });
    }
  }

  return NextResponse.json({
    scoreId: data.id,
    personaId,
    percentile,
    newBadges,
    collectedCount,
  });
}
