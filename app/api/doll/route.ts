import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeBackground } from "@/lib/fal";

const BUCKET = "dolls";

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
    imageUrl?: string;
    styleMeta?: Record<string, unknown>;
  } | null;
  if (!body?.imageUrl) {
    return NextResponse.json({ error: "imageUrl_required" }, { status: 400 });
  }

  // fal CDN URL 만 허용 (SSRF 방지)
  try {
    const u = new URL(body.imageUrl);
    if (!u.hostname.endsWith(".fal.media") && !u.hostname.endsWith("fal.media")) {
      return NextResponse.json({ error: "untrusted_url" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  // 누끼 제거 (PNG 투명 배경) — 게임 씬에서 캐릭터만 떠 있게.
  let cleanedUrl: string;
  try {
    cleanedUrl = await removeBackground(body.imageUrl);
  } catch (e) {
    console.error("[doll] bg removal failed:", e);
    return NextResponse.json({ error: "bg_removal_failed" }, { status: 502 });
  }

  // bg-removal 출력도 fal.media 호스트 — 기존 SSRF 가드 효력 그대로
  const src = await fetch(cleanedUrl);
  if (!src.ok) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
  const blob = await src.arrayBuffer();
  const contentType = src.headers.get("content-type") || "image/png";
  const ext = contentType.split("/")[1]?.split(";")[0] || "png";

  const dollId = crypto.randomUUID();
  const path = `${user.id}/${dollId}.${ext}`;

  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, blob, { contentType, upsert: false });
  if (uploadError) {
    return NextResponse.json(
      { error: "upload_failed", detail: uploadError.message },
      { status: 500 }
    );
  }

  const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const { data: doll, error: insertError } = await admin
    .from("dolls")
    .insert({
      id: dollId,
      owner_id: user.id,
      image_url: publicUrl,
      style_meta: body.styleMeta ?? {},
    })
    .select()
    .single();
  if (insertError) {
    return NextResponse.json(
      { error: "insert_failed", detail: insertError.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ doll });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data } = await supabase
    .from("dolls")
    .select("id, image_url, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ dolls: data ?? [] });
}
