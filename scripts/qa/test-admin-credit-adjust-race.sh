#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ -z "$project_id" ]]; then
  echo "supabase project_id is missing" >&2
  exit 1
fi

db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
if [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-admin-adjust-race.XXXXXX")"
same_owner_pid=""
same_waiter_pid=""
abort_owner_pid=""
late_post_pid=""
post_owner_pid=""
recover_waiter_pid=""
adjust_owner_pid=""
delete_waiter_pid=""
delete_owner_pid=""
adjust_waiter_pid=""
admin_id=""
same_target=""
abort_target=""
post_target=""
adjust_first_target=""
delete_first_target=""
same_request=""
abort_request=""
post_request=""
adjust_first_request=""
delete_first_request=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
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
  exec 4>&-
  exec 5>&-
  exec 6>&-
  exec 7>&-
  for pid in \
    "$same_owner_pid" "$same_waiter_pid" "$abort_owner_pid" \
    "$late_post_pid" "$post_owner_pid" "$recover_waiter_pid" \
    "$adjust_owner_pid" "$delete_waiter_pid" "$delete_owner_pid" \
    "$adjust_waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$same_target" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$abort_target" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$post_target" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$adjust_first_target" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$delete_first_target" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$same_request" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$abort_request" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$post_request" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$adjust_first_request" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$delete_first_request" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      alter table public.admin_operation_receipts
        disable trigger trg_admin_operation_receipts_freeze;
      delete from public.admin_operation_receipts
       where request_id in (
         '$same_request'::uuid,
         '$abort_request'::uuid,
         '$post_request'::uuid,
         '$adjust_first_request'::uuid,
         '$delete_first_request'::uuid
       );
      alter table public.admin_operation_receipts
        enable trigger trg_admin_operation_receipts_freeze;
      delete from public.admin_actions_ledger
       where metadata->>'request_id' in (
         '$same_request',
         '$abort_request',
         '$post_request',
         '$adjust_first_request',
         '$delete_first_request'
       );
      delete from public.credit_ledger
       where user_id in (
         '$same_target'::uuid,
         '$abort_target'::uuid,
         '$post_target'::uuid,
         '$adjust_first_target'::uuid,
         '$delete_first_target'::uuid
       )
          or ref_lot_id in (
            select id
              from public.credit_lots
             where user_id in (
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
             )
          );
      delete from public.credit_lots
       where user_id in (
         '$same_target'::uuid,
         '$abort_target'::uuid,
         '$post_target'::uuid,
         '$adjust_first_target'::uuid,
         '$delete_first_target'::uuid
       );
      delete from public.account_deletion_cleanup_jobs
       where user_id in (
         '$same_target'::uuid,
         '$abort_target'::uuid,
         '$post_target'::uuid,
         '$adjust_first_target'::uuid,
         '$delete_first_target'::uuid
       );
      delete from public.member_accounts
       where user_id in (
         '$admin_id'::uuid,
         '$same_target'::uuid,
         '$abort_target'::uuid,
         '$post_target'::uuid,
         '$adjust_first_target'::uuid,
         '$delete_first_target'::uuid
       );
      delete from auth.users
       where id in (
         '$admin_id'::uuid,
         '$same_target'::uuid,
         '$abort_target'::uuid,
         '$post_target'::uuid,
         '$adjust_first_target'::uuid,
         '$delete_first_target'::uuid
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
              from public.admin_operation_receipts
             where request_id in (
               '$same_request'::uuid,
               '$abort_request'::uuid,
               '$post_request'::uuid,
               '$adjust_first_request'::uuid,
               '$delete_first_request'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.admin_actions_ledger
             where metadata->>'request_id' in (
               '$same_request',
               '$abort_request',
               '$post_request',
               '$adjust_first_request',
               '$delete_first_request'
             )
          )
          + (
            select pg_catalog.count(*)
              from public.credit_ledger
             where user_id in (
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
             )
                or ref_lot_id in (
                  select id
                    from public.credit_lots
                   where user_id in (
                     '$same_target'::uuid,
                     '$abort_target'::uuid,
                     '$post_target'::uuid,
                     '$adjust_first_target'::uuid,
                     '$delete_first_target'::uuid
                   )
                )
          )
          + (
            select pg_catalog.count(*)
              from public.credit_lots
             where user_id in (
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.account_deletion_cleanup_jobs
             where user_id in (
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (
               '$admin_id'::uuid,
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$admin_id'::uuid,
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$admin_id'::uuid,
               '$same_target'::uuid,
               '$abort_target'::uuid,
               '$post_target'::uuid,
               '$adjust_first_target'::uuid,
               '$delete_first_target'::uuid
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
    echo "admin credit adjustment race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  rm -rf "$qa_tmp_dir"
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "admin credit adjustment race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "output: $(basename "$output")" >&2
      tail -n 30 "$output" >&2
    fi
  done
  exit 1
}

wait_for_activity() {
  app_name="$1"
  predicate="$2"
  description="$3"
  for _ in $(seq 1 200); do
    count="$(
      db_value "
        select count(*)
          from pg_catalog.pg_stat_activity
         where application_name = '$app_name'
           and backend_type = 'client backend'
           and ($predicate);
      "
    )"
    if [[ "$count" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  fail "timed out waiting for $description"
}

catalog_ok="$(
  db_value "
    select (
      to_regclass('public.admin_operation_receipts') is not null
      and to_regprocedure(
        'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)'
      ) is not null
      and to_regprocedure(
        'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)'
      ) is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0082 is not applied; run npm run qa:db:apply first"

admin_id="$(db_value "select gen_random_uuid();")"
same_target="$(db_value "select gen_random_uuid();")"
abort_target="$(db_value "select gen_random_uuid();")"
post_target="$(db_value "select gen_random_uuid();")"
adjust_first_target="$(db_value "select gen_random_uuid();")"
delete_first_target="$(db_value "select gen_random_uuid();")"
same_request="$(db_value "select gen_random_uuid();")"
abort_request="$(db_value "select gen_random_uuid();")"
post_request="$(db_value "select gen_random_uuid();")"
adjust_first_request="$(db_value "select gen_random_uuid();")"
delete_first_request="$(db_value "select gen_random_uuid();")"

for id in \
  "$admin_id" "$same_target" "$abort_target" "$post_target" \
  "$adjust_first_target" "$delete_first_target" \
  "$same_request" "$abort_request" "$post_request" \
  "$adjust_first_request" "$delete_first_request"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email) values
    ('$admin_id'::uuid, 'adjust-admin-$admin_id@test.local'),
    ('$same_target'::uuid, 'adjust-same-$same_target@test.local'),
    ('$abort_target'::uuid, 'adjust-abort-$abort_target@test.local'),
    ('$post_target'::uuid, 'adjust-post-$post_target@test.local'),
    ('$adjust_first_target'::uuid, 'adjust-first-$adjust_first_target@test.local'),
    ('$delete_first_target'::uuid, 'delete-first-$delete_first_target@test.local');
  insert into public.member_accounts(user_id, gen_credits, is_admin) values
    ('$admin_id'::uuid, 0, true),
    ('$same_target'::uuid, 2, false),
    ('$abort_target'::uuid, 0, false),
    ('$post_target'::uuid, 0, false),
    ('$adjust_first_target'::uuid, 0, false),
    ('$delete_first_target'::uuid, 0, false)
  on conflict (user_id) do update
    set gen_credits = excluded.gen_credits,
        is_admin = excluded.is_admin;
  insert into public.credit_lots(user_id, source, qty, granted_at, expires_at)
  values (
    '$same_target'::uuid,
    'legacy_free',
    2,
    now(),
    now() + interval '1 year'
  );
" >/dev/null

# A) 같은 요청 POST 두 개: 첫 트랜잭션이 영수증과 금융 변경을 미커밋으로 보유하고,
# 두 번째 트랜잭션은 같은 advisory lock에서 대기한 뒤 저장된 결과만 돌려받아야 한다.
same_owner_app="bp_qa_adjust_owner_$$"
same_waiter_app="bp_qa_adjust_waiter_$$"
mkfifo "$qa_tmp_dir/same-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/same-owner.fifo" \
  >"$qa_tmp_dir/same-owner.out" 2>&1 &
same_owner_pid="$!"
exec 3>"$qa_tmp_dir/same-owner.fifo"
printf "%s\n" "
  set application_name = '$same_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_adjust_credits(
    '$admin_id'::uuid,
    '$same_target'::uuid,
    3,
    'same request race',
    '$same_request'::uuid
  );
" >&3
wait_for_activity \
  "$same_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "first adjustment transaction"

db_psql -qAt -c "
  set application_name = '$same_waiter_app';
  set statement_timeout = '15s';
  select public.admin_adjust_credits(
    '$admin_id'::uuid,
    '$same_target'::uuid,
    3,
    'same request race',
    '$same_request'::uuid
  );
" >"$qa_tmp_dir/same-waiter.out" 2>&1 &
same_waiter_pid="$!"
wait_for_activity \
  "$same_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "duplicate adjustment to wait on request lock"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$same_owner_pid" || fail "first adjustment transaction failed"
same_owner_pid=""
wait "$same_waiter_pid" || fail "duplicate adjustment retry failed"
same_waiter_pid=""
grep -F '"idempotent": true' "$qa_tmp_dir/same-waiter.out" >/dev/null \
  || fail "duplicate retry did not return the stored idempotent result"

same_state="$(
  db_value "
    select ma.gen_credits::text
           || '|' || count(distinct l.id)::text
           || '|' || count(distinct r.request_id)::text
      from public.member_accounts ma
      left join public.admin_actions_ledger l
        on l.target_user_id = ma.user_id
       and l.action_type = 'cs_adjust'
       and l.metadata->>'request_id' = '$same_request'
      left join public.admin_operation_receipts r
        on r.request_id = '$same_request'::uuid
       and r.state = 'completed'
     where ma.user_id = '$same_target'::uuid
     group by ma.gen_credits;
  "
)"
[[ "$same_state" == "5|1|1" ]] \
  || fail "same-request final state is not credits=5, ledger=1, receipt=1 ($same_state)"

# B) 복구가 POST보다 먼저 도착: 복구의 aborted 표식이 커밋될 때까지 늦은 POST가 기다렸다가
# request_aborted로 실패해야 한다. 결과 확인 뒤 새 요청을 안전하게 만들 수 있는 경계다.
abort_owner_app="bp_qa_adjust_abort_owner_$$"
late_post_app="bp_qa_adjust_late_post_$$"
mkfifo "$qa_tmp_dir/abort-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/abort-owner.fifo" \
  >"$qa_tmp_dir/abort-owner.out" 2>&1 &
abort_owner_pid="$!"
exec 4>"$qa_tmp_dir/abort-owner.fifo"
printf "%s\n" "
  set application_name = '$abort_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.get_admin_credit_adjust_receipt(
    '$admin_id'::uuid,
    '$abort_request'::uuid,
    '$abort_target'::uuid
  );
" >&4
wait_for_activity \
  "$abort_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "recovery-first transaction"

db_psql -qAt -c "
  set application_name = '$late_post_app';
  set statement_timeout = '15s';
  select public.admin_adjust_credits(
    '$admin_id'::uuid,
    '$abort_target'::uuid,
    4,
    'late reordered post',
    '$abort_request'::uuid
  );
" >"$qa_tmp_dir/late-post.out" 2>&1 &
late_post_pid="$!"
wait_for_activity \
  "$late_post_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "late POST to wait behind recovery tombstone"

printf "commit;\n\\q\n" >&4
exec 4>&-
wait "$abort_owner_pid" || fail "recovery-first transaction failed"
abort_owner_pid=""
if wait "$late_post_pid"; then
  fail "late POST unexpectedly applied after recovery tombstone"
fi
late_post_pid=""
grep -F "request_aborted" "$qa_tmp_dir/late-post.out" >/dev/null \
  || fail "late POST did not fail with request_aborted"

abort_state="$(
  db_value "
    select ma.gen_credits::text
           || '|' || count(l.id)::text
           || '|' || count(r.request_id)::text
      from public.member_accounts ma
      left join public.admin_actions_ledger l
        on l.target_user_id = ma.user_id
       and l.metadata->>'request_id' = '$abort_request'
      left join public.admin_operation_receipts r
        on r.request_id = '$abort_request'::uuid
       and r.state = 'aborted'
     where ma.user_id = '$abort_target'::uuid
     group by ma.gen_credits;
  "
)"
[[ "$abort_state" == "0|0|1" ]] \
  || fail "recovery-first final state is not unchanged+aborted ($abort_state)"

# C) POST가 먼저 도착: 복구는 미커밋 POST 뒤에서 기다렸다가 정확한 완료 영수증을 읽어야 한다.
post_owner_app="bp_qa_adjust_post_owner_$$"
recover_waiter_app="bp_qa_adjust_recover_waiter_$$"
mkfifo "$qa_tmp_dir/post-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/post-owner.fifo" \
  >"$qa_tmp_dir/post-owner.out" 2>&1 &
post_owner_pid="$!"
exec 5>"$qa_tmp_dir/post-owner.fifo"
printf "%s\n" "
  set application_name = '$post_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_adjust_credits(
    '$admin_id'::uuid,
    '$post_target'::uuid,
    4,
    'post before recovery',
    '$post_request'::uuid
  );
" >&5
wait_for_activity \
  "$post_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "POST-first transaction"

db_psql -qAt -c "
  set application_name = '$recover_waiter_app';
  set statement_timeout = '15s';
  select public.get_admin_credit_adjust_receipt(
    '$admin_id'::uuid,
    '$post_request'::uuid,
    '$post_target'::uuid
  );
" >"$qa_tmp_dir/recover-waiter.out" 2>&1 &
recover_waiter_pid="$!"
wait_for_activity \
  "$recover_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "recovery to wait behind in-flight POST"

printf "commit;\n\\q\n" >&5
exec 5>&-
wait "$post_owner_pid" || fail "POST-first transaction failed"
post_owner_pid=""
wait "$recover_waiter_pid" || fail "POST-first recovery failed"
recover_waiter_pid=""
grep -F '"found": true' "$qa_tmp_dir/recover-waiter.out" >/dev/null \
  || fail "POST-first recovery did not find the committed receipt"
grep -F '"after": 4' "$qa_tmp_dir/recover-waiter.out" >/dev/null \
  || fail "POST-first recovery returned the wrong financial result"

post_state="$(
  db_value "
    select ma.gen_credits::text
           || '|' || count(distinct l.id)::text
           || '|' || count(distinct r.request_id)::text
      from public.member_accounts ma
      left join public.admin_actions_ledger l
        on l.target_user_id = ma.user_id
       and l.metadata->>'request_id' = '$post_request'
      left join public.admin_operation_receipts r
        on r.request_id = '$post_request'::uuid
       and r.state = 'completed'
     where ma.user_id = '$post_target'::uuid
     group by ma.gen_credits;
  "
)"
[[ "$post_state" == "4|1|1" ]] \
  || fail "POST-first final state is not credits=4, ledger=1, receipt=1 ($post_state)"

