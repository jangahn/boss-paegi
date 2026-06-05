import "server-only";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeBackground } from "@/lib/fal";

const BUCKET = "dolls";
const PADDING_RATIO = 0.15; // 캐릭터 bbox 의 좌우상하에 추가할 여백 비율
const MAX_DIM = 1024; // 너무 큰 PNG 방지 (Storage 부담)

/**
 * 누끼 PNG 를 받아서:
 * 1. transparent 가장자리 trim → 캐릭터 bbox 만 남김
 * 2. 정사각형으로 pad (양옆/위아래 동일하게)
 * 3. 약간의 여백 추가 (캐릭터가 frame 의 ~70-80% 차지)
 * 4. 최대 변 MAX_DIM 으로 다운사이즈
 *
 * 결과: PixiJS 가 정사각형 sprite 로 처리하면 항상 캐릭터가 중앙·일정 크기.
 */
async function normalizeDoll(input: ArrayBuffer): Promise<Buffer> {
  const trimmed = await sharp(Buffer.from(input))
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
    .toBuffer({ resolveWithObject: true });
  const { data: trimData, info } = trimmed;

  const longSide = Math.max(info.width, info.height);
  const pad = Math.round(longSide * PADDING_RATIO);
  const squareSide = longSide + pad * 2;

  const left = Math.round((squareSide - info.width) / 2);
  const top = Math.round((squareSide - info.height) / 2);
  const right = squareSide - info.width - left;
  const bottom = squareSide - info.height - top;

  const final = await sharp(trimData)
    .extend({
      top,
      bottom,
      left,
      right,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize({ width: Math.min(squareSide, MAX_DIM), height: Math.min(squareSide, MAX_DIM) })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return final;
}

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
  const raw = await src.arrayBuffer();

  // 캐릭터 정중앙 + 일정 비율 frame 으로 정규화
  let normalized: Buffer;
  try {
    normalized = await normalizeDoll(raw);
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
