import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateBossDoll } from "@/lib/fal";
import { prepareInputImage } from "@/lib/image-utils";

// TODO: 테스트 충분히 진행된 후 사용자 요청 시 일일 무료 한도 다시 적용.
// const MAX_DAILY_FREE = 3;
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
  // 테스트 단계 — rate limit 제거. 사용자 재요청 시 위 MAX_DAILY_FREE 활용해 다시 적용.
  // (ai_generations 테이블에 status='done' 카운트는 여전히 로깅 → 추후 한도 적용용 데이터 누적.)

  // 원본을 1024×1024 정사각형으로 cover-crop → fal 출력도 동일 사이즈 (img2img 는
  // 입력 비율 따라가는 특성). attention 전략으로 얼굴 자동 가운데 정렬.
  // 메모리에서만 처리, 영구 저장 X.
  const rawBuf = await file.arrayBuffer();
  let prepared: Buffer;
  try {
    prepared = await prepareInputImage(rawBuf);
  } catch (e) {
    console.error("[fal] input prep failed:", e);
    return NextResponse.json({ error: "input_prep_failed" }, { status: 400 });
  }
  const dataUri = `data:image/jpeg;base64,${prepared.toString("base64")}`;

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
