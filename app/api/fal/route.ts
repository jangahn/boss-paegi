import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import { resolveTemplate } from "@/lib/character-gen/templates";
import { uploadFaceTmp, deleteFaceTmp } from "@/lib/character-gen/upload-face";

const MAX_BYTES = 10 * 1024 * 1024;
// TODO: 테스트 충분히 진행된 후 rate limit 다시 적용 (ai_generations status='done' 카운트 활용).

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby max

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

  // 옵션 — query 또는 form 에서 template/provider 선택
  const url = new URL(req.url);
  const templateKey = url.searchParams.get("template") ?? form.get("template");
  const providerKey = url.searchParams.get("provider") ?? form.get("provider");

  const template = resolveTemplate(
    typeof templateKey === "string" ? templateKey : null
  );
  const provider = selectProvider(
    typeof providerKey === "string" ? providerKey : null
  );

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
      templateImageUrl: template.url,
      numImages: 3,
      promptHints: template.styleHint,
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
      template: template.key,
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
