#!/usr/bin/env node
/**
 * 기존 dolls 정규화 (1회성). 새 sharp 파이프라인 도입 전 만들어진
 * 인형들을 trim + 정사각형 1:1 + 캐릭터 중앙으로 재처리.
 *
 * 실행:
 *   node --env-file=.env.local scripts/backfill-dolls.mjs
 *
 * 동작:
 *  1. 모든 dolls.image_url 다운로드
 *  2. sharp normalize (trim transparent + pad to square + max 1024px)
 *  3. .png path 로 Supabase Storage 에 upsert
 *  4. 기존 path 가 .png 아니면 (.jpeg 등) old file 삭제
 *  5. dolls.image_url 새 public URL 로 업데이트
 *
 * fal API 추가 호출 없음 — 비용 0.
 */

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const PADDING_RATIO = 0.12;
const MAX_DIM = 1024;
const ASPECT_W = 3;
const ASPECT_H = 4;

async function normalize(buf) {
  const trimmed = await sharp(buf)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
    .toBuffer({ resolveWithObject: true });
  let { data, info } = trimmed;

  const maxBboxLong = Math.round(MAX_DIM / (1 + 2 * PADDING_RATIO));
  if (Math.max(info.width, info.height) > maxBboxLong) {
    const scale = maxBboxLong / Math.max(info.width, info.height);
    const newW = Math.max(1, Math.round(info.width * scale));
    const newH = Math.max(1, Math.round(info.height * scale));
    const resized = await sharp(data).resize(newW, newH).png().toBuffer();
    data = resized;
    info = { ...info, width: newW, height: newH };
  }

  // 3:4 캔버스 pad (캐릭터 정중앙)
  const bboxRatio = info.width / info.height;
  const targetRatio = ASPECT_W / ASPECT_H;
  let canvasW, canvasH;
  if (bboxRatio > targetRatio) {
    canvasW = Math.round(info.width * (1 + 2 * PADDING_RATIO));
    canvasH = Math.round(canvasW / targetRatio);
  } else {
    canvasH = Math.round(info.height * (1 + 2 * PADDING_RATIO));
    canvasW = Math.round(canvasH * targetRatio);
  }
  const left = Math.round((canvasW - info.width) / 2);
  const top = Math.round((canvasH - info.height) / 2);

  return sharp(data)
    .extend({
      top,
      left,
      right: canvasW - info.width - left,
      bottom: canvasH - info.height - top,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: dolls, error } = await sb
    .from("dolls")
    .select("id, owner_id, image_url, created_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  console.log(`found ${dolls.length} dolls\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const doll of dolls) {
    const tag = doll.id.slice(0, 8);
    try {
      const res = await fetch(doll.image_url);
      if (!res.ok) {
        console.log(`[${tag}] SKIP fetch ${res.status}`);
        skipped++;
        continue;
      }
      const raw = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(raw).metadata();

      // 항상 재처리 — old 의 JPEG (transparent 없음) 도 trim no-op + pad 로 통과,
      // 이미 정규화된 것도 다시 거치면 idempotent (작은 변화는 무시 가능).
      const normalized = await normalize(raw);

      const newPath = `${doll.owner_id}/${doll.id}.png`;
      const oldPath = doll.image_url.split("/dolls/")[1];

      const { error: upErr } = await sb.storage
        .from("dolls")
        .upload(newPath, normalized, {
          contentType: "image/png",
          upsert: true,
        });
      if (upErr) {
        console.log(`[${tag}] upload error: ${upErr.message}`);
        failed++;
        continue;
      }

      if (oldPath && oldPath !== newPath) {
        await sb.storage.from("dolls").remove([oldPath]);
      }

      const newUrl = sb.storage.from("dolls").getPublicUrl(newPath).data.publicUrl;
      if (newUrl !== doll.image_url) {
        await sb.from("dolls").update({ image_url: newUrl }).eq("id", doll.id);
      }

      console.log(
        `[${tag}] OK ${meta.width}x${meta.height} → ${MAX_DIM}x${MAX_DIM} ` +
          `(${(normalized.length / 1024).toFixed(0)}KB)`
      );
      ok++;
    } catch (e) {
      console.log(`[${tag}] ERROR ${e.message}`);
      failed++;
    }
  }

  console.log(`\n=== done — ok:${ok} skipped:${skipped} failed:${failed} ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
