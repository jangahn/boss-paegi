#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ -z "$project_id" ]] \
  || [[ "$db_container" != supabase_db_* ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database is unavailable" >&2
  exit 1
fi
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-fal-submit-races.XXXXXX"
)"
owner_pid=""
waiter_pid=""
claim_owner=""
claim_gen=""
ack_owner=""
ack_gen=""
ack_first_owner=""
ack_first_gen=""
ack_first_lot=""
fail_first_owner=""
fail_first_gen=""
fail_first_lot=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

cleanup() {
  original_status=$?
  set +e
  cleanup_failed=0
  cleanup_remaining=""
  exec 3>&-
  for pid in "$owner_pid" "$waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$claim_owner" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$claim_gen" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ack_owner" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ack_gen" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ack_first_owner" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ack_first_gen" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ack_first_lot" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$fail_first_owner" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$fail_first_gen" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$fail_first_lot" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.credit_ledger
       where ref_gen_id in (
            '$claim_gen'::uuid,
            '$ack_gen'::uuid,
            '$ack_first_gen'::uuid,
            '$fail_first_gen'::uuid
          )
          or ref_lot_id in (
            '$ack_first_lot'::uuid,
            '$fail_first_lot'::uuid
          )
          or user_id in (
            '$claim_owner'::uuid,
            '$ack_owner'::uuid,
            '$ack_first_owner'::uuid,
            '$fail_first_owner'::uuid
          );
      delete from public.ai_generations
       where id in (
         '$claim_gen'::uuid,
         '$ack_gen'::uuid,
         '$ack_first_gen'::uuid,
         '$fail_first_gen'::uuid
       );
      delete from public.credit_lots
       where id in ('$ack_first_lot'::uuid, '$fail_first_lot'::uuid);
      delete from public.member_accounts
       where user_id in (
         '$claim_owner'::uuid,
         '$ack_owner'::uuid,
         '$ack_first_owner'::uuid,
         '$fail_first_owner'::uuid
       );
      delete from auth.users
       where id in (
         '$claim_owner'::uuid,
         '$ack_owner'::uuid,
         '$ack_first_owner'::uuid,
         '$fail_first_owner'::uuid
       );
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.credit_ledger
             where ref_gen_id in (
               '$claim_gen'::uuid,
               '$ack_gen'::uuid,
               '$ack_first_gen'::uuid,
               '$fail_first_gen'::uuid
             )
                or ref_lot_id in (
                  '$ack_first_lot'::uuid,
                  '$fail_first_lot'::uuid
                )
                or user_id in (
                  '$claim_owner'::uuid,
                  '$ack_owner'::uuid,
                  '$ack_first_owner'::uuid,
                  '$fail_first_owner'::uuid
                )
          )
          + (
            select pg_catalog.count(*)
              from public.generation_submit_intents
             where generation_id in (
               '$claim_gen'::uuid,
               '$ack_gen'::uuid,
               '$ack_first_gen'::uuid,
               '$fail_first_gen'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.ai_generations
             where id in (
               '$claim_gen'::uuid,
               '$ack_gen'::uuid,
               '$ack_first_gen'::uuid,
               '$fail_first_gen'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.credit_lots
             where id in (
               '$ack_first_lot'::uuid,
               '$fail_first_lot'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (
               '$claim_owner'::uuid,
               '$ack_owner'::uuid,
               '$ack_first_owner'::uuid,
               '$fail_first_owner'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$claim_owner'::uuid,
               '$ack_owner'::uuid,
               '$ack_first_owner'::uuid,
               '$fail_first_owner'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$claim_owner'::uuid,
               '$ack_owner'::uuid,
               '$ack_first_owner'::uuid,
               '$fail_first_owner'::uuid
             )
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "FAL submit race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  rm -f "$qa_tmp_dir"/*
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAL submit race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "output: $(basename "$output")" >&2
      tail -n 40 "$output" >&2
    fi
  done
  exit 1
}

# 세션 동기화는 공용 lib — 상한 120s(러너 속도 무관)·타임아웃 시 세션 스냅샷 덤프.
source scripts/qa/lib/wait-sync.sh

assert_exact_output() {
  output_file="$1"
  expected="$2"
  description="$3"
  count="$(grep -Fxc "$expected" "$output_file" || true)"
  [[ "$count" == "1" ]] \
    || fail "$description: expected one '$expected', got $count"
}

# Run the first RPC inside an open transaction, prove the second session is
# blocked on the canonical advisory lock, then commit and inspect both serial
# outcomes. This deterministically exercises both legal lock acquisition orders.
run_pair() {
  pair_name="$1"
  owner_sql="$2"
  waiter_sql="$3"
  owner_expected="$4"
  waiter_expected="$5"
  owner_app="bp_qa_fal_${pair_name}_owner_$$"
  waiter_app="bp_qa_fal_${pair_name}_waiter_$$"
  owner_fifo="$qa_tmp_dir/${pair_name}.fifo"
  owner_out="$qa_tmp_dir/${pair_name}-owner.out"
  waiter_out="$qa_tmp_dir/${pair_name}-waiter.out"

  mkfifo "$owner_fifo"
  db_psql -qAt <"$owner_fifo" >"$owner_out" 2>&1 &
  owner_pid="$!"
  exec 3>"$owner_fifo"
  printf "%s\n" "
    set application_name = '$owner_app';
    set statement_timeout = '20s';
    set lock_timeout = '15s';
    begin;
    $owner_sql;
  " >&3
  wait_for_activity \
    "$owner_app" \
    "state = 'idle in transaction' and xact_start is not null" \
    "$pair_name owner transaction"

  db_psql -qAt -c "
    set application_name = '$waiter_app';
    set statement_timeout = '20s';
    set lock_timeout = '15s';
    $waiter_sql;
  " >"$waiter_out" 2>&1 &
  waiter_pid="$!"
  wait_for_activity \
    "$waiter_app" \
    "state = 'active'
      and wait_event_type = 'Lock'
      and exists (
        select 1
          from pg_catalog.pg_locks l
         where l.pid = pg_stat_activity.pid
           and l.locktype = 'advisory'
           and not l.granted
      )" \
    "$pair_name waiter on generation advisory lock"

  blocker_count="$(
    db_value "
      select pg_catalog.cardinality(
               pg_catalog.pg_blocking_pids(a.pid)
             )
        from pg_catalog.pg_stat_activity a
       where a.datname = '$db_name'
         and a.application_name = '$waiter_app';
    "
  )"
  [[ "$blocker_count" == "1" ]] \
    || fail "$pair_name waiter does not have exactly one blocker"

  printf "commit;\n\\q\n" >&3
  exec 3>&-
  wait "$owner_pid" || fail "$pair_name owner failed"
  owner_pid=""
  wait "$waiter_pid" || fail "$pair_name waiter failed"
  waiter_pid=""

  assert_exact_output "$owner_out" "$owner_expected" "$pair_name owner outcome"
  assert_exact_output "$waiter_out" "$waiter_expected" "$pair_name waiter outcome"
}

catalog_ok="$(
  db_value "
    select (
      to_regprocedure(
        'public.claim_generation_submit_intent(uuid,uuid,integer,text,text)'
      ) is not null
      and to_regprocedure(
        'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)'
      ) is not null
      and to_regprocedure(
        'public.mark_generation_failed_and_refund(uuid,text,integer)'
      ) is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "migrations through 0086 are not applied"

uuid() {
  db_value "select pg_catalog.gen_random_uuid();"
}

claim_owner="$(uuid)"
claim_gen="$(uuid)"
ack_owner="$(uuid)"
ack_gen="$(uuid)"
ack_request="$(uuid)"
ack_first_owner="$(uuid)"
ack_first_gen="$(uuid)"
ack_first_lot="$(uuid)"
ack_first_request="$(uuid)"
fail_first_owner="$(uuid)"
fail_first_gen="$(uuid)"
fail_first_lot="$(uuid)"
fail_first_request="$(uuid)"

for id in \
  "$claim_owner" "$claim_gen" \
  "$ack_owner" "$ack_gen" "$ack_request" \
  "$ack_first_owner" "$ack_first_gen" "$ack_first_lot" "$ack_first_request" \
  "$fail_first_owner" "$fail_first_gen" "$fail_first_lot" "$fail_first_request"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || fail "PostgreSQL returned an invalid UUID"
done

# Raw hashes are deterministic test-only values. Production callback tokens
# remain random and are never stored; only their SHA-256 hashes reach this RPC.
payload_expr() {
  gen_id="$1"
  index="$2"
  printf "pg_catalog.md5('%s:payload:%s') || pg_catalog.md5('%s:payload:%s:tail')" \
    "$gen_id" "$index" "$gen_id" "$index"
}

token_expr() {
  gen_id="$1"
  index="$2"
  printf "pg_catalog.md5('%s:token:%s') || pg_catalog.md5('%s:token:%s:tail')" \
    "$gen_id" "$index" "$gen_id" "$index"
}

db_psql -q >/dev/null <<SQL
insert into auth.users(id, email)
values
  ('$claim_owner', 'fal-claim-$claim_owner@test.local'),
  ('$ack_owner', 'fal-ack-$ack_owner@test.local'),
  ('$ack_first_owner', 'fal-ack-first-$ack_first_owner@test.local'),
  ('$fail_first_owner', 'fal-fail-first-$fail_first_owner@test.local');

insert into public.member_accounts(user_id, gen_credits)
values
  ('$claim_owner', 0),
  ('$ack_owner', 0),
  ('$ack_first_owner', 0),
  ('$fail_first_owner', 0)
on conflict (user_id) do update set gen_credits = excluded.gen_credits;

insert into public.credit_lots(
  id, user_id, source, qty, consumed, granted_at, expires_at
)
values
  (
    '$ack_first_lot', '$ack_first_owner', 'signup_bonus',
    1, 1, pg_catalog.now(), pg_catalog.now() + interval '1 year'
  ),
  (
    '$fail_first_lot', '$fail_first_owner', 'signup_bonus',
    1, 1, pg_catalog.now(), pg_catalog.now() + interval '1 year'
  );

insert into public.ai_generations(
  id, owner_id, status, credit_lot_id, consumed_at, gen_params
)
values
  (
    '$claim_gen', '$claim_owner', 'queued', null, null,
    '{"generation":{"candidates":[{"index":0,"requestId":null,"status":"submitted"},{"index":1,"requestId":null,"status":"submitted"},{"index":2,"requestId":null,"status":"submitted"}]}}'
  ),
  (
    '$ack_gen', '$ack_owner', 'queued', null, null,
    '{"generation":{"candidates":[{"index":0,"requestId":null,"status":"submitted"},{"index":1,"requestId":null,"status":"submitted"},{"index":2,"requestId":null,"status":"submitted"}]}}'
  ),
  (
    '$ack_first_gen', '$ack_first_owner', 'queued',
    '$ack_first_lot', pg_catalog.now(),
    '{"generation":{"candidates":[{"index":0,"requestId":null,"status":"submitted"},{"index":1,"requestId":null,"status":"submitted"},{"index":2,"requestId":null,"status":"submitted"}]}}'
  ),
  (
    '$fail_first_gen', '$fail_first_owner', 'queued',
    '$fail_first_lot', pg_catalog.now(),
    '{"generation":{"candidates":[{"index":0,"requestId":null,"status":"submitted"},{"index":1,"requestId":null,"status":"submitted"},{"index":2,"requestId":null,"status":"submitted"}]}}'
  );
SQL

for binding in \
  "$claim_gen:$claim_owner" \
  "$ack_gen:$ack_owner" \
  "$ack_first_gen:$ack_first_owner" \
  "$fail_first_gen:$fail_first_owner"; do
  gen_id="${binding%%:*}"
  owner_id="${binding##*:}"
  db_psql -q >/dev/null <<SQL
select public.prepare_generation_submit_intents(
  '$gen_id',
  '$owner_id',
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'candidateIndex', 0,
      'payloadHash', $(payload_expr "$gen_id" 0),
      'callbackTokenHash', $(token_expr "$gen_id" 0)
    ),
    pg_catalog.jsonb_build_object(
      'candidateIndex', 1,
      'payloadHash', $(payload_expr "$gen_id" 1),
      'callbackTokenHash', $(token_expr "$gen_id" 1)
    ),
    pg_catalog.jsonb_build_object(
      'candidateIndex', 2,
      'payloadHash', $(payload_expr "$gen_id" 2),
      'callbackTokenHash', $(token_expr "$gen_id" 2)
    )
  )
);
SQL
done

deadlocks_before="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"

run_pair \
  "claim_once" \
  "select public.claim_generation_submit_intent(
     '$claim_gen', '$claim_owner', 0,
     $(payload_expr "$claim_gen" 0), $(token_expr "$claim_gen" 0)
   )->>'outcome'" \
  "select public.claim_generation_submit_intent(
     '$claim_gen', '$claim_owner', 0,
     $(payload_expr "$claim_gen" 0), $(token_expr "$claim_gen" 0)
   )->>'outcome'" \
  "claimed" \
  "not_claimable"

for binding in \
  "$ack_gen:$ack_owner" \
  "$ack_first_gen:$ack_first_owner" \
  "$fail_first_gen:$fail_first_owner"; do
  gen_id="${binding%%:*}"
  owner_id="${binding##*:}"
  claim_outcome="$(
    db_value "
      select public.claim_generation_submit_intent(
        '$gen_id', '$owner_id', 0,
        $(payload_expr "$gen_id" 0), $(token_expr "$gen_id" 0)
      )->>'outcome';
    "
  )"
  [[ "$claim_outcome" == "claimed" ]] \
    || fail "fixture claim failed for $gen_id ($claim_outcome)"
