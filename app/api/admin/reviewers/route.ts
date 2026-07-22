import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentLegalVersions } from "@/lib/legal";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * PG 심사·테스트 계정(reviewer_accounts, 0060) CUD — 관리자 전용.
 * 생성 = Supabase auth email/password 유저 생성(email_confirm) + 동의 사전 스탬프(보너스 0)
 *        + reviewer_accounts insert. 비밀번호는 서버 생성 후 **응답에서 1회만** 노출(저장 안 함).
 * 삭제 = reviewer_accounts 행 삭제 + auth 계정 ban(주문 FK 보존 — auth 유저는 지우지 않음).
 * 비활성 = active=false + ban(로그인 자체 차단). 재활성 = active=true + unban.
 */

const BAN_FOREVER = "876000h"; // ~100년
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; // 혼동 문자(IlO0) 제외

function generatePassword(len = 16): string {
  const bytes = randomBytes(len);
  let pw = "";
  for (let i = 0; i < len; i++) pw += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  return pw;
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("reviewer_accounts")
    .select("user_id, email, active, note, created_at")
    .order("created_at", { ascending: true });
  if (error) {
    log.warn("admin.reviewers_list_fail", errInfo(error));
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { email?: string; note?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const admin = createAdminClient();
  const password = generatePassword();

  // 1) auth 유저 생성 — email_confirm(확인 메일 불필요), 실수신 불가한 주소여도 로그인엔 지장 없음.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { reviewer: true },
  });
  if (createErr || !created?.user) {
    log.warn("admin.reviewer_create_fail", { email, ...errInfo(createErr) });
    const dup = createErr?.message?.toLowerCase().includes("already") ?? false;
    return NextResponse.json({ error: dup ? "email_exists" : "create_failed" }, { status: 400 });
  }
  const userId = created.user.id;

  try {
    // 2) 동의 사전 스탬프(내부 심사용 계정 — 동의 게이트 통과 처리, 가입보너스 0).
    //    profiles 는 auth insert 트리거로 이미 존재. 버전이 null(미발행)이면 해당 항목은 skip.
    const curr = await getCurrentLegalVersions();
    const { error: rpcErr } = await admin.rpc("create_or_update_member_consent", {
      p_user_id: userId,
      p_bonus: 0,
      p_set_age: true,
      p_set_terms: curr.terms != null,
      p_terms_ver: curr.terms ?? 0,
      p_set_privacy: curr.privacy != null,
      p_privacy_ver: curr.privacy ?? 0,
    });
    if (rpcErr) throw new Error(`consent_rpc: ${rpcErr.message}`);

    // 3) reviewer 원장 insert — 이 행(active)이 결제 허용·테스트 채널 스위칭의 SoT.
    const { error: insErr } = await admin.from("reviewer_accounts").insert({
      user_id: userId,
      email,
      active: true,
      note: body?.note?.trim() || null,
      created_by: gate.user.id,
    });
    if (insErr) throw new Error(`ledger_insert: ${insErr.message}`);
  } catch (e) {
    // 부분 실패 롤백(best-effort) — 고아 auth 유저 방지.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    log.error("admin.reviewer_create_rollback", { email, ...errInfo(e) });
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }

  log.info("admin.reviewer_created", { email, userId, by: gate.user.id });
  // 비밀번호는 이 응답에서만 노출 — DB 에 평문 저장하지 않음(분실 시 재설정).
  return NextResponse.json({ ok: true, userId, email, password });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as {
    userId?: string;
    action?: "set_active" | "reset_password" | "set_note";
    active?: boolean;
    note?: string;
  } | null;
  if (!body?.userId || !body?.action) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("reviewer_accounts")
    .select("user_id, email")
    .eq("user_id", body.userId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (body.action === "set_active") {
    const active = body.active === true;
    // 비활성은 로그인 자체도 차단(ban) — 결제 게이트(active)와 이중.
    const { error: banErr } = await admin.auth.admin.updateUserById(body.userId, {
      ban_duration: active ? "none" : BAN_FOREVER,
    });
    if (banErr) {
      log.warn("admin.reviewer_ban_fail", { userId: body.userId, ...errInfo(banErr) });
      return NextResponse.json({ error: "update_failed" }, { status: 500 });
    }
    const { error } = await admin
      .from("reviewer_accounts")
      .update({ active, updated_at: new Date().toISOString() })
      .eq("user_id", body.userId);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
    log.info("admin.reviewer_set_active", { userId: body.userId, active, by: gate.user.id });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "reset_password") {
    const password = generatePassword();
    const { error } = await admin.auth.admin.updateUserById(body.userId, { password });
    if (error) {
      log.warn("admin.reviewer_pw_reset_fail", { userId: body.userId, ...errInfo(error) });
      return NextResponse.json({ error: "update_failed" }, { status: 500 });
    }
    log.info("admin.reviewer_pw_reset", { userId: body.userId, by: gate.user.id });
    return NextResponse.json({ ok: true, password });
  }

  if (body.action === "set_note") {
    const { error } = await admin
      .from("reviewer_accounts")
      .update({ note: body.note?.trim() || null, updated_at: new Date().toISOString() })
      .eq("user_id", body.userId);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { userId?: string } | null;
  if (!body?.userId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("reviewer_accounts")
    .select("user_id, email")
    .eq("user_id", body.userId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // auth 유저는 삭제하지 않고 ban — 테스트 주문(orders FK)·감사 이력 보존.
  const { error: banErr } = await admin.auth.admin.updateUserById(body.userId, {
    ban_duration: BAN_FOREVER,
  });
  if (banErr) {
    log.warn("admin.reviewer_delete_ban_fail", { userId: body.userId, ...errInfo(banErr) });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
  const { error } = await admin.from("reviewer_accounts").delete().eq("user_id", body.userId);
  if (error) return NextResponse.json({ error: "delete_failed" }, { status: 500 });

  log.info("admin.reviewer_deleted", { userId: body.userId, email: row.email, by: gate.user.id });
  return NextResponse.json({ ok: true });
}