# D) 조정이 먼저 profile KEY SHARE를 보유하면 탈퇴가 기다린다. 조정 commit 뒤 탈퇴는 새
# CS 로트를 manifest/quarantine 판정에 포함해 잔액 0 + account_deleted 만료로 수렴한다.
adjust_owner_app="bp_qa_adjust_before_delete_$$"
delete_waiter_app="bp_qa_delete_after_adjust_$$"
mkfifo "$qa_tmp_dir/adjust-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/adjust-owner.fifo" \
  >"$qa_tmp_dir/adjust-owner.out" 2>&1 &
adjust_owner_pid="$!"
exec 6>"$qa_tmp_dir/adjust-owner.fifo"
printf "%s\n" "
  set application_name = '$adjust_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_adjust_credits(
    '$admin_id'::uuid,
    '$adjust_first_target'::uuid,
    2,
    'adjust before account delete',
    '$adjust_first_request'::uuid
  );
" >&6
wait_for_activity \
  "$adjust_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "adjustment-first transaction"

db_psql -qAt -c "
  set application_name = '$delete_waiter_app';
  set statement_timeout = '15s';
  select public.admin_soft_delete_account('$adjust_first_target'::uuid);
" >"$qa_tmp_dir/delete-after-adjust.out" 2>&1 &
delete_waiter_pid="$!"
wait_for_activity \
  "$delete_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "account deletion to wait behind adjustment profile lock"

