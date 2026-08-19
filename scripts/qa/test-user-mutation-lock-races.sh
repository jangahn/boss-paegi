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
db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-user-lock-races.XXXXXX"
)"
active_owner_pid=""
active_waiter_pid=""
admin_id=""
po_paid_user=""
po_paid_order=""
po_delete_user=""
po_delete_order=""
ml_adjust_user=""
ml_generation_user=""
oa_commit_user=""
oa_commit_order=""
oa_commit_request=""
oa_delete_user=""
oa_delete_order=""
oa_delete_request=""
oe_single_user=""
oe_single_order=""
oe_auto_user=""
oe_auto_order=""
sweep_user_a=""
sweep_user_b=""
growth_backup_hex=""
growth_fixture_installed="false"

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
  growth_restore_failed=0
  growth_current_hex=""
  exec 3>&-
  if [[ -n "$active_owner_pid" ]] \
    && kill -0 "$active_owner_pid" >/dev/null 2>&1; then
    kill "$active_owner_pid" >/dev/null 2>&1
    wait "$active_owner_pid" >/dev/null 2>&1
  fi
  if [[ -n "$active_waiter_pid" ]] \
    && kill -0 "$active_waiter_pid" >/dev/null 2>&1; then
    kill "$active_waiter_pid" >/dev/null 2>&1
    wait "$active_waiter_pid" >/dev/null 2>&1
  fi
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$po_paid_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$po_paid_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$po_delete_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$po_delete_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ml_adjust_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ml_generation_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oa_commit_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oa_commit_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oa_commit_request" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oa_delete_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oa_delete_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oa_delete_request" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oe_single_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oe_single_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oe_auto_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$oe_auto_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$sweep_user_a" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$sweep_user_b" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      set constraints
        refund_attempts_pg_cancel_fkey,
        cancellation_events_matched_order_fkey
        deferred;
      create temporary table qa_fixture_generation_ids on commit drop as
      select id
        from public.ai_generations
       where owner_id in (
         '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid
       );
      alter table public.admin_operation_receipts
        disable trigger trg_admin_operation_receipts_freeze;

      delete from public.account_admin_actions_ledger
       where admin_user_id = '$admin_id'::uuid
          or target_user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          );
      delete from public.admin_actions_ledger
       where admin_user_id = '$admin_id'::uuid
          or target_user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          )
          or order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          );
      delete from public.admin_operation_receipts
       where admin_user_id = '$admin_id'::uuid
          or target_user_id in (
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid
          )
          or request_id in (
            '$oa_commit_request'::uuid, '$oa_delete_request'::uuid
          );
      alter table public.admin_operation_receipts
        enable trigger trg_admin_operation_receipts_freeze;

      delete from public.credit_ledger
       where user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          )
          or ref_order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          )
          or ref_gen_id in (select id from qa_fixture_generation_ids);
      delete from public.reconciliation_issues
       where user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid
          )
          or order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          );
      delete from public.credit_refund_shortfalls
       where order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          );
      delete from public.order_refund_attempts
       where request_id in (
            '$oa_commit_request'::uuid, '$oa_delete_request'::uuid
          )
          or user_id in (
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid
          )
          or order_uuid in (
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid
          );
      delete from public.payment_cancellation_events
       where order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          );
      delete from public.cancellation_resolution_batches
       where order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          );
      delete from public.refund_requests
       where id in (
            '$oa_commit_request'::uuid, '$oa_delete_request'::uuid
          )
          or user_id in (
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid
          )
          or scope_order_uuid in (
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid
          );
      delete from public.ai_generations
       where owner_id in (
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid
          );
      delete from public.credit_lots
       where user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          )
          or order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          );
      delete from public.orders
       where order_uuid in (
            '$po_paid_order'::uuid, '$po_delete_order'::uuid,
            '$oa_commit_order'::uuid, '$oa_delete_order'::uuid,
            '$oe_single_order'::uuid, '$oe_auto_order'::uuid
          )
          or user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid
          );
      delete from public.account_deletion_cleanup_jobs
       where user_id in (
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          );
      delete from public.member_accounts
       where user_id in (
            '$admin_id'::uuid,
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          );
      delete from auth.users
       where id in (
            '$admin_id'::uuid,
            '$po_paid_user'::uuid, '$po_delete_user'::uuid,
            '$ml_adjust_user'::uuid, '$ml_generation_user'::uuid,
            '$oa_commit_user'::uuid, '$oa_delete_user'::uuid,
            '$oe_single_user'::uuid, '$oe_auto_user'::uuid,
            '$sweep_user_a'::uuid, '$sweep_user_b'::uuid
          );
      do \$qa_cleanup\$
      begin
        if exists (
          select 1
            from public.credit_ledger
           where ref_gen_id in (
             select id from qa_fixture_generation_ids
           )
        ) then
          raise exception 'fixture_generation_ledger_cleanup_failed';
        end if;
      end
      \$qa_cleanup\$;
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        with fixture_users(id) as (
          values
            ('$admin_id'::uuid),
            ('$po_paid_user'::uuid), ('$po_delete_user'::uuid),
            ('$ml_adjust_user'::uuid), ('$ml_generation_user'::uuid),
            ('$oa_commit_user'::uuid), ('$oa_delete_user'::uuid),
            ('$oe_single_user'::uuid), ('$oe_auto_user'::uuid),
            ('$sweep_user_a'::uuid), ('$sweep_user_b'::uuid)
        ),
        fixture_orders(id) as (
          values
            ('$po_paid_order'::uuid), ('$po_delete_order'::uuid),
            ('$oa_commit_order'::uuid), ('$oa_delete_order'::uuid),
            ('$oe_single_order'::uuid), ('$oe_auto_order'::uuid)
        )
        select
          (select count(*) from auth.users
            where id in (select id from fixture_users))
          + (select count(*) from public.profiles
              where id in (select id from fixture_users))
          + (select count(*) from public.member_accounts
              where user_id in (select id from fixture_users))
          + (select count(*) from public.account_deletion_cleanup_jobs
              where user_id in (select id from fixture_users))
          + (select count(*) from public.account_admin_actions_ledger
              where admin_user_id in (select id from fixture_users)
                 or target_user_id in (select id from fixture_users))
          + (select count(*) from public.admin_actions_ledger
              where admin_user_id in (select id from fixture_users)
                 or target_user_id in (select id from fixture_users)
                 or order_uuid in (select id from fixture_orders))
          + (select count(*) from public.admin_operation_receipts
              where admin_user_id in (select id from fixture_users)
                 or target_user_id in (select id from fixture_users))
          + (select count(*) from public.ai_generations
              where owner_id in (select id from fixture_users))
          + (select count(*) from public.credit_ledger
              where user_id in (select id from fixture_users)
                 or ref_order_uuid in (select id from fixture_orders)
                 or ref_gen_id in (
                   select id
                     from public.ai_generations
                    where owner_id in (select id from fixture_users)
                 ))
          + (select count(*) from public.credit_lots
              where user_id in (select id from fixture_users)
                 or order_uuid in (select id from fixture_orders))
          + (select count(*) from public.credit_refund_shortfalls
              where order_uuid in (select id from fixture_orders))
          + (select count(*) from public.order_refund_attempts
              where user_id in (select id from fixture_users)
                 or order_uuid in (select id from fixture_orders))
          + (select count(*) from public.payment_cancellation_events
              where order_uuid in (select id from fixture_orders))
          + (select count(*) from public.cancellation_resolution_batches
              where order_uuid in (select id from fixture_orders))
          + (select count(*) from public.reconciliation_issues
              where user_id in (select id from fixture_users)
                 or order_uuid in (select id from fixture_orders))
          + (select count(*) from public.refund_requests
              where user_id in (select id from fixture_users)
                 or scope_order_uuid in (select id from fixture_orders))
          + (select count(*) from public.orders
              where user_id in (select id from fixture_users)
                 or order_uuid in (select id from fixture_orders));
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if [[ "$growth_fixture_installed" == "true" ]]; then
    if [[ -n "$growth_backup_hex" && "$growth_backup_hex" =~ ^[0-9a-f]+$ ]]; then
      db_psql -q -c "
        delete from public.app_settings where key = 'growth_levers';
        insert into public.app_settings
        select restored.*
          from pg_catalog.json_populate_record(
            null::public.app_settings,
            pg_catalog.convert_from(
              pg_catalog.decode('$growth_backup_hex', 'hex'),
              'UTF8'
            )::json
          ) as restored;
      " >>"$qa_tmp_dir/cleanup.out" 2>&1 || growth_restore_failed=1
    elif [[ -z "$growth_backup_hex" ]]; then
      db_psql -q -c "
        delete from public.app_settings where key = 'growth_levers';
      " >>"$qa_tmp_dir/cleanup.out" 2>&1 || growth_restore_failed=1
    else
      growth_restore_failed=1
    fi
    if ! growth_current_hex="$(
      db_value "
        select pg_catalog.encode(
                 pg_catalog.convert_to(
                   pg_catalog.row_to_json(s)::text,
                   'UTF8'
                 ),
                 'hex'
               )
          from public.app_settings s
         where s.key = 'growth_levers';
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      growth_restore_failed=1
    elif [[ "$growth_current_hex" != "$growth_backup_hex" ]]; then
      growth_restore_failed=1
    fi
  fi
  if (( cleanup_failed != 0 || growth_restore_failed != 0 )); then
    echo "user mutation lock race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 40 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  if [[ -d "$qa_tmp_dir" && "$qa_tmp_dir" == */boss-paegi-user-lock-races.* ]]; then
    rm -rf "$qa_tmp_dir"
  fi
  if (( (cleanup_failed != 0 || growth_restore_failed != 0) \
        && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "user mutation lock race QA failed: $*" >&2
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

run_pair() {
  pair_name="$1"
  owner_sql="$2"
  waiter_sql="$3"
  owner_app="bp_qa_${pair_name}_owner_$$"
  waiter_app="bp_qa_${pair_name}_waiter_$$"
  owner_fifo="$qa_tmp_dir/${pair_name}.fifo"
  owner_out="$qa_tmp_dir/${pair_name}-owner.out"
  waiter_out="$qa_tmp_dir/${pair_name}-waiter.out"

  mkfifo "$owner_fifo"
  db_psql -qAt <"$owner_fifo" >"$owner_out" 2>&1 &
  active_owner_pid="$!"
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
  active_waiter_pid="$!"
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
    "$pair_name waiter on the canonical user advisory"

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
  wait "$active_owner_pid" || fail "$pair_name owner failed"
  active_owner_pid=""
  wait "$active_waiter_pid" || fail "$pair_name waiter failed"
  active_waiter_pid=""
}

catalog_ok="$(
  db_value "
    select (
      to_regprocedure('public.bp_user_mutation_lock(uuid)') is not null
      and to_regprocedure(
        'public.admin_adjust_credits(uuid,uuid,integer,text)'
      ) is null
      and to_regprocedure(
        'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)'
      ) is not null
      and to_regprocedure(
        'public.bp_0105_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
      ) is not null
      and strpos(
        pg_get_functiondef(
          'public.bp_user_mutation_lock_many(uuid[])'::regprocedure
        ),
        'order by u.user_id'
      ) > 0
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0084 is not applied; run npm run qa:db:apply first"

deadlocks_before="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"

uuid() {
  db_value "select pg_catalog.gen_random_uuid();"
}

admin_id="$(uuid)"
po_paid_user="$(uuid)"
po_paid_order="$(uuid)"
po_delete_user="$(uuid)"
po_delete_order="$(uuid)"
ml_adjust_user="$(uuid)"
ml_generation_user="$(uuid)"
oa_commit_user="$(uuid)"
oa_commit_order="$(uuid)"
oa_commit_request="$(uuid)"
oa_delete_user="$(uuid)"
oa_delete_order="$(uuid)"
oa_delete_request="$(uuid)"
oe_single_user="$(uuid)"
oe_single_order="$(uuid)"
oe_auto_user="$(uuid)"
oe_auto_order="$(uuid)"
sweep_user_a="$(uuid)"
sweep_user_b="$(uuid)"

for id in \
  "$admin_id" \
  "$po_paid_user" "$po_paid_order" "$po_delete_user" "$po_delete_order" \
  "$ml_adjust_user" "$ml_generation_user" \
  "$oa_commit_user" "$oa_commit_order" "$oa_commit_request" \
  "$oa_delete_user" "$oa_delete_order" "$oa_delete_request" \
  "$oe_single_user" "$oe_single_order" \
  "$oe_auto_user" "$oe_auto_order" \
  "$sweep_user_a" "$sweep_user_b"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

growth_backup_hex="$(
  db_value "
    select pg_catalog.encode(
             pg_catalog.convert_to(
               pg_catalog.row_to_json(s)::text,
               'UTF8'
             ),
             'hex'
           )
      from public.app_settings s
     where s.key = 'growth_levers';
  "
)"
[[ -z "$growth_backup_hex" || "$growth_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "could not safely back up growth_levers"

db_psql -q -c "
  insert into public.app_settings(key, value)
  values (
    'growth_levers',
    pg_catalog.jsonb_build_object(
      'products',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_lock_3',
          'goodname', 'lock race credits',
          'price', 1000,
          'credits', 3,
          'active', true
        )
      ),
      'creditsEnabled', true,
      'signupBonusCredits', 0
    )
  )
  on conflict (key) do update
    set value = excluded.value;

  insert into auth.users(id, email) values
    ('$admin_id', 'lock-admin-$admin_id@test.local'),
    ('$po_paid_user', 'lock-po-paid-$po_paid_user@test.local'),
    ('$po_delete_user', 'lock-po-delete-$po_delete_user@test.local'),
    ('$ml_adjust_user', 'lock-ml-adjust-$ml_adjust_user@test.local'),
    ('$ml_generation_user', 'lock-ml-generation-$ml_generation_user@test.local'),
    ('$oa_commit_user', 'lock-oa-commit-$oa_commit_user@test.local'),
    ('$oa_delete_user', 'lock-oa-delete-$oa_delete_user@test.local'),
    ('$oe_single_user', 'lock-oe-single-$oe_single_user@test.local'),
    ('$oe_auto_user', 'lock-oe-auto-$oe_auto_user@test.local'),
    ('$sweep_user_a', 'lock-sweep-a-$sweep_user_a@test.local'),
    ('$sweep_user_b', 'lock-sweep-b-$sweep_user_b@test.local');

  insert into public.member_accounts(user_id, gen_credits, is_admin) values
    ('$admin_id', 0, true),
    ('$po_paid_user', 0, false),
    ('$po_delete_user', 0, false),
    ('$ml_adjust_user', 2, false),
    ('$ml_generation_user', 2, false),
    ('$oa_commit_user', 0, false),
    ('$oa_delete_user', 0, false),
    ('$oe_single_user', 0, false),
    ('$oe_auto_user', 0, false),
    ('$sweep_user_a', 1, false),
    ('$sweep_user_b', 1, false);

  insert into public.credit_lots(
    user_id, source, qty, granted_at, expires_at
  ) values
    (
      '$ml_adjust_user', 'legacy_free', 2,
      now(), now() + interval '1 year'
    ),
    (
      '$ml_generation_user', 'legacy_free', 2,
      now(), now() + interval '1 year'
    ),
    (
      '$sweep_user_a', 'legacy_free', 1,
      '2000-01-01 00:00:00+00', '2000-01-02 00:00:00+00'
    ),
    (
      '$sweep_user_b', 'legacy_free', 1,
      '2000-01-01 00:00:00+00', '2000-01-02 00:00:00+00'
    );

  select public.bp_0105_create_or_reuse_pending_order_impl(
    '$po_paid_user', '$po_paid_order', 'qa_lock_3', 1000, 3,
    replace('$po_paid_order', '-', ''), 'portone', 'card', false,
    'store-qa', 'KRW', 'channel-card-live'
  );
  select public.mark_order_failed(
    '$po_paid_order', 'FAILED', 'QA paid-first stale', '{}'::jsonb
  );
  select public.bp_0105_create_or_reuse_pending_order_impl(
    '$po_delete_user', '$po_delete_order', 'qa_lock_3', 1000, 3,
    replace('$po_delete_order', '-', ''), 'portone', 'card', false,
    'store-qa', 'KRW', 'channel-card-live'
  );
  select public.mark_order_failed(
    '$po_delete_order', 'FAILED', 'QA delete-first stale', '{}'::jsonb
  );

  select public.bp_0105_create_or_reuse_pending_order_impl(
    '$oa_commit_user', '$oa_commit_order', 'qa_lock_3', 1000, 3,
    replace('$oa_commit_order', '-', ''), 'portone', 'card', false,
    'store-qa', 'KRW', 'channel-card-live'
  );
  select public.mark_paid_and_grant(
    '$oa_commit_order', 'qa-pg-$oa_commit_order', 1000,
    pg_catalog.jsonb_build_object(
      'id', replace('$oa_commit_order', '-', ''),
      'status', 'PAID',
      'transactionId', 'qa-pg-$oa_commit_order',
      'paidAt', pg_catalog.transaction_timestamp(),
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE', 'key', 'channel-card-live'
      )
    ), pg_catalog.transaction_timestamp(), null
  );
  select public.bp_0105_create_or_reuse_pending_order_impl(
    '$oa_delete_user', '$oa_delete_order', 'qa_lock_3', 1000, 3,
    replace('$oa_delete_order', '-', ''), 'portone', 'card', false,
    'store-qa', 'KRW', 'channel-card-live'
  );
  select public.mark_paid_and_grant(
    '$oa_delete_order', 'qa-pg-$oa_delete_order', 1000,
    pg_catalog.jsonb_build_object(
      'id', replace('$oa_delete_order', '-', ''),
      'status', 'PAID',
      'transactionId', 'qa-pg-$oa_delete_order',
      'paidAt', pg_catalog.transaction_timestamp(),
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE', 'key', 'channel-card-live'
      )
    ), pg_catalog.transaction_timestamp(), null
  );

  select public.bp_0105_create_or_reuse_pending_order_impl(
    '$oe_single_user', '$oe_single_order', 'qa_lock_3', 1000, 3,
    replace('$oe_single_order', '-', ''), 'portone', 'card', false,
    'store-qa', 'KRW', 'channel-card-live'
  );
  select public.mark_paid_and_grant(
    '$oe_single_order', 'qa-pg-$oe_single_order', 1000,
    pg_catalog.jsonb_build_object(
      'id', replace('$oe_single_order', '-', ''),
      'status', 'PAID',
      'transactionId', 'qa-pg-$oe_single_order',
      'paidAt', pg_catalog.transaction_timestamp(),
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE', 'key', 'channel-card-live'
      )
    ), pg_catalog.transaction_timestamp(), null
  );
  select public.cancel_intent_begin(
    '$admin_id', '$oe_single_order', now(), 'QA full cancel intent'
  );
  select public.record_payment_cancellation_observation(
    '$oe_single_order', 'qa-cancel-$oe_single_order', 'SUCCEEDED',
    1000, now(), now(), '{}'::jsonb
  );

  select public.bp_0105_create_or_reuse_pending_order_impl(
    '$oe_auto_user', '$oe_auto_order', 'qa_lock_3', 1000, 3,
    replace('$oe_auto_order', '-', ''), 'portone', 'card', false,
    'store-qa', 'KRW', 'channel-card-live'
  );
  select public.mark_paid_and_grant(
    '$oe_auto_order', 'qa-pg-$oe_auto_order', 1000,
    pg_catalog.jsonb_build_object(
      'id', replace('$oe_auto_order', '-', ''),
      'status', 'PAID',
      'transactionId', 'qa-pg-$oe_auto_order',
      'paidAt', pg_catalog.transaction_timestamp(),
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE', 'key', 'channel-card-live'
      )
    ), pg_catalog.transaction_timestamp(), null
  );
  select public.cancel_intent_begin(
    '$admin_id', '$oe_auto_order', now(), 'QA full cancel intent'
  );
  select public.record_payment_cancellation_observation(
    '$oe_auto_order', 'qa-cancel-$oe_auto_order', 'SUCCEEDED',
    1000, now(), now(), '{}'::jsonb
  );
