import { NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOLLS_BUCKET } from "@/lib/generation";
import { dollPath } from "@/lib/storage-path";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const HIGHLIGHTS_BUCKET = "highlights"; // lib/share.ts·content-maintain 과 동일(미export).

/**
 * 셀프 계정 탈퇴(soft-delete) — 개인정보 삭제권 대응.
 * 순서: pending 차단 → 이미지 경로 수집 → DB soft-delete RPC(먼저) → storage 삭제(best-effort)
 *      → auth.users 스크럽(best-effort). auth.users 는 삭제하지 않는다(결제기록 CASCADE 보호).
 * 결제기록(payapp_orders)은 법령상 보존을 위해 남긴다.
 */
export async function POST(req: Request) {
  // destructive — 최소 same-origin 방어. JSON POST 만(라우트가 POST 전용).
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
    }
  }

  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const userId = gate.user.id;
  const admin = createAdminClient();

  // pending 결제 race 차단 — 최근(30분) pending 만(오래된 stale 은 허용; 탈퇴 후 완료돼도
  //   mark_paid_and_grant 가 deleted_at 가드로 크레딧 미지급 → 영구 차단 방지).
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: pending } = await admin
    .from("payapp_orders")
    .select("order_uuid")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("created_at", cutoff)
    .limit(1);
  if (pending && pending.length > 0) {
    return NextResponse.json({ error: "payment_pending" }, { status: 409 });
  }

  // 1) confirmed doll 이미지 경로를 RPC(=dolls row 삭제) 전에 수집.
  const { data: dolls } = await admin
    .from("dolls")
    .select("image_url")
    .eq("owner_id", userId);
  const dollPaths = (dolls ?? [])
    .map((d) => dollPath(d.image_url as string | null)) // private 후 image_url=경로(URL도 관용)
    .filter((p): p is string => !!p);

  // 1b) 탈퇴자 하이라이트 clip 경로 수집 — 크레딧 0(전면 스크럽)과 일관되게 얼굴 영상도 삭제.
  //     RPC 는 highlight_deleted_at(render-block)만 세팅 → clip_path 잔존 → 여기서 객체 물리삭제.
  const { data: hlScores } = await admin
    .from("scores")
    .select("id")
    .eq("owner_id", userId);
  const hlScoreIds = ((hlScores ?? []) as { id: string }[]).map((s) => s.id);
  let highlightPaths: string[] = [];
  if (hlScoreIds.length) {
    const { data: hls } = await admin
      .from("score_highlights")
      .select("highlight_clip_path")
      .in("score_id", hlScoreIds)
      .not("highlight_clip_path", "is", null);
    highlightPaths = ((hls ?? []) as { highlight_clip_path: string }[]).map(
      (h) => h.highlight_clip_path
    );
  }

  // 2) DB soft-delete 먼저(실패 시 이미지 보존). 익명화 + dolls 삭제 + 크레딧 0 + 하이라이트 render-block + 고아 신고 종결.
  const { error: rpcErr } = await admin.rpc("admin_soft_delete_account", {
    p_user_id: userId,
  });
  if (rpcErr) {
    log.error("account.soft_delete_fail", { userId, ...errInfo(rpcErr) });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  // 3) storage 삭제 — best-effort. list+remove(wildcard 금지).
  try {
    if (dollPaths.length) await admin.storage.from(DOLLS_BUCKET).remove(dollPaths);
    const { data: gens } = await admin.storage.from(DOLLS_BUCKET).list(`${userId}/candidates`);
    for (const g of gens ?? []) {
      const { data: files } = await admin.storage
        .from(DOLLS_BUCKET)
        .list(`${userId}/candidates/${g.name}`);
      if (files && files.length) {
        await admin.storage
          .from(DOLLS_BUCKET)
          .remove(files.map((f) => `${userId}/candidates/${g.name}/${f.name}`));
      }
    }
    const { data: tmp } = await admin.storage.from(DOLLS_BUCKET).list(`tmp/face/${userId}`);
    if (tmp && tmp.length) {
      await admin.storage
        .from(DOLLS_BUCKET)
        .remove(tmp.map((f) => `tmp/face/${userId}/${f.name}`));
    }
    // (0034) 하이라이트 clip 물리삭제 — RPC 가 render-block 완료, 여기서 객체 제거(직링크 사망).
    if (highlightPaths.length) {
      await admin.storage.from(HIGHLIGHTS_BUCKET).remove(highlightPaths);
    }
  } catch (e) {
    log.warn("account.storage_cleanup_fail", { userId, ...errInfo(e) });
  }

  // 4) auth.users 식별정보 스크럽 — best-effort. **deleteUser 금지**(CASCADE 파괴).
  try {
    await admin.auth.admin.updateUserById(userId, {
      email: `deleted+${userId}@deleted.invalid`,
      user_metadata: {},
    });
  } catch (e) {
    log.warn("account.auth_scrub_fail", { userId, ...errInfo(e) });
  }

  log.info("account.delete_success", { userId });
  return NextResponse.json({ ok: true });
}
