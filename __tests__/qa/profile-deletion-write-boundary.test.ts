import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const compact = (value: string) => value.replace(/\s+/g, " ");

const migration72 = read(
  "supabase/migrations/0072_account_deletion_cleanup_saga.sql",
);
const migration74 = read(
  "supabase/migrations/0074_score_submission_integrity.sql",
);
const migration76 = read(
  "supabase/migrations/0076_client_surface_acl_manifest.sql",
);
const sagaTap = read("supabase/tests/account_deletion_cleanup_saga.pgtap.sql");
const aclTap = read("supabase/tests/client_surface_acl_manifest.pgtap.sql");
const raceHarness = read("scripts/qa/test-account-child-delete-race.sh");

test("profile nickname RLS remains active-self-only in lifecycle and ACL migrations", () => {
  const policyContract =
    /create policy "profiles: self update" on public\.profiles for update to authenticated using \(auth\.uid\(\) = id and deleted_at is null\) with check \(auth\.uid\(\) = id and deleted_at is null\)/;

  assert.match(compact(migration72), policyContract);
  assert.match(compact(migration76), policyContract);
  for (const migration of [migration72, migration76]) {
    assert.match(
      migration,
      /pg_catalog\.pg_get_expr\(p\.polqual, p\.polrelid\)/,
    );
    assert.match(
      migration,
      /pg_catalog\.pg_get_expr\(p\.polwithcheck, p\.polrelid\)/,
    );
    assert.match(
      migration,
      /'\(\(auth\.uid\(\) = id\) AND \(deleted_at IS NULL\)\)'/,
    );
  }
});

test("deleted-profile nickname trigger is private and preserves lifecycle transitions", () => {
  const lifecycle = compact(migration72);

  assert.match(
    lifecycle,
    /create or replace function public\.bp_reject_deleted_profile_update\(\)/,
  );
  assert.match(
    lifecycle,
    /old\.deleted_at is not null and new\.deleted_at is not null/,
  );
  assert.match(lifecycle, /before update of display_name on public\.profiles/);
  assert.match(
    lifecycle,
    /raise exception 'account_deleted' using errcode = 'P0001'/,
  );
  assert.match(
    compact(migration76),
    /revoke all on function public\.bp_reject_deleted_profile_update\(\) from public, anon, authenticated, service_role/,
  );
  assert.match(migration76, /trg_profiles_reject_deleted_display_name_update/);
});

test("pgTAP proves stale rejection, scrub retention, and active self update", () => {
  assert.match(
    sagaTap,
    /stale authenticated nickname update sees zero deleted rows/,
  );
  assert.match(sagaTap, /owner-bypass-name/);
  assert.match(
    sagaTap,
    /rejected stale nickname writes preserve the scrubbed public profile/,
  );
  assert.match(
    sagaTap,
    /active authenticated user retains normal self nickname update/,
  );
  assert.match(
    sagaTap,
    /active self nickname update persists after reactivation/,
  );

  assert.match(
    aclTap,
    /profile nickname RLS is exactly active authenticated self-update/,
  );
  assert.match(
    aclTap,
    /deleted-profile nickname trigger is installed and enabled/,
  );
  assert.match(aclTap, /deleted-profile nickname helper is not callable/);
});

test("two-session harness covers both profile/delete commit orders", () => {
  assert.match(raceHarness, /qa_db_name="\$\{QA_DB_NAME:-postgres\}"/);
  assert.match(raceHarness, /profile-update-first/);
  assert.match(raceHarness, /profile-delete-first/);
  assert.match(
    raceHarness,
    /account deletion to wait behind the nickname writer/,
  );
  assert.match(
    raceHarness,
    /stale nickname writer to wait behind account deletion/,
  );
  assert.match(raceHarness, /profile_waiter_count/);
  assert.match(raceHarness, /"true\|탈퇴한 사용자"/);
  assert.match(raceHarness, /active_profile_update_count/);
  assert.match(raceHarness, /owner-bypass nickname UPDATE/);
  assert.match(raceHarness, /report-delete-first/);
  assert.match(
    raceHarness,
    /score report to wait on the canonical user lock before profile read/,
  );
  assert.match(raceHarness, /report_delete_state/);
  assert.match(raceHarness, /telemetry-delete-first/);
  assert.match(
    raceHarness,
    /telemetry core to wait on the canonical user lock before profile read/,
  );
  assert.match(raceHarness, /telemetry_delete_state/);
  assert.match(raceHarness, /direct-score-stats/);
  assert.match(raceHarness, /direct-user-badge/);
  assert.match(raceHarness, /direct-telemetry-insert/);
  assert.match(raceHarness, /direct-telemetry-update/);
});

test("score report and telemetry take the canonical lifecycle lock before reading deleted_at", () => {
  const reportStart = migration74.indexOf(
    "create or replace function public.commit_score_report",
  );
  const reportEnd = migration74.indexOf(
    "revoke all on function public.commit_score_report",
    reportStart,
  );
  const report = migration74.slice(reportStart, reportEnd);
  const telemetryStart = migration74.indexOf(
    "create or replace function public.ingest_telemetry_delta",
  );
  const telemetryEnd = migration74.indexOf(
    "revoke all on function public.ingest_telemetry_delta",
    telemetryStart,
  );
  const telemetry = migration74.slice(telemetryStart, telemetryEnd);
  const lifecycleLock =
    /pg_catalog\.hashtext\('member:' \|\| p_(?:owner_id)::text\)::bigint/;

  for (const [name, body] of [
    ["score report", report],
    ["telemetry ingest", telemetry],
  ] as const) {
    const lock = body.search(lifecycleLock);
    const profile = body.indexOf("from public.profiles p");
    assert.ok(lock >= 0, `${name} canonical user lock is missing`);
    assert.ok(profile > lock, `${name} reads profile before the user lock`);
  }
});

test("score report artifacts and member telemetry have deleted-owner trigger backstops", () => {
  for (const trigger of [
    "trg_score_stats_reject_deleted_owner_insert",
    "trg_user_badges_reject_deleted_owner_insert",
    "trg_telemetry_reject_deleted_owner_insert",
    "trg_telemetry_reject_deleted_owner_ingest_update",
  ]) {
    assert.match(migration74, new RegExp(`create trigger ${trigger}`));
  }
  assert.match(
    migration74,
    /trg_telemetry_reject_deleted_owner_ingest_update[\s\S]*before update of write_count/,
  );
  assert.match(
    migration74,
    /create or replace function public\.bp_reject_deleted_score_report_insert\(\)[\s\S]*for key share of s, p[\s\S]*raise exception 'account_deleted'/,
  );
  assert.match(
    migration74,
    /create or replace function public\.bp_reject_deleted_telemetry_write\(\)[\s\S]*new\.owner_id is null[\s\S]*for key share[\s\S]*raise exception 'account_deleted'/,
  );
});
