import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import { uploadFaceTmp, deleteFaceTmp } from "@/lib/character-gen/upload-face";
import { checkFalBalance } from "@/lib/fal-balance";

const MAX_BYTES = 10 * 1024 * 1024;
/** 기본 일일 생성 한도 — profiles.daily_gen_limit 조회 실패 시 fallback */
const DEFAULT_DAILY_LIMIT = 2;

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby max

/** 오늘 KST 자정 (UTC ISO) — 일일 한도 리셋 기준 */
function kstMidnightUtcIso(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  kst.setUTCHours(0, 0, 0, 0);
  return new Date(kst.getTime() - 9 * 3600_000).toISOString();
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── fal 잔액 hard cap — $2 미만이면 전 계정 생성 일시 중단 ─────────
  const balance = await checkFalBalance();
  if (!balance.ok) {
    return NextResponse.json({ error: "service_paused" }, { status: 503 });
  }

  // ── 일일 생성 한도 (KST 자정 리셋). daily_gen_limit null = 무제한 ──
  const adminForQuota = createAdminClient();
  let limit: number | null = DEFAULT_DAILY_LIMIT;
  const { data: profileRow, error: profileErr } = await adminForQuota
    .from("profiles")
    .select("daily_gen_limit")
    .eq("id", user.id)
    .single();
  if (!profileErr && profileRow && "daily_gen_limit" in profileRow) {
    limit = profileRow.daily_gen_limit as number | null;
  }
  // migration 0004 미적용 (컬럼 없음) 등 조회 실패 → 기본 한도 유지
  if (limit !== null) {
    const { count, error: countErr } = await adminForQuota
      .from("ai_generations")
      .select("*", { head: true, count: "exact" })
      .eq("owner_id", user.id)
      .neq("status", "failed") // 실패한 생성은 차감 안 함
      .gte("created_at", kstMidnightUtcIso());
    if (!countErr && (count ?? 0) >= limit) {
      return NextResponse.json(
        { error: "daily_limit", limit, used: count ?? 0 },
        { status: 429 }
      );
    }
  }

  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "image_required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", maxMB: 10 },
      { status: 400 }
    );
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "not_an_image" }, { status: 400 });
  }

  const provider = selectProvider(null);

  // 입력 정규화 (1024×1024 cover) — 원본은 메모리 안에서만
  const rawBuf = await file.arrayBuffer();
  let prepared: Buffer;
  try {
    prepared = await prepareInputImage(rawBuf);
  } catch (e) {
    console.error("[fal] input prep failed:", e);
    return NextResponse.json({ error: "input_prep_failed" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: genRow, error: logError } = await admin
    .from("ai_generations")
    .insert({ owner_id: user.id, status: "queued" })
    .select("id")
    .single();
  if (logError || !genRow) {
    return NextResponse.json({ error: "log_failed" }, { status: 500 });
  }

  // face 임시 업로드 → signed URL → fal → 결과 → 임시 삭제 (정책: 원본 폐기)
  let facePath: string | null = null;
  try {
    const uploaded = await uploadFaceTmp(user.id, prepared);
    facePath = uploaded.path;

    const result = await provider.generate({
      faceImageUrl: uploaded.url,
      // PuLID 는 template 무시 — 호환성 위해 빈 문자열 전달
      templateImageUrl: "",
      numImages: 3,
    });

    await admin
      .from("ai_generations")
      .update({
        status: "done",
        cost_cents: result.costCents,
        fal_request_id: `${result.provider}:${genRow.id}`,
      })
      .eq("id", genRow.id);

    return NextResponse.json({
      images: result.images,
      generationId: genRow.id,
      provider: result.provider,
      durationMs: result.durationMs,
    });
  } catch (e) {
    await admin
      .from("ai_generations")
      .update({ status: "failed" })
      .eq("id", genRow.id);
    console.error("[fal] generation failed:", e);
    if (e && typeof e === "object") {
      const anyErr = e as Record<string, unknown>;
      console.error("[fal] error.body:", JSON.stringify(anyErr.body));
      console.error("[fal] error.status:", anyErr.status);
    }
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json(
      { error: "generation_failed", detail: msg },
      { status: 500 }
    );
  } finally {
    if (facePath) {
      deleteFaceTmp(facePath).catch((e) =>
        console.warn("[fal] face tmp cleanup failed:", e)
      );
    }
  }
}
