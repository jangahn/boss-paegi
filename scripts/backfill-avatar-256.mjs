#!/usr/bin/env node
/**
 * 업로드 프로필 사진 256px 로 다시 넣기 (v1.63, 1회성 백필).
 *
 * 배경: v1.63 부터 업로드 규격이 128~256px JPEG(종전 512px, `lib/avatar.ts`)다. 이미 `avatars` 버킷에 있는 512px 사진은
 *   24~44px 칸(헤더 · 랭킹 · 기록 목록)에서도 27~109KB 를 그대로 받게 하므로 같은 규격으로 줄여 다시 넣는다.
 *
 * 대상: 활성(deleted_at IS NULL) 프로필 중 avatar_url 이 이 프로젝트 `avatars` 버킷이고 가로 · 세로 중 큰 쪽이 256px 를
 *   넘는 사진. 256px 이하(「캐릭터로 고르기」 프리셋 256px PNG 포함)와 카카오 · 구글 주소는 건드리지 않는다.
 * 동작(사진별): 앱의 업로드와 같은 규격(가운데 정사각 · 흰 배경 · JPEG q85 · 256px)으로 줄인 뒤 앱과 같은 교체 경로를 탄다.
 *   1) create_avatar_upload_intent(p_user_id, p_path)   — 새 경로 `<userId>/<uuid>.jpg`
 *   2) 업로드(image/jpeg, cacheControl 31536000, upsert 없음)
 *   3) confirm_avatar_upload_intent(p_user_id, p_path)
 *   4) request_avatar_replace(p_user_id, p_path, p_public_url) — profiles.avatar_url 교체 + 옛 파일 정리 잡(avatar_replace)
 *   옛 파일은 지우지 않는다 — 정리 잡을 content-maintain cron 이 처리한다. 중간에 실패하면 올린 파일은 업로드 intent
 *   만료 뒤 같은 정리 경로가 지운다. 로그에는 사용자 id 앞 8자리와 크기만 남기고 사진 주소는 찍지 않는다.
 *
 * 실행:
 *   node --env-file=.env.local scripts/backfill-avatar-256.mjs           # dry-run(기본)
 *   node --env-file=.env.local scripts/backfill-avatar-256.mjs --apply   # 실제 적용
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const BUCKET = "avatars";
const MAX_DIM = 256; // lib/avatar.ts 와 같다
const MAX_BYTES = 512 * 1024; // app/api/avatar/route.ts 와 같다
const APPLY = process.argv.includes("--apply");

/** 이 프로젝트 avatars 공개 주소면 버킷 안 경로, 아니면 null. */
function avatarPath(avatarUrl, supabaseUrl) {
  if (typeof avatarUrl !== "string") return null;
  let u;
  try {
    u = new URL(avatarUrl);
  } catch {
    return null;
  }
  if (u.origin !== new URL(supabaseUrl).origin) return null;
  const prefix = `/storage/v1/object/public/${BUCKET}/`;
  if (!u.pathname.startsWith(prefix)) return null;
  return decodeURIComponent(u.pathname.slice(prefix.length));
}

/** 앱 업로드(`normalizeSquare`)와 같은 규격: 가운데 정사각 · 흰 배경 · JPEG q85 · 256px. */
async function normalize(buf) {
  return sharp(buf)
    .rotate()
    .resize(MAX_DIM, MAX_DIM, { fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
}

function rpcOk(res, name) {
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  if (!res.data || res.data.ok !== true) throw new Error(`${name}: unexpected ack`);
  return res.data;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(APPLY ? "=== APPLY mode ===\n" : "=== DRY-RUN (use --apply to write) ===\n");

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, avatar_url")
      .is("deleted_at", null)
      .like("avatar_url", `%/storage/v1/object/public/${BUCKET}/%`)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`bucket avatars in use: ${rows.length}\n`);

  let done = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const uid = row.id;
    const tag = uid.slice(0, 8);
    try {
      const oldPath = avatarPath(row.avatar_url, url);
      if (!oldPath) { console.log(`[${tag}] SKIP not this project's avatars URL`); skipped++; continue; }
      const { data: blob, error: dErr } = await sb.storage.from(BUCKET).download(oldPath);
      if (dErr || !blob) { console.log(`[${tag}] SKIP download ${dErr?.message ?? "empty"}`); skipped++; continue; }
      const buf = Buffer.from(await blob.arrayBuffer());
      const meta = await sharp(buf).metadata();
      const before = `${meta.width}×${meta.height} ${meta.format} ${Math.round(buf.length / 1024)}KB`;
      if (Math.max(meta.width ?? 0, meta.height ?? 0) <= MAX_DIM) {
        console.log(`[${tag}] SKIP already ≤${MAX_DIM}px (${before})`);
        skipped++;
        continue;
      }
      const { data: out, info } = await normalize(buf);
      if (info.width !== MAX_DIM || info.height !== MAX_DIM || out.length > MAX_BYTES) {
        throw new Error(`normalize produced ${info.width}×${info.height} ${out.length}B`);
      }
      const after = `${info.width}×${info.height} jpeg ${Math.round(out.length / 1024)}KB`;
      console.log(`[${tag}] ${before} → ${after}`);
      if (!APPLY) { done++; continue; }

      const path = `${uid}/${randomUUID()}.jpg`;
      const publicUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      rpcOk(await sb.rpc("create_avatar_upload_intent", { p_user_id: uid, p_path: path }), "create_avatar_upload_intent");
      const { error: upErr } = await sb.storage
        .from(BUCKET)
        .upload(path, out, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
      if (upErr) throw new Error(`upload: ${upErr.message}`);
      rpcOk(await sb.rpc("confirm_avatar_upload_intent", { p_user_id: uid, p_path: path }), "confirm_avatar_upload_intent");

      // 그 사이 본인이 사진을 바꿨으면 덮어쓰지 않는다(올린 파일은 intent 만료 뒤 정리된다).
      const { data: now, error: nErr } = await sb.from("profiles").select("avatar_url, deleted_at").eq("id", uid).maybeSingle();
      if (nErr || !now || now.deleted_at !== null || now.avatar_url !== row.avatar_url) {
        console.log(`[${tag}] SKIP profile changed meanwhile`);
        skipped++;
        continue;
      }
      const replace = rpcOk(
        await sb.rpc("request_avatar_replace", { p_user_id: uid, p_path: path, p_public_url: publicUrl }),
        "request_avatar_replace",
      );
      const { data: chk } = await sb.from("profiles").select("avatar_url").eq("id", uid).maybeSingle();
      if (chk?.avatar_url !== publicUrl) throw new Error("postcondition: avatar_url not replaced");
      console.log(`[${tag}] DONE old-file cleanup=${replace.cleanup_status}`);
      done++;
    } catch (e) {
      console.log(`[${tag}] ERROR ${e.message}`);
      failed++;
    }
  }
  console.log(`\n=== ${APPLY ? "applied" : "dry-run"} — resize:${done} skipped:${skipped} failed:${failed} ===`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
