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

db_container="supabase_db_${project_id}"
if [[ "$db_container" != supabase_db_* ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_db_name="${QA_DB_NAME:-postgres}"
qa_db_user="${QA_DB_USER:-postgres}"
if [[ ! "$qa_db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$qa_db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 2
fi

migration_file="supabase/migrations/0090_payment_evidence_contract_constraint.sql"
if [[ ! -f "$migration_file" ]]; then
  echo "0090 payment evidence contract migration is missing" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-payment-contract-gate.XXXXXX"
)"
migration_output="$qa_tmp_dir/migration.out"
fixture_user=""
fixture_order=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$qa_db_user" -d "$qa_db_name" "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  set +e
  cleanup_failed=0
  cleanup_remaining=""

  if [[ "$fixture_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$fixture_order" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.orders
       where order_uuid = '$fixture_order'::uuid
          or user_id = '$fixture_user'::uuid;
      delete from auth.users where id = '$fixture_user'::uuid;
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.orders
             where order_uuid = '$fixture_order'::uuid
                or user_id = '$fixture_user'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id = '$fixture_user'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id = '$fixture_user'::uuid
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id = '$fixture_user'::uuid
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi

  rm -f "$migration_output"
  if (( cleanup_failed != 0 )); then
    echo "payment evidence contract gate QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  rm -f "$qa_tmp_dir/cleanup.out"
  if ! rmdir "$qa_tmp_dir" >/dev/null 2>&1; then
    cleanup_failed=1
    echo "payment evidence contract gate QA temp cleanup failed" >&2
  fi

  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "payment evidence contract gate QA failed: $*" >&2
  if [[ -s "$migration_output" ]]; then
    awk '/(^|: )ERROR:  / { print }' "$migration_output" >&2
  fi
  exit 1
}

catalog_ok="$(
  db_value "
    select (
      pg_catalog.to_regclass('public.orders') is not null
      and pg_catalog.to_regprocedure(
        'public.bp_rollout_compatibility_enabled(text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
      ) is not null
      and exists (
        select 1
          from pg_catalog.pg_constraint c
         where c.conrelid = 'public.orders'::regclass
           and c.conname = 'orders_payment_evidence_snapshot_check'
           and c.contype = 'c'
           and c.convalidated
      )
      and exists (
        select 1
          from pg_catalog.pg_trigger t
         where t.tgrelid = 'public.orders'::regclass
           and t.tgname = 'trg_orders_payment_evidence_snapshot'
           and not t.tgisinternal
           and t.tgenabled = 'O'
           and t.tgtype = 19
           and t.tgfoid =
                 'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
           and t.tgattr = (
             select pg_catalog.string_agg(
                      a.attnum::text,
                      ' '
                      order by a.attnum
                    )::pg_catalog.int2vector
               from pg_catalog.pg_attribute a
              where a.attrelid = 'public.orders'::regclass
                and a.attname in (
                  'expected_store_id',
                  'expected_currency',
                  'expected_channel_key'
                )
                and not a.attisdropped
           )
      )
      and exists (
        select 1
          from pg_catalog.pg_proc p
         where p.oid =
                 'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
           and p.prosecdef
           and p.proconfig = array['search_path=\"\"']::text[]
           and pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) =
                 '048f737fe9b3bea8393389935a1aa31e'
           and not pg_catalog.has_function_privilege(
             'public',
             'public.bp_guard_order_payment_evidence_snapshot()',
             'EXECUTE'
           )
           and not pg_catalog.has_function_privilege(
             'anon',
             'public.bp_guard_order_payment_evidence_snapshot()',
             'EXECUTE'
           )
           and not pg_catalog.has_function_privilege(
             'authenticated',
             'public.bp_guard_order_payment_evidence_snapshot()',
             'EXECUTE'
           )
           and not pg_catalog.has_function_privilege(
             'service_role',
             'public.bp_guard_order_payment_evidence_snapshot()',
             'EXECUTE'
           )
      )
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "008899 payment evidence expand catalog is not applied"

read_rollout_stage() {
  db_value "
    select case
      when public.bp_rollout_compatibility_enabled(
             'legacy_score_submission'
           )
       and public.bp_rollout_compatibility_enabled(
             'legacy_generation_transition'
           )
       and public.bp_rollout_compatibility_enabled(
             'legacy_checkout_reuse'
           )
       and public.bp_rollout_compatibility_enabled(
             'legacy_account_reactivation'
           )
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
             'EXECUTE'
           )
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
             'EXECUTE'
           )
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
             'EXECUTE'
           )
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
           ) is null
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
           ) is not null
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
             'EXECUTE'
           )
       and not pg_catalog.has_function_privilege(
             'anon',
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
             'EXECUTE'
           )
       and not pg_catalog.has_function_privilege(
             'authenticated',
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
             'EXECUTE'
           )
       and not exists (
             select 1
               from pg_catalog.pg_constraint c
              where c.conrelid = 'public.orders'::regclass
                and c.conname =
                      'orders_portone_payment_evidence_required_check'
           )
        then 'expand'
      when not public.bp_rollout_compatibility_enabled(
                 'legacy_score_submission'
               )
       and not public.bp_rollout_compatibility_enabled(
                 'legacy_generation_transition'
               )
       and not public.bp_rollout_compatibility_enabled(
                 'legacy_checkout_reuse'
               )
       and not public.bp_rollout_compatibility_enabled(
                 'legacy_account_reactivation'
               )
       and not pg_catalog.has_function_privilege(
                 'service_role',
                 'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
                 'EXECUTE'
               )
       and pg_catalog.to_regprocedure(
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
           ) is null
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
             'EXECUTE'
           )
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
           ) is null
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
           ) is null
       and exists (
             select 1
               from pg_catalog.pg_constraint c
              where c.conrelid = 'public.orders'::regclass
                and c.conname =
                      'orders_portone_payment_evidence_required_check'
                and c.contype = 'c'
                and c.convalidated
           )
        then 'contract'
      else 'unknown'
    end;
  "
}

