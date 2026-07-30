// deletion-saga-sql.test.ts — 0072 migration의 트랜잭션/lease/ACL 회귀를
// DB 접속 없이 정적으로 고정한다. 실제 RPC 동작은 disposable PostgreSQL 검증을 별도로 수행한다.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  HERE,
  "../../supabase/migrations/0072_account_deletion_cleanup_saga.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

function between(start: string, end: string): string {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing SQL marker: ${start}`);
  assert.ok(to > from, `missing SQL marker: ${end}`);
  return sql.slice(from, to);
}

test("0072 전체 DDL은 begin/commit 단일 migration transaction이다", () => {
  assert.match(sql, /^\s*--[\s\S]*\nbegin;/);
  assert.match(sql, /notify pgrst, 'reload schema';\s*\n\s*commit;\s*$/);
});

test("cleanup outbox는 active-user unique, lease/completion coupling, RLS default-deny를 갖는다", () => {
  assert.match(sql, /create table public\.account_deletion_cleanup_jobs/);
  assert.match(sql, /status in \('pending', 'leased', 'completed'\)/);
  assert.match(
    sql,
    /\(status = 'leased'\) = \(lease_token is not null and leased_until is not null\)/,
  );
  assert.match(
    sql,
    /\(status = 'completed'\) = \(completed_at is not null\)/,
  );
  assert.match(
    sql,
    /final_sweep_after timestamptz not null[\s\S]*interval '2 hours 5 minutes'/,
  );
  assert.match(
    sql,
    /create unique index uq_account_deletion_cleanup_active_user[\s\S]*where status in \('pending', 'leased'\)/,
  );
  assert.match(
    sql,
    /alter table public\.account_deletion_cleanup_jobs enable row level security/,
  );
  assert.match(
    sql,
    /revoke all on table public\.account_deletion_cleanup_jobs\s+from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    between(
      "create table public.account_deletion_cleanup_jobs",
      "comment on table public.account_deletion_cleanup_jobs",
    ),
    /references\s+public\.profiles/i,
  );
});

test("soft-delete RPC는 manifest/job을 profile scrub·doll delete보다 먼저 고정한다", () => {
  const fn = between(
    "create or replace function public.admin_soft_delete_account",
    "-- ── 4. stale authenticated write DB backstop",
  );
  const manifest = fn.indexOf("v_manifest := pg_catalog.jsonb_build_object");
  const jobInsert = fn.indexOf(
    "insert into public.account_deletion_cleanup_jobs",
  );
  const profileScrub = fn.indexOf("update public.profiles");
  const dollDelete = fn.indexOf("delete from public.dolls");
  assert.ok(manifest >= 0 && jobInsert > manifest);
  assert.ok(profileScrub > jobInsert);
  assert.ok(dollDelete > profileScrub);
  assert.match(fn, /'dolls', v_doll_paths/);
  assert.match(fn, /'highlights', v_highlight_paths/);
  assert.match(fn, /'avatar', v_avatar_path/);
});

test("soft-delete RPC는 0062 금융 quarantine과 0034 개인정보 동작을 함께 보존한다", () => {
  const fn = between(
    "create or replace function public.admin_soft_delete_account",
    "-- ── 4. stale authenticated write DB backstop",
  );
  assert.match(fn, /open_refund_blocks_delete/);
  assert.match(fn, /open_issue_blocks_delete/);
  assert.match(fn, /expiration_reason = 'account_deleted'/);
  assert.match(fn, /perform public\.bp_credit_ledger_write/);
  assert.match(
    fn,
    /update public\.score_highlights sh[\s\S]*highlight_deleted_at = coalesce/,
  );
  assert.match(
    fn,
    /update public\.content_reports[\s\S]*status = 'actioned'[\s\S]*status = 'pending'/,
  );
});

test("deleted owner stale INSERT와 cleanup 전 재활성은 DB lifecycle trigger가 거부한다", () => {
  const guard = between(
    "-- ── 4. stale authenticated write DB backstop",
    "-- ── 5. fair lease claim",
  );
  assert.match(
    guard,
    /create or replace function public\.bp_reject_deleted_owner_insert\(\)/,
  );
  assert.match(guard, /from public\.profiles p[\s\S]*for key share/);
  assert.match(guard, /raise exception 'account_deleted'/);
  for (const table of ["dolls", "scores", "ai_generations"]) {
    assert.match(
      guard,
      new RegExp(
        `create trigger trg_${table}_reject_deleted_owner_insert[\\s\\S]*?before insert on public\\.${table}`,
      ),
    );
  }
  assert.match(
    guard,
    /create or replace function public\.bp_reject_deleted_score_highlight_insert\(\)[\s\S]*from public\.scores s[\s\S]*join public\.profiles p[\s\S]*for share of s, p/,
  );
  assert.match(
    guard,
    /create trigger trg_score_highlights_reject_deleted_owner_insert[\s\S]*before insert on public\.score_highlights/,
  );
  assert.match(
    guard,
    /create trigger trg_profiles_reject_early_reactivation[\s\S]*before update of deleted_at on public\.profiles/,
  );
  assert.match(guard, /raise exception 'account_cleanup_pending'/);
});

test("generation 생성 RPC는 profile lock/deleted_at 검사 후에만 row/credit을 만든다", () => {
  const guard = between(
    "-- ── 4. stale authenticated write DB backstop",
    "-- ── 5. fair lease claim",
  );
  for (const fnName of [
    "create_generation_and_consume",
    "create_generation_row",
  ]) {
    const start = guard.indexOf(`create or replace function public.${fnName}`);
    assert.ok(start >= 0);
    const body = guard.slice(start);
    const lock = body.indexOf("for key share");
    const deleted = body.indexOf("raise exception 'account_deleted'");
    const insert = body.indexOf("insert into public.ai_generations");
    assert.ok(lock >= 0 && deleted > lock && insert > deleted);
  }
  assert.match(guard, /Disposable DB 2-session concurrency plan/);
  assert.match(guard, /S1 COMMIT 뒤 account_deleted\(P0001\)/);
});

test("claim은 due-order fairness + FOR UPDATE SKIP LOCKED + fenced lease를 사용한다", () => {
  const fn = between(
    "create or replace function public.claim_account_deletion_cleanup",
    "-- ── 6. fenced finish",
  );
  assert.match(
    fn,
    /order by j\.next_attempt_at asc, j\.created_at asc, j\.id asc/,
  );
  assert.match(fn, /for update skip locked/);
  assert.match(fn, /lease_token = v_token/);
  assert.match(fn, /leased_until = clock_timestamp\(\) \+ pg_catalog\.make_interval/);
  assert.match(fn, /attempt_count = j\.attempt_count \+ 1/);
  assert.match(fn, /j\.status = 'leased' and j\.leased_until <= clock_timestamp\(\)/);
});

test("finish은 lease token/만료를 fence하고 성공 scrub 또는 pending backoff만 허용한다", () => {
  const fn = between(
    "create or replace function public.finish_account_deletion_cleanup",
    "-- ── 7. postflight",
  );
  assert.match(fn, /lease_token = p_lease_token/);
  assert.match(fn, /leased_until > clock_timestamp\(\)/);
  assert.match(fn, /raise exception 'cleanup_lease_lost'/);
  assert.match(
    fn,
    /clock_timestamp\(\) < v_job\.final_sweep_after[\s\S]*status = 'pending'[\s\S]*next_attempt_at = v_job\.final_sweep_after[\s\S]*'pending_final_sweep'/,
  );
  assert.match(
    fn,
    /status = 'completed',[\s\S]*manifest = '\{\}'::jsonb/,
  );
  assert.match(
    fn,
    /status = 'pending',[\s\S]*next_attempt_at =[\s\S]*make_interval/,
  );
  assert.match(fn, /pg_catalog\.power/);
});

test("anon/auth는 0권한이고 service_role은 외부 RPC만 EXECUTE 받는다", () => {
  for (const signature of [
    "admin_soft_delete_account\\(uuid\\)",
    "claim_account_deletion_cleanup\\(uuid, int\\)",
    "finish_account_deletion_cleanup\\(uuid, uuid, boolean, text\\)",
    "create_generation_and_consume\\(uuid, text\\)",
    "create_generation_row\\(uuid, text\\)",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `revoke all on function public\\.${signature}\\s+from public, anon, authenticated, service_role;`,
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `grant execute on function public\\.${signature}[\\s\\S]*?to service_role;`,
      ),
    );
  }
  assert.doesNotMatch(
    sql,
    /grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\.account_deletion_cleanup_jobs\s+to\s+service_role/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.bp_account_cleanup_storage_path\(text, text\)[\s\S]*service_role/,
  );
  assert.match(
    sql,
    /revoke all on function public\.bp_reject_deleted_owner_insert\(\)[\s\S]*service_role/,
  );
  assert.match(
    sql,
    /revoke all on function public\.bp_reject_deleted_score_highlight_insert\(\)[\s\S]*service_role/,
  );
  assert.match(
    sql,
    /revoke all on function public\.bp_reject_reactivation_during_cleanup\(\)[\s\S]*service_role/,
  );
});