done

run_pair \
  "ack_once" \
  "select public.record_generation_submit_outcome(
     '$ack_gen', 0,
     $(payload_expr "$ack_gen" 0), $(token_expr "$ack_gen" 0),
     'acknowledged', '$ack_request', 200, 'OK'
   )->>'outcome'" \
  "select public.record_generation_submit_outcome(
     '$ack_gen', 0,
     $(payload_expr "$ack_gen" 0), $(token_expr "$ack_gen" 0),
     'acknowledged', '$ack_request', 200, 'OK'
   )->>'outcome'" \
  "acknowledged" \
  "already_acknowledged"

ack_first_version="$(
  db_value "
    select version
      from public.ai_generations
     where id = '$ack_first_gen';
  "
)"
fail_first_version="$(
  db_value "
    select version
      from public.ai_generations
     where id = '$fail_first_gen';
  "
)"
[[ "$ack_first_version" =~ ^[0-9]+$ ]] \
  && [[ "$fail_first_version" =~ ^[0-9]+$ ]] \
  || fail "generation version fixture is invalid"

# Acknowledgement wins: the stale timeout snapshot must lose its version fence
# before any status, lot, ledger, balance, or refunded_at write.
run_pair \
  "ack_before_timeout" \
  "select public.record_generation_submit_outcome(
     '$ack_first_gen', 0,
     $(payload_expr "$ack_first_gen" 0), $(token_expr "$ack_first_gen" 0),
     'acknowledged', '$ack_first_request', 200, 'OK'
   )->>'outcome'" \
  "select public.mark_generation_failed_and_refund(
     '$ack_first_gen', 'qa_stale_timeout', $ack_first_version
   )->>'outcome'" \
  "acknowledged" \
  "version_conflict"

