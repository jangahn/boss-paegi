#!/usr/bin/env node
/**
 * 탈퇴 스크럽 marker 이메일 복원 (1회성 백필).
 *
 * 배경: 탈퇴(soft-delete)는 auth.users.email 을 'deleted+<uid>@deleted.invalid' marker 로 스크럽한다.
 *   재활성(0037)은 member_accounts.email 만 복원하고 auth.users.email 은 못 고쳐(SQL RPC) marker 가
 *   영구 잔존 → 재로그인 콜백이 member_accounts.email 까지 marker 로 재오염했다(상세: PR 본문).
 *   코드 fix(extractOAuthProfile marker 가드 + 재활성 라우트 F1 + RPC 0048)는 *미래* 오염만 막으므로,
 *   이미 오염된 **활성(deleted_at IS NULL)** 계정은 이 스크립트로 보정한다.
 *
 * 대상: member_accounts.email 이 marker 이고 profiles.deleted_at IS NULL 인 계정.
 *   (auth.users marker count == member marker count 인 현 상태에선 이 쿼리가 오염 계정을 모두 잡는다.)
 * 동작(계정별): OAuth identity(provider<>'email')의 실 이메일을 찾아
 *   1) admin.updateUserById(uid, {email: real})  → auth.users.email(A) + email-identity(B) 복원
 *   2) member_accounts.email = real               → member(E) 복원
 *   탈퇴 상태(deleted_at IS NOT NULL)인 계정은 건드리지 않는다(marker 가 정당 — PIPA 익명화 유지).
 *
 * 실행:
 *   node --env-file=.env.local scripts/backfill-email-unscrub.mjs           # dry-run(기본)
 *   node --env-file=.env.local scripts/backfill-email-unscrub.mjs --apply   # 실제 적용
 */

import { createClient } from "@supabase/supabase-js";

const MARKER_RE = /@deleted\.invalid$/i;
const isMarker = (e) => typeof e === "string" && MARKER_RE.test(e);
const APPLY = process.argv.includes("--apply");

/** getUserById 결과에서 복원할 실 이메일(OAuth identity 우선, marker 제외). */
function realEmailFromUser(user) {
  const provider = user?.app_metadata?.provider;
  const ids = user?.identities ?? [];
  const candidates = [
    ...ids.filter((i) => i.provider === provider),
    ...ids.filter((i) => i.provider !== provider && i.provider !== "email"),
    ...ids.filter((i) => i.provider === "email"),
  ];
  for (const i of candidates) {
    const e = i.identity_data?.email ?? i.email;
    if (e && !isMarker(e)) return e;
  }
  // identity 에 없으면 user_metadata 폴백(콜백이 머지한 OAuth 원본).
  const um = user?.user_metadata?.email;
  return um && !isMarker(um) ? um : null;
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

  // 오염된 활성 계정: member_accounts marker + profiles.deleted_at IS NULL
  const { data: rows, error } = await sb
    .from("member_accounts")
    .select("user_id, email, profiles!inner(deleted_at)")
    .like("email", "deleted+%@deleted.invalid")
    .is("profiles.deleted_at", null);
  if (error) throw error;
  console.log(`poisoned active accounts: ${rows.length}\n`);

  let ok = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const uid = row.user_id;
    const tag = uid.slice(0, 8);
    try {
      const { data: full, error: ue } = await sb.auth.admin.getUserById(uid);
      if (ue || !full?.user) { console.log(`[${tag}] SKIP getUserById ${ue?.message || "no user"}`); skipped++; continue; }
      const real = realEmailFromUser(full.user);
      if (!real) { console.log(`[${tag}] SKIP no real email in identities/metadata`); skipped++; continue; }

      const authMarker = isMarker(full.user.email);
      console.log(`[${tag}] member.email=${row.email} | auth.email=${full.user.email} → restore=${real}` +
        `${authMarker ? " (auth+member)" : " (member only)"}`);

      if (APPLY) {
        const { error: aErr } = await sb.auth.admin.updateUserById(uid, { email: real });
        if (aErr) { console.log(`[${tag}] auth update error: ${aErr.message}`); failed++; continue; }
        const { error: mErr } = await sb.from("member_accounts").update({ email: real }).eq("user_id", uid);
        if (mErr) { console.log(`[${tag}] member update error: ${mErr.message}`); failed++; continue; }
        // 확인
        const { data: chk } = await sb.auth.admin.getUserById(uid);
        console.log(`[${tag}] DONE auth.email now=${chk?.user?.email}`);
      }
      ok++;
    } catch (e) {
      console.log(`[${tag}] ERROR ${e.message}`);
      failed++;
    }
  }
  console.log(`\n=== ${APPLY ? "applied" : "dry-run"} — ok:${ok} skipped:${skipped} failed:${failed} ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
