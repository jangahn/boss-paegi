import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_DURATION_MS,
  scoreCeiling,
} from "@/lib/score-limits";
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
  return NextResponse.json({ scoreId: data.id });
}
