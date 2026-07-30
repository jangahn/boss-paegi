import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(
    HERE,
    "../../supabase/migrations/008903_bounded_asset_cleanup_sagas.sql",
  ),
  "utf8",
);
const contract = readFileSync(
  join(HERE, "../../supabase/migrations/0092_rollout_contract_cleanup.sql"),
  "utf8",
);
const accountWorker = readFileSync(
  join(HERE, "../../lib/account-delete-cleanup-job.ts"),
  "utf8",
);
const moderationWorker = readFileSync(
  join(HERE, "../../lib/moderation-purge-job.ts"),
  "utf8",
);

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("008903은 단일 transaction과 durable journal receipt로 적용된다", () => {
  assert.match(migration, /^\s*--[\s\S]*\nbegin;/);
  assert.match(
    migration,
    /'008903_bounded_asset_cleanup_sagas', null, null, null/,
  );
  assert.match(migration, /notify pgrst, 'reload schema';\s*commit;\s*$/);
});

test("account claim은 객체와 생성 프라이버시 대상을 각각 최대 100개만 lease한다", () => {
  const claim = section(
    migration,
    "create or replace function public.claim_account_deletion_cleanup_v2",
    "create or replace function public.finish_account_deletion_cleanup_v2",
  );
  assert.match(
    claim,
    /greatest\(1, least\(coalesce\(p_target_limit, 100\), 100\)\)/,
  );
  assert.match(claim, /public\.bp_account_cleanup_targets/);
  assert.match(claim, /public\.bp_account_cleanup_generation_targets/);
  assert.match(claim, /lease_generation_ids = v_generation_ids/);
  assert.match(claim, /lease_version = j\.lease_version \+ 1/);
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /'scrub_auth', v_scrub_auth/);
});

test("두 finish는 잔존 object·late horizon·열린 intent를 모두 비종료로 되돌린다", () => {
  for (const start of [
    "create or replace function public.finish_account_deletion_cleanup_v2",
    "create or replace function public.finish_moderation_purge_v2",
  ]) {
    const finish = migration.slice(migration.indexOf(start));
    assert.match(finish, /from storage\.objects o/);
    assert.match(finish, /pending_target_remains/);
    assert.match(finish, /pending_final_sweep/);
    assert.match(finish, /pending_intent_drain/);
    assert.match(finish, /lease_version = p_lease_version/);
    assert.match(finish, /leased_until > pg_catalog\.clock_timestamp\(\)/);
  }
  assert.match(migration, /pending_auth_scrub/);
  assert.match(migration, /public\.bp_scrub_account_generation_batch/);
  assert.match(migration, /scrubbed_generation_count/);
  assert.match(migration, /trg_storage_upload_intent_reject_purge/);
  assert.match(
    migration,
    /trg_auth_users_fence_account_deletion_scrub/,
  );
  assert.match(migration, /stale_cleanup_auth_fence/);
});

test("account privacy 종결은 비용 영수증을 보존한 채 생성 PII를 익명화하고 재주입을 fence한다", () => {
  const scrub = section(
    migration,
    "create or replace function public.bp_scrub_account_generation_batch",
    "create or replace function public.bp_fence_ai_generation_privacy",
  );
  assert.match(scrub, /jsonb_array_length\(p_generation_ids\) > 100/);
  assert.match(
    scrub,
    /update public\.generation_cost_reconciliation_issues[\s\S]*owner_id = null,[\s\S]*generation_id = null,[\s\S]*external_request_id = null/,
  );
  assert.match(
    scrub,
    /update public\.generation_preflight_reservations[\s\S]*owner_id = null/,
  );
  assert.match(
    scrub,
    /update public\.generation_pick_cost_attempts[\s\S]*owner_id = null/,
  );
  assert.match(
    scrub,
    /update public\.ai_generations[\s\S]*owner_id = null,[\s\S]*fal_request_id = null,[\s\S]*candidate_urls = '\[\]'::jsonb[\s\S]*gen_params = null/,
  );
  assert.doesNotMatch(
    scrub,
    /delete from public\.generation_(?:preflight_reservations|pick_cost_attempts|face_check_cost_attempts)/,
  );
  assert.match(migration, /trg_ai_generations_fence_privacy_scrub/);
  assert.match(migration, /trg_generation_reconciliation_fence_privacy/);
  assert.match(migration, /generation_privacy_scrubbed/);
  for (const constraint of [
    "generation_preflight_generation_owner_fkey",
    "generation_submit_generation_owner_fkey",
    "generation_pick_generation_owner_fkey",
    "generation_pick_cost_generation_owner_fkey",
    "generation_reconciliation_generation_owner_fkey",
  ]) {
    assert.match(migration, new RegExp(constraint));
  }
});

test("워커는 전체 history pagination 없이 v2 100-target protocol만 사용한다", () => {
  assert.match(
    accountWorker,
    /rpc\("claim_account_deletion_cleanup_v2"[\s\S]*p_target_limit: 100/,
  );
  assert.match(
    accountWorker,
    /rpc\("finish_account_deletion_cleanup_v2"/,
  );
  assert.match(
    accountWorker,
    /rpc\("arm_account_deletion_cleanup_auth_fence"/,
  );
  assert.doesNotMatch(accountWorker, /listOwnedScoreIds/);
  assert.doesNotMatch(accountWorker, /listStorageObjectsPaginated/);

  assert.match(
    moderationWorker,
    /rpc\("claim_moderation_purge_v2"[\s\S]*p_target_limit: 100/,
  );
  assert.match(moderationWorker, /rpc\("finish_moderation_purge_v2"/);
  assert.doesNotMatch(moderationWorker, /readSupabaseRowsPaginated/);
  assert.doesNotMatch(moderationWorker, /10_000/);
});

test("0092는 drain 뒤 legacy stubs만 제거하고 v2 ACL을 재검증한다", () => {
  const compact = contract.replace(/\s+/g, " ");
  for (const signature of [
    "claim_account_deletion_cleanup(uuid, integer)",
    "finish_account_deletion_cleanup( uuid, uuid, boolean, text )",
    "claim_moderation_purge(uuid, integer)",
    "finish_moderation_purge( uuid, uuid, integer, boolean, text )",
  ]) {
    assert.ok(
      compact.includes(`drop function public.${signature}`),
      `missing legacy drop: ${signature}`,
    );
  }
  for (const name of [
    "claim_account_deletion_cleanup_v2",
    "finish_account_deletion_cleanup_v2",
    "arm_account_deletion_cleanup_auth_fence",
    "claim_moderation_purge_v2",
    "finish_moderation_purge_v2",
  ]) {
    assert.match(contract, new RegExp(name));
  }
  assert.match(contract, /cleanup compatibility stub remains/);
  assert.match(contract, /cleanup v2 ACL drift/);
  assert.match(contract, /cleanup generation privacy fence drift/);
});
