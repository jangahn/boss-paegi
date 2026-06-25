import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dollPath, DOLLS_BUCKET, HIGHLIGHTS_BUCKET } from "@/lib/storage-path";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

type Target = { bucket: string; path: string };

/**
 * doll 영구삭제 (Phase 2) = **artifact purge**(storage 객체 제거). dolls row 는 보존(감사/FK).
 * 가드: deleted_at not null(이미 takedown 된 것만 — active doll 직접 영구삭제 금지) +
 *   artifacts_purged_at null(이미 purge 안 됨). **전부 성공 시만** artifacts_purged_at=now(복구 불가 확정),
 *   일부 실패면 set 안 하고 실패 path 를 ledger metadata + log.error(Sentry)에 → 재시도 가능 상태 유지.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { dollId?: string; reason?: string }
    | null;
  if (!body?.dollId || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const dollId = body.dollId;
  const admin = createAdminClient();

  // 가드: takedown(deleted) 된 것만 + 아직 purge 안 된 것만.
  const { data: doll } = await admin
    .from("dolls")
    .select("image_url, deleted_at, artifacts_purged_at")
    .eq("id", dollId)
    .maybeSingle();
  if (!doll) return NextResponse.json({ error: "doll_not_found" }, { status: 404 });
  const d = doll as {
    image_url: string | null;
    deleted_at: string | null;
    artifacts_purged_at: string | null;
  };
  if (!d.deleted_at) {
    return NextResponse.json({ error: "not_taken_down" }, { status: 400 });
  }
  if (d.artifacts_purged_at) {
    return NextResponse.json({ ok: true, already_purged: true });
  }

  // 삭제 대상 수집: doll 이미지 + 이 doll 을 쓰는 score 들의 하이라이트 clip.
  const targets: Target[] = [];
  const dp = dollPath(d.image_url);
  if (dp) targets.push({ bucket: DOLLS_BUCKET, path: dp });
  const { data: scoreRows } = await admin
    .from("scores")
    .select("id")
    .eq("doll_id", dollId);
  const scoreIds = (scoreRows ?? []).map((s) => (s as { id: string }).id);
  if (scoreIds.length) {
    const { data: hls } = await admin
      .from("score_highlights")
      .select("highlight_clip_path")
      .in("score_id", scoreIds)
      .not("highlight_clip_path", "is", null);
    for (const h of (hls ?? []) as { highlight_clip_path: string | null }[]) {
      if (h.highlight_clip_path) {
        targets.push({ bucket: HIGHLIGHTS_BUCKET, path: h.highlight_clip_path });
      }
    }
  }

  // 물리삭제(버킷별 묶음) — path 단위 실패 추적.
  const failed: Target[] = [];
  const byBucket = new Map<string, string[]>();
  for (const t of targets) {
    const arr = byBucket.get(t.bucket) ?? [];
    arr.push(t.path);
    byBucket.set(t.bucket, arr);
  }
  for (const [bucket, paths] of byBucket) {
    try {
      const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
      if (rmErr) {
        failed.push(...paths.map((p) => ({ bucket, path: p })));
        log.error("admin.purge_storage_fail", { dollId, bucket, ...errInfo(rmErr) });
      }
    } catch (e) {
      failed.push(...paths.map((p) => ({ bucket, path: p })));
      log.error("admin.purge_storage_fail", { dollId, bucket, ...errInfo(e) });
    }
  }

  // ledger 기록(항상). 전부 성공이면 artifacts_purged_at 세팅(복구 불가 확정).
  await admin.from("moderation_actions_ledger").insert({
    admin_user_id: gate.user.id,
    action_type: "purge_doll",
    target_type: "doll",
    target_id: dollId,
    reason,
    metadata:
      failed.length > 0
        ? { storage_remove_failed_paths: failed }
        : { purged_targets: targets.length },
  });
  let purgedConfirmed = false;
  if (failed.length === 0) {
    const { error: flagErr } = await admin
      .from("dolls")
      .update({ artifacts_purged_at: new Date().toISOString() })
      .eq("id", dollId);
    if (flagErr) {
      // 객체는 제거됐는데 purged 플래그 세팅 실패 → 상태/실제 불일치(복구 가능한데 객체 부재).
      //   관측 가능하게 남김 + purged=false 반환(복구 대신 재시도 유도). 영구삭제 재호출은 멱등(없는 객체 remove 무해).
      log.error("admin.purge_flag_set_fail", { dollId, ...errInfo(flagErr) });
    } else {
      purgedConfirmed = true;
    }
  } else {
    // 일부만 실패 → purged 미세팅(복구 가능 유지) + 재시도 가능. 조용히 삼키지 않음.
    log.error("admin.purge_incomplete", { dollId, failedCount: failed.length });
  }

  // 어드민 모더레이션 표면 갱신(purged 상태 반영).
  revalidatePath("/admin/moderation");

  log.info("admin.purge_ok", {
    dollId,
    adminId: gate.user.id,
    targets: targets.length,
    failed: failed.length,
    purged: purgedConfirmed,
  });
  return NextResponse.json({
    ok: true,
    purged: purgedConfirmed,
    failed: failed.length,
  });
}