# Timeout wins: its transition+refund commits atomically. The later signed
# callback remains durable late-ack evidence and never resurrects generation.
run_pair \
  "timeout_before_ack" \
  "select public.mark_generation_failed_and_refund(
     '$fail_first_gen', 'qa_timeout_winner', $fail_first_version
   )->>'outcome'" \
  "select public.record_generation_submit_outcome(
     '$fail_first_gen', 0,
     $(payload_expr "$fail_first_gen" 0), $(token_expr "$fail_first_gen" 0),
     'acknowledged', '$fail_first_request', 200, 'OK'
   )->>'outcome'" \
  "refunded" \
  "late_acknowledged"

final_state="$(
  db_value "
    select
      (
        select
          i.state = 'submitting'
          and i.attempt_count = 1
          and i.request_id is null
          and g.status = 'queued'
          and g.refunded_at is null
        from public.generation_submit_intents i
        join public.ai_generations g on g.id = i.generation_id
        where i.generation_id = '$claim_gen'
          and i.candidate_index = 0
      )::text
      || '|' ||
      (
        select
          i.state = 'acknowledged'
          and i.request_id = '$ack_request'
          and g.fal_request_ids[1] = '$ack_request'
          and g.status = 'queued'
        from public.generation_submit_intents i
        join public.ai_generations g on g.id = i.generation_id
        where i.generation_id = '$ack_gen'
          and i.candidate_index = 0
      )::text
      || '|' ||
      (
        select
          i.state = 'acknowledged'
          and i.request_id = '$ack_first_request'
          and g.status = 'queued'
          and g.refunded_at is null
          and g.fal_request_ids[1] = '$ack_first_request'
          and m.gen_credits = 0
          and l.consumed = 1
          and l.refunded = 0
          and (
            select pg_catalog.count(*)
              from public.credit_ledger cl
             where cl.ref_gen_id = g.id
               and cl.event_type = 'gen_refund'
          ) = 0
        from public.generation_submit_intents i
        join public.ai_generations g on g.id = i.generation_id
        join public.member_accounts m on m.user_id = g.owner_id
        join public.credit_lots l on l.id = g.credit_lot_id
        where i.generation_id = '$ack_first_gen'
          and i.candidate_index = 0
      )::text
      || '|' ||
      (
        select
          i.state = 'late_acknowledged'
          and i.request_id = '$fail_first_request'
          and g.status = 'failed'
          and g.refunded_at is not null
          and g.fal_request_ids[1] is null
          and m.gen_credits = 1
          and l.consumed = 0
          and l.refunded = 0
          and (
            select pg_catalog.count(*)
              from public.credit_ledger cl
             where cl.ref_gen_id = g.id
               and cl.event_type = 'gen_refund'
          ) = 1
        from public.generation_submit_intents i
        join public.ai_generations g on g.id = i.generation_id
        join public.member_accounts m on m.user_id = g.owner_id
        join public.credit_lots l on l.id = g.credit_lot_id
        where i.generation_id = '$fail_first_gen'
          and i.candidate_index = 0
      )::text;
  "
)"
[[ "$final_state" == "true|true|true|true" ]] \
  || fail "post-race saga invariants failed ($final_state)"

deadlocks_after="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"
[[ "$deadlocks_after" == "$deadlocks_before" ]] \
  || fail "database deadlock counter changed ($deadlocks_before -> $deadlocks_after)"

echo "FAL submit races passed: single claim, duplicate ack, ack↔timeout both orders"