rollout_stage="$(read_rollout_stage)"
if [[ "$rollout_stage" == "contract" ]]; then
  echo \
    "payment evidence contract gate QA is expand-only; detected 0092 contract stage" \
    >&2
  echo \
    "run it after qa:db:apply:expand and before qa:db:apply:contract" \
    >&2
  exit 2
fi
[[ "$rollout_stage" == "expand" ]] \
  || fail "database is neither the exact 008899 expand nor 0092 contract stage"

preexisting_blockers="$(
  db_value "
    select (
      select pg_catalog.count(*)
        from public.orders o
       where (
               o.expected_store_id is null
               or o.expected_currency is null
               or o.expected_channel_key is null
             )
         and (
               o.expected_store_id is not null
               or o.expected_currency is not null
               or o.expected_channel_key is not null
             )
    )::text
    || '|'
    || (
      select pg_catalog.count(*)
        from public.orders o
       where o.provider = 'portone'
         and o.payment_id is null
    )::text
    || '|'
    || (
      select pg_catalog.count(*)
        from public.orders o
       where o.provider = 'portone'
         and o.payment_id is not null
         and o.expected_store_id is null
         and o.expected_currency is null
         and o.expected_channel_key is null
    )::text;
  "
)"
[[ "$preexisting_blockers" == "0|0|0" ]] \
  || fail "database already contains a payment evidence contract blocker"