" >/dev/null
growth_fixture_installed="true"

db_psql -q -c "
  select public.admin_refund_begin(
    '$oa_commit_request', '$admin_id', '$oa_commit_user',
    '$oa_commit_order', 3, 'QA commit-first refund', now(),
    'portone_cancel'
  );
  select public.admin_refund_begin(
    '$oa_delete_request', '$admin_id', '$oa_delete_user',
    '$oa_delete_order', 3, 'QA delete-first refund', now(),
    'portone_cancel'
  );
" >/dev/null

oa_commit_attempt="$(
  db_value "
    select id
      from public.order_refund_attempts
     where request_id = '$oa_commit_request';
  "
)"
oa_delete_attempt="$(
  db_value "
    select id
      from public.order_refund_attempts
     where request_id = '$oa_delete_request';
  "
)"
for attempt_id in "$oa_commit_attempt" "$oa_delete_attempt"; do
  [[ "$attempt_id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "refund setup returned an invalid attempt UUID"
  refund_amount="$(
    db_value "
      select amount
        from public.order_refund_attempts
       where id = '$attempt_id';
    "
  )"
  db_psql -q -c "
    select public.admin_refund_mark_pg_requested(
      '$attempt_id',
      1000, 0, 1000,
      '[]'::jsonb,
      pg_catalog.jsonb_build_object(
        'amount', $refund_amount,
        'reason', 'BP_REFUND:$attempt_id',
        'currentCancellableAmount', 1000
      )
    );
    select public.admin_refund_record_pg_result(
      '$attempt_id',
      'succeeded',
      'qa-refund-$attempt_id',
      'SUCCEEDED',
      $refund_amount,
      'https://receipt.example/$attempt_id',
      '{}'::jsonb,
      now(),
      now()
    );
  " >/dev/null
done

# The delete-first fixture is already committed, so its replay is a valid
# idempotent A-first entry after deletion.
db_psql -q -c "
  select public.admin_refund_commit('$oa_delete_attempt');
" >/dev/null

# P ↔ O: paid/order-first and profile/delete-first.
run_pair \
  "po_paid_first" \
  "select public.mark_paid_and_grant(
     '$po_paid_order', 'qa-pg-$po_paid_order', 1000,
     pg_catalog.jsonb_build_object(
       'id', replace('$po_paid_order', '-', ''),
       'status', 'PAID',
       'transactionId', 'qa-pg-$po_paid_order',
       'paidAt', pg_catalog.transaction_timestamp(),
       'amount', pg_catalog.jsonb_build_object('total', 1000),
       'storeId', 'store-qa',
       'currency', 'KRW',
       'channel', pg_catalog.jsonb_build_object(
         'type', 'LIVE', 'key', 'channel-card-live'
       )
     ), pg_catalog.transaction_timestamp(), null
   )" \
  "select public.admin_soft_delete_account('$po_paid_user')"