printf "commit;\n\\q\n" >&6
exec 6>&-
wait "$adjust_owner_pid" || fail "adjustment-first transaction failed"
adjust_owner_pid=""
wait "$delete_waiter_pid" || fail "deletion after adjustment failed"
delete_waiter_pid=""

adjust_delete_state="$(
  db_value "
    select (p.deleted_at is not null)::text
           || '|' || ma.gen_credits::text
           || '|' || count(distinct l.id)::text
           || '|' || count(distinct r.request_id)::text
      from public.profiles p
      join public.member_accounts ma on ma.user_id = p.id
      left join public.credit_lots l
        on l.user_id = p.id
       and l.source = 'cs_grant'
       and l.qty = 2
       and l.expired_at is not null
       and l.expiration_reason = 'account_deleted'
      left join public.admin_operation_receipts r
        on r.request_id = '$adjust_first_request'::uuid
       and r.state = 'completed'
     where p.id = '$adjust_first_target'::uuid
     group by p.deleted_at, ma.gen_credits;
  "
)"
[[ "$adjust_delete_state" == "true|0|1|1" ]] \
  || fail "adjustment-first deletion did not quarantine the committed grant ($adjust_delete_state)"

# E) 탈퇴가 먼저 profile FOR UPDATE를 보유하면 조정이 기다렸다가 account_deleted로 실패한다.
# 영수증·원장·로트 어느 것도 남지 않아 재활성 전 크레딧 부활이 불가능해야 한다.
delete_owner_app="bp_qa_delete_before_adjust_$$"
adjust_waiter_app="bp_qa_adjust_after_delete_$$"
mkfifo "$qa_tmp_dir/delete-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/delete-owner.fifo" \
  >"$qa_tmp_dir/delete-owner.out" 2>&1 &
