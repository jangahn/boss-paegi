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
const FACE_FOLDER_LIMIT = 100;

/**
 * 콘텐츠 유지보수 cron — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * ① 만료 하이라이트(highlight_expires_at 경과) clip 물리삭제 + highlight_deleted_at set
 * ② 고아 tmp/face 얼굴 백스톱 sweep(30분+)
 * (Phase 2: takedown 은 가역이라 자동 purge 없음 — 영구삭제는 어드민 수동 permanent-delete 만.
 *  탈퇴 시 하이라이트는 의도적으로 보존 — 여기서 건드리지 않음.)
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
  const result = { expired: 0, orphanFaces: 0 };

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

  log.info("content_maintain.done", result);
  return NextResponse.json({ ok: true, ...result });
}
