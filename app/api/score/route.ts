import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// 점수/sec 평균 cap. 콤보 multiplier (1 + floor(combo/5) × 0.5) 가 무한 가능
// 하다 보니 high-combo 정상 게임도 비현실적으로 큰 점수 나옴.
// 콤보 30 ≈ multiplier 4 + max strength 18 (keyboard) + 초당 10탭 가정 → ~720/sec.
// 안전 마진 둬서 1000/sec.
const MAX_AVG_SCORE_PER_SEC = 1000;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10분
const MAX_SCORE_HARD = 10_000_000; // schema check (DB) 와 동일

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
  const ceiling = Math.min(
    Math.ceil((body.durationMs / 1000) * MAX_AVG_SCORE_PER_SEC),
    MAX_SCORE_HARD
  );
  if (body.score < 0 || body.score > ceiling) {
    return NextResponse.json(
      { error: "score_out_of_range", ceiling },
      { status: 400 }
    );
  }
  if (body.weapon.length > 20) {
    return NextResponse.json({ error: "invalid_weapon" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("scores")
    .insert({
      owner_id: user.id,
      doll_id: body.dollId ?? null,
      score: body.score,
      weapon: body.weapon,
      duration_ms: Math.round(body.durationMs),
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "insert_failed", detail: error?.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ scoreId: data.id });
}
