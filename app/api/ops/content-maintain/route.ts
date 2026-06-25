import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { DOLLS_BUCKET } from "@/lib/generation";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

const HIGHLIGHTS_BUCKET = "highlights";
const TMP_FACE_PREFIX = "tmp/face";
const TMP_FACE_MAX_AGE_MS = 30 * 60 * 1000; // 30분 — 생성(60~120초)+여유 지난 고아 얼굴.
const EXPIRE_LIMIT = 100;
const PURGE_LIMIT = 50;
const FACE_FOLDER_LIMIT = 100;

/** dolls 공개 URL → 버킷상대경로(없으면 null). */
function dollPathFromUrl(url: string | null): string | null {
  if (!url) return null;
  const marker = "/object/public/dolls/";
  const i = url.indexOf(marker);
  return i >= 0 ? url.slice(i + marker.length) : null;
}

/**
 * 콘텐츠 유지보수 cron — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * ① 만료 하이라이트(highlight_expires_at 경과) clip 물리삭제 + highlight_deleted_at set
 * ② 고아 tmp/face 얼굴 백스톱 sweep(30분+)
 * ③ takedown 됐는데 artifacts_purged_at 미확정인 doll 의 storage 객체 물리삭제 재시도(점5 백스톱)
 * (탈퇴 시 하이라이트는 의도적으로 보존 — 여기서 건드리지 않음.)
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "maintain_disabled" }, { status: 503 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const result = { expired: 0, orphanFaces: 0, purgedDolls: 0, purgeFailed: 0 };

  // ── ① 만료 하이라이트 purge ──
  try {
    const { data: expired } = await admin
      .from("score_highlights")
      .select("score_id, highlight_clip_path")
      .lt("highlight_expires_at", nowIso)
      .is("highlight_deleted_at", null)
      .not("highlight_clip_path", "is", null)
      .limit(EXPIRE_LIMIT);
    const rows = (expired ?? []) as { score_id: string; highlight_clip_path: string }[];
    if (rows.length) {
      const paths = rows.map((r) => r.highlight_clip_path);
      const { error: rmErr } = await admin.storage.from(HIGHLIGHTS_BUCKET).remove(paths);
      if (rmErr) log.warn("content_maintain.expire_remove_fail", errInfo(rmErr));
      // 객체 삭제 성패와 무관하게 앱 렌더는 차단(만료 표시).
      await admin
        .from("score_highlights")
        .update({ highlight_deleted_at: nowIso })
        .in(
          "score_id",
          rows.map((r) => r.score_id)
        );
      result.expired = rows.length;
    }
  } catch (e) {
    log.error("content_maintain.expire_fail", errInfo(e));
  }

  // ── ② 고아 tmp/face sweep ──
  try {
    const cutoff = Date.now() - TMP_FACE_MAX_AGE_MS;
    const { data: folders } = await admin.storage
      .from(DOLLS_BUCKET)
      .list(TMP_FACE_PREFIX, { limit: FACE_FOLDER_LIMIT });
    for (const folder of (folders ?? []) as { name: string }[]) {
      const { data: files } = await admin.storage
        .from(DOLLS_BUCKET)
        .list(`${TMP_FACE_PREFIX}/${folder.name}`, { limit: 100 });
      const stale = ((files ?? []) as { name: string; created_at?: string }[])
        .filter((f) => {
          const t = f.created_at ? new Date(f.created_at).getTime() : 0;
          return t > 0 && t < cutoff;
        })
        .map((f) => `${TMP_FACE_PREFIX}/${folder.name}/${f.name}`);
      if (stale.length) {
        const { error: rmErr } = await admin.storage.from(DOLLS_BUCKET).remove(stale);
        if (rmErr) log.warn("content_maintain.face_remove_fail", errInfo(rmErr));
        else result.orphanFaces += stale.length;
      }
    }
  } catch (e) {
    log.error("content_maintain.face_sweep_fail", errInfo(e));
  }

  // ── ③ artifacts_purged_at 미확정 doll 물리삭제 백스톱 ──
  try {
    const { data: unpurged } = await admin
      .from("dolls")
      .select("id, image_url")
      .not("deleted_at", "is", null)
      .is("artifacts_purged_at", null)
      .limit(PURGE_LIMIT);
    for (const d of (unpurged ?? []) as { id: string; image_url: string | null }[]) {
      let ok = true;
      const dollPath = dollPathFromUrl(d.image_url);
      if (dollPath) {
        const { error } = await admin.storage.from(DOLLS_BUCKET).remove([dollPath]);
        if (error) ok = false;
      } else if (d.image_url) {
        ok = false; // 경로 파싱 실패 → 미확정 유지.
      }
      // 이 doll 을 쓰는 scores 의 하이라이트 clip (2-step: score id → highlight clip).
      const { data: scoreRows } = await admin
        .from("scores")
        .select("id")
        .eq("doll_id", d.id);
      const scoreIds = ((scoreRows ?? []) as { id: string }[]).map((s) => s.id);
      let clipPaths: string[] = [];
      if (scoreIds.length) {
        const { data: hls } = await admin
          .from("score_highlights")
          .select("highlight_clip_path")
          .in("score_id", scoreIds)
          .not("highlight_clip_path", "is", null);
        clipPaths = ((hls ?? []) as { highlight_clip_path: string }[]).map(
          (h) => h.highlight_clip_path
        );
      }
      if (clipPaths.length) {
        const { error } = await admin.storage.from(HIGHLIGHTS_BUCKET).remove(clipPaths);
        if (error) ok = false;
      }
      if (ok) {
        await admin.from("dolls").update({ artifacts_purged_at: nowIso }).eq("id", d.id);
        result.purgedDolls += 1;
      } else {
        result.purgeFailed += 1;
      }
    }
  } catch (e) {
    log.error("content_maintain.purge_backstop_fail", errInfo(e));
  }

  log.info("content_maintain.done", result);
  return NextResponse.json({ ok: true, ...result });
}