run_pair \
  "po_delete_first" \
  "select public.admin_soft_delete_account('$po_delete_user')" \
  "select public.mark_paid_and_grant(
     '$po_delete_order', 'qa-pg-$po_delete_order', 1000,
     pg_catalog.jsonb_build_object(
       'id', replace('$po_delete_order', '-', ''),
       'status', 'PAID',
       'transactionId', 'qa-pg-$po_delete_order',
       'paidAt', pg_catalog.transaction_timestamp(),
       'amount', pg_catalog.jsonb_build_object('total', 1000),
       'storeId', 'store-qa',
       'currency', 'KRW',
       'channel', pg_catalog.jsonb_build_object(
         'type', 'LIVE', 'key', 'channel-card-live'
       )
     ), pg_catalog.transaction_timestamp(), null
   )"

# M ↔ L: member-first adjustment and lot-first generation consumption.
run_pair \
  "ml_adjust_first" \
  "select public.admin_adjust_credits(
     '$admin_id', '$ml_adjust_user', -1,
     'QA adjust-first consume', '$(uuid)'
   )" \
  "select public.create_generation_and_consume(
     '$ml_adjust_user', 'boss'
   )"
run_pair \
  "ml_generation_first" \
  "select public.create_generation_and_consume(
     '$ml_generation_user', 'boss'
   )" \
  "select public.admin_adjust_credits(
     '$admin_id', '$ml_generation_user', -1,
     'QA generation-first consume', '$(uuid)'
   )"