delete_owner_pid="$!"
exec 7>"$qa_tmp_dir/delete-owner.fifo"
printf "%s\n" "
  set application_name = '$delete_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_soft_delete_account('$delete_first_target'::uuid);
" >&7
wait_for_activity \
  "$delete_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "delete-first transaction"

db_psql -qAt -c "
  set application_name = '$adjust_waiter_app';
  set statement_timeout = '15s';
  select public.admin_adjust_credits(
    '$admin_id'::uuid,
    '$delete_first_target'::uuid,
    2,
    'adjust after account delete',
    '$delete_first_request'::uuid
  );
" >"$qa_tmp_dir/adjust-after-delete.out" 2>&1 &
adjust_waiter_pid="$!"
wait_for_activity \
  "$adjust_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "adjustment to wait behind account deletion profile lock"

printf "commit;\n\\q\n" >&7
exec 7>&-
wait "$delete_owner_pid" || fail "delete-first transaction failed"
delete_owner_pid=""
if wait "$adjust_waiter_pid"; then
  fail "adjustment unexpectedly succeeded after account deletion"
fi
adjust_waiter_pid=""
grep -F "account_deleted" "$qa_tmp_dir/adjust-after-delete.out" >/dev/null \
  || fail "post-delete adjustment did not fail with account_deleted"

delete_adjust_state="$(
  db_value "
    select (p.deleted_at is not null)::text
           || '|' || ma.gen_credits::text
           || '|' || count(distinct l.id)::text
           || '|' || count(distinct r.request_id)::text
      from public.profiles p
      join public.member_accounts ma on ma.user_id = p.id
      left join public.admin_actions_ledger l
        on l.target_user_id = p.id
       and l.metadata->>'request_id' = '$delete_first_request'
      left join public.admin_operation_receipts r
        on r.request_id = '$delete_first_request'::uuid
     where p.id = '$delete_first_target'::uuid
     group by p.deleted_at, ma.gen_credits;
  "
)"
[[ "$delete_adjust_state" == "true|0|0|0" ]] \
  || fail "delete-first adjustment left financial mutation evidence ($delete_adjust_state)"

echo "admin credit adjustment race QA passed"
