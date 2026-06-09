import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeBackground } from "@/lib/fal";
import { normalizeDollImage } from "@/lib/image-utils";

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

  try {
    const u = new URL(body.imageUrl);
    if (!u.hostname.endsWith(".fal.media") && !u.hostname.endsWith("fal.media")) {
      return NextResponse.json({ error: "untrusted_url" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  // 누끼 제거
  let cleanedUrl: string;
  try {
    cleanedUrl = await removeBackground(body.imageUrl);
  } catch (e) {
    console.error("[doll] bg removal failed:", e);
    return NextResponse.json({ error: "bg_removal_failed" }, { status: 502 });
  }

  const src = await fetch(cleanedUrl);
  if (!src.ok) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
  const raw = await src.arrayBuffer();

  // 캐릭터 정중앙 + 일정 비율 frame 으로 정규화 (lib/image-utils)
  let normalized: Buffer;
  try {
    normalized = await normalizeDollImage(raw);
  } catch (e) {
    console.error("[doll] normalize failed:", e);
    return NextResponse.json({ error: "normalize_failed" }, { status: 500 });
  }

  const dollId = crypto.randomUUID();
  const path = `${user.id}/${dollId}.png`;

  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, normalized, { contentType: "image/png", upsert: false });
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

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }

  // owner 검증 + Storage 파일 path 받아오기
  const { data: doll, error: selErr } = await supabase
    .from("dolls")
    .select("id, owner_id, image_url")
    .eq("id", id)
    .single();
  if (selErr || !doll) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (doll.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Storage 파일 삭제 (admin — owner 검증은 위에서 통과)
  const admin = createAdminClient();
  const storagePath = doll.image_url.split("/dolls/")[1];
  if (storagePath) {
    await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
  }

  // dolls row 삭제 — scores.doll_id 는 FK on delete set null 이라 점수는 살아남음
  const { error: delErr } = await supabase.from("dolls").delete().eq("id", id);
  if (delErr) {
    return NextResponse.json(
      { error: "delete_failed", detail: delErr.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