# O ↔ A: attempt-first commit and order-first deletion in both directions.
run_pair \
  "oa_commit_first" \
  "select public.admin_refund_commit('$oa_commit_attempt')" \
  "select public.admin_soft_delete_account('$oa_commit_user')"
run_pair \
  "oa_delete_first" \
  "select public.admin_soft_delete_account('$oa_delete_user')" \
  "select public.admin_refund_commit('$oa_delete_attempt')"

# O ↔ E: event-first single resolution and order-first auto-full.
run_pair \
  "oe_single_first" \
  "select public.resolve_external_cancellation(
     'qa-cancel-$oe_single_order', '$admin_id',
     'QA single-first external cancel', 3
   )" \
  "select public.resolve_external_cancellation_auto_full(
     '$oe_single_order'
   )"
run_pair \
  "oe_auto_first" \
  "select public.resolve_external_cancellation_auto_full(
     '$oe_auto_order'
   )" \
  "select public.resolve_external_cancellation(
     'qa-cancel-$oe_auto_order', '$admin_id',
     'QA auto-first external cancel', 3
   )"

# Multi-row total order: both sweepers freeze the same two-lot/two-user batch.
run_pair \
  "sweep_total_order" \
  "select public.sweep_expired(2)" \
  "select public.sweep_expired(2)"