fixture_user="$(db_value "select pg_catalog.gen_random_uuid();")"
fixture_order="$(db_value "select pg_catalog.gen_random_uuid();")"
[[ "$fixture_user" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "PostgreSQL returned an invalid fixture user UUID"
[[ "$fixture_order" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "PostgreSQL returned an invalid fixture order UUID"

fixture_email="payment-contract-$fixture_user@test.local"
fixture_payment_id="${fixture_order//-/}"
expected_error="0090 contract: legacy PortOne payment evidence backfill remains"

emit_fixture_transaction() {
  printf '%s\n' \
    "begin;" \
    "insert into auth.users(id, email) values (" \
    "  '$fixture_user'::uuid, '$fixture_email'" \
    ");" \
    "insert into public.member_accounts(" \
    "  user_id, gen_credits, email, is_admin" \
    ") values (" \
    "  '$fixture_user'::uuid, 0, '$fixture_email', false" \
    ");" \
    "insert into public.orders(" \
    "  order_uuid, user_id, product_id, amount, credits, status," \
    "  provider, payment_id, is_test, pay_channel," \
    "  expected_store_id, expected_currency, expected_channel_key" \
    ") values (" \
    "  '$fixture_order'::uuid," \
    "  '$fixture_user'::uuid," \
    "  'qa_payment_evidence_contract_gate'," \
    "  1900, 3, 'pending', 'portone', '$fixture_payment_id'," \
    "  true, 'card', null, null, null" \
    ");" \
    "do \$qa\$" \
    "begin" \
    "  if not exists (" \
    "    select 1" \
    "      from auth.users u" \
    "      join public.profiles p on p.id = u.id" \
    "      join public.member_accounts m on m.user_id = u.id" \
    "     where u.id = '$fixture_user'::uuid" \
    "       and p.deleted_at is null" \
    "       and pg_catalog.lower(pg_catalog.btrim(m.email)) =" \
    "             pg_catalog.lower(pg_catalog.btrim('$fixture_email'))" \
    "  ) or not exists (" \
    "    select 1" \
    "      from public.orders o" \
    "     where o.order_uuid = '$fixture_order'::uuid" \
    "       and o.user_id = '$fixture_user'::uuid" \
    "       and o.status = 'pending'" \
    "       and o.provider = 'portone'" \
    "       and o.payment_id = '$fixture_payment_id'" \
    "       and o.expected_store_id is null" \
    "       and o.expected_currency is null" \
    "       and o.expected_channel_key is null" \
    "  ) then" \
    "    raise exception 'payment_evidence_contract_gate_fixture_invalid';" \
    "  end if;" \
    "end;" \
    "\$qa\$;"
}

# Put the fixture and the unmodified 0090 source in one outer transaction.
# 0090's own BEGIN is intentionally nested: its expected gate error makes psql
# disconnect with the transaction aborted, so fixture disappearance proves the
# whole attempted contract rolled back instead of merely checking catalog state.
set +e
{
  emit_fixture_transaction
  command sed -n '1,$p' "$migration_file"
} | db_psql -v VERBOSITY=terse >"$migration_output" 2>&1
migration_status=$?
set -e

(( migration_status != 0 )) \
  || fail "0090 unexpectedly succeeded with a legacy evidence fixture"

actual_errors="$(
  awk '
    /^ERROR:  / {
      sub(/^ERROR:  /, "")
      print
      next
    }
    /^psql:<stdin>:[0-9]+: ERROR:  / {
      sub(/^psql:<stdin>:[0-9]+: ERROR:  /, "")
      print
    }
  ' "$migration_output"
)"
[[ "$actual_errors" == "$expected_error" ]] \
  || fail "0090 failed for an unexpected reason"

fixture_counts="$(
  db_value "
    select
      (select pg_catalog.count(*) from auth.users
        where id = '$fixture_user'::uuid)::text
      || '|'
      || (select pg_catalog.count(*) from public.profiles
        where id = '$fixture_user'::uuid)::text
      || '|'
      || (select pg_catalog.count(*) from public.member_accounts
        where user_id = '$fixture_user'::uuid)::text
      || '|'
      || (select pg_catalog.count(*) from public.orders
        where order_uuid = '$fixture_order'::uuid
           or user_id = '$fixture_user'::uuid)::text;
  "
)"
[[ "$fixture_counts" == "0|0|0|0" ]] \
  || fail "the failed 0090 transaction did not roll back every fixture row"

rollout_stage="$(read_rollout_stage)"
[[ "$rollout_stage" == "expand" ]] \
  || fail "the failed 0090 transaction did not preserve the exact expand stage"

echo "payment evidence contract gate QA passed:"
echo "  expected blocker rejected with the exact 0090 error"
echo "  outer transaction rolled back auth/profile/member/order fixtures"
echo "  compatibility remains enabled and required evidence constraint is absent"
