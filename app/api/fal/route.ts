import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateBossDoll } from "@/lib/fal";

const MAX_DAILY_FREE = 3;
const MAX_BYTES = 10 * 1024 * 1024;

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  const admin = createAdminClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("ai_generations")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", user.id)
    .eq("status", "done")
    .gte("created_at", since);

  if ((count ?? 0) >= MAX_DAILY_FREE) {
    return NextResponse.json(
      { error: "daily_limit", limit: MAX_DAILY_FREE, used: count },
      { status: 429 }
    );
  }

  // 원본은 메모리 안에서만 data URI 로 변환 후 fal 에 전달, 어디에도 영구 저장 X.
  const buf = await file.arrayBuffer();
  const dataUri = `data:${file.type};base64,${Buffer.from(buf).toString("base64")}`;

  const { data: genRow, error: insertError } = await admin
    .from("ai_generations")
    .insert({ owner_id: user.id, status: "queued" })
    .select("id")
    .single();
  if (insertError || !genRow) {
    return NextResponse.json({ error: "log_failed" }, { status: 500 });
  }

  try {
    const images = await generateBossDoll({ imageDataUri: dataUri, numImages: 3 });
    await admin
      .from("ai_generations")
      .update({ status: "done", cost_cents: 8 })
      .eq("id", genRow.id);

    return NextResponse.json({ images, generationId: genRow.id });
  } catch (e) {
    await admin
      .from("ai_generations")
      .update({ status: "failed" })
      .eq("id", genRow.id);
    // fal 클라이언트는 body/status 를 갖는 ApiError 를 던질 수 있어서 다 dump
    console.error("[fal] generation failed full error:", e);
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
  }
}