final_state="$(
  db_value "
    select
      (
        select count(*)
          from public.member_accounts m
         where m.user_id in (
           '$po_paid_user', '$po_delete_user',
           '$ml_adjust_user', '$ml_generation_user',
           '$oa_commit_user', '$oa_delete_user',
           '$oe_single_user', '$oe_auto_user',
           '$sweep_user_a', '$sweep_user_b'
         )
           and m.gen_credits <> 0
      )::text
      || '|' ||
      (
        select count(*)
          from public.payment_cancellation_events e
         where e.cancellation_id in (
           'qa-cancel-$oe_single_order',
           'qa-cancel-$oe_auto_order'
         )
           and e.resolution_state <> 'resolved'
      )::text
      || '|' ||
      (
        select count(*)
          from public.order_refund_attempts a
         where a.id in ('$oa_commit_attempt', '$oa_delete_attempt')
           and a.state <> 'committed'
      )::text
      || '|' ||
      (
        select count(*)
          from public.credit_lots l
         where l.user_id in ('$sweep_user_a', '$sweep_user_b')
           and (
             l.expired_at is null
             or l.expiration_reason <> 'natural'
           )
      )::text
      || '|' ||
      (
        select count(*)
          from public.member_accounts m
          left join (
            select
              l.user_id,
              sum(
                l.qty - l.consumed - l.refunded - l.refund_reserved
              ) as remaining
              from public.credit_lots l
             where l.expired_at is null
             group by l.user_id
          ) envelope on envelope.user_id = m.user_id
         where m.gen_credits <> coalesce(envelope.remaining, 0)
      )::text;
  "
)"
[[ "$final_state" == "0|0|0|0|0" ]] \
  || fail "post-race financial invariants failed ($final_state)"

deadlocks_after="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"
[[ "$deadlocks_after" == "$deadlocks_before" ]] \
  || fail "database deadlock counter changed ($deadlocks_before -> $deadlocks_after)"

echo "user mutation lock races passed: P↔O, M↔L, O↔A, O↔E, multi-row total order"
