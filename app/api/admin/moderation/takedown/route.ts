import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

type Target = { bucket: string; path: string };

/**
 * doll takedown — RPC(DB 상태: soft-delete + cascade + 신고 actioned) 후
 *   라우트가 storage 객체 물리삭제(직링크 사망). 전부 성공 시 artifacts_purged_at 세팅,
 *   하나라도 실패면 Sentry error + ledger metadata 기록 + artifacts_purged_at null 유지(cron 재시도).
 * 멱등: 이미 삭제된 doll 도 ok(already_deleted) + 물리삭제 재시도.
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

  // 1) DB 상태 변경(멱등) + 삭제 대상 {bucket,path} 수집.
  const { data, error } = await admin.rpc("admin_takedown_doll", {
    p_admin_id: gate.user.id,
    p_doll_id: dollId,
    p_reason: reason,
  });
  if (error) {
    log.warn("admin.takedown_fail", { dollId, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  const result = (data ?? {}) as {
    already_deleted?: boolean;
    targets?: Target[];
  };

  // 2) 물리삭제(best-effort). public URL 파싱 실패('://' 잔존)는 삭제 시도 않고 실패로 추적.
  const all = (result.targets ?? []).filter((t): t is Target => !!t && !!t.bucket && !!t.path);
  const failed: Target[] = all.filter((t) => t.path.includes("://"));
  const removable = all.filter((t) => !t.path.includes("://"));
  const byBucket = new Map<string, string[]>();
  for (const t of removable) {
    const arr = byBucket.get(t.bucket) ?? [];
    arr.push(t.path);
    byBucket.set(t.bucket, arr);
  }
  for (const [bucket, paths] of byBucket) {
    try {
      const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
      if (rmErr) {
        failed.push(...paths.map((p) => ({ bucket, path: p })));
        log.error("admin.takedown_storage_fail", { dollId, bucket, ...errInfo(rmErr) });
      }
    } catch (e) {
      failed.push(...paths.map((p) => ({ bucket, path: p })));
      log.error("admin.takedown_storage_fail", { dollId, bucket, ...errInfo(e) });
    }
  }

  // 3) 물리삭제 결과 기록 — 전부 성공만 artifacts_purged_at. 실패는 조용히 삼키지 않음.
  if (failed.length === 0) {
    await admin
      .from("dolls")
      .update({ artifacts_purged_at: new Date().toISOString() })
      .eq("id", dollId);
  } else {
    log.error("admin.takedown_storage_incomplete", { dollId, failedCount: failed.length });
    const { data: led } = await admin
      .from("moderation_actions_ledger")
      .select("id")
      .eq("target_type", "doll")
      .eq("target_id", dollId)
      .eq("action_type", "takedown_doll")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (led) {
      await admin
        .from("moderation_actions_ledger")
        .update({ metadata: { storage_remove_failed_paths: failed } })
        .eq("id", (led as { id: string }).id);
    }
  }

  // 4) OG/페이지 ISR 캐시 무효화 — doll 단독 페이지 + 이 doll 을 쓰는 share 페이지들.
  revalidatePath(`/doll/${dollId}`);
  const { data: scoreRows } = await admin
    .from("scores")
    .select("id")
    .eq("doll_id", dollId)
    .limit(50);
  for (const s of (scoreRows ?? []) as { id: string }[]) {
    revalidatePath(`/share/${s.id}`);
  }

  log.info("admin.takedown_ok", {
    dollId,
    adminId: gate.user.id,
    alreadyDeleted: !!result.already_deleted,
    purged: failed.length === 0,
  });
  return NextResponse.json({
    ok: true,
    already_deleted: !!result.already_deleted,
    purged: failed.length === 0,
    failed: failed.length,
  });
}
