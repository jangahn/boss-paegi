#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="supabase_db_${project_id}"
db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ -z "$project_id" ]] \
  || [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase DB container is not running" >&2
  exit 1
fi
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 1
fi
if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required for the local Auth API contract" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for the local Auth API contract" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-reactivation-auth-api.XXXXXX"
)"
fixture_ids=()

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
  if (( ${#fixture_ids[@]} > 0 )); then
    ids_sql="$(
      printf "'%s'::uuid," "${fixture_ids[@]}"
    )"
    ids_sql="${ids_sql%,}"
    if ! db_psql -q -c "
      begin;
      alter table public.account_reactivation_jobs
        disable trigger trg_account_reactivation_jobs_guard;
      delete from public.account_reactivation_jobs
       where user_id in ($ids_sql);
      alter table public.account_reactivation_jobs
        enable trigger trg_account_reactivation_jobs_guard;
      alter table public.admin_mutation_requests
        disable trigger trg_admin_mutation_requests_guard;
      delete from public.admin_mutation_requests
       where target_key in (
         select id::text
           from pg_catalog.unnest(
             array[$ids_sql]::uuid[]
           ) as ids(id)
       );
      alter table public.admin_mutation_requests
        enable trigger trg_admin_mutation_requests_guard;
      alter table public.account_reactivation_legacy_repairs
        disable trigger trg_account_reactivation_legacy_repairs_guard;
      delete from public.account_reactivation_legacy_repairs
       where user_id in ($ids_sql)
          or admin_user_id in ($ids_sql);
      alter table public.account_reactivation_legacy_repairs
        enable trigger trg_account_reactivation_legacy_repairs_guard;
      delete from public.account_admin_actions_ledger
       where target_user_id in ($ids_sql)
          or admin_user_id in ($ids_sql);
      delete from public.account_deletion_cleanup_jobs
       where user_id in ($ids_sql);
      delete from auth.identities where user_id in ($ids_sql);
      delete from public.member_accounts where user_id in ($ids_sql);
      delete from public.profiles where id in ($ids_sql);
      delete from auth.users where id in ($ids_sql);
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.account_reactivation_jobs
             where user_id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from public.admin_mutation_requests
             where target_key in (
               select id::text
                 from pg_catalog.unnest(
                   array[$ids_sql]::uuid[]
                 ) as ids(id)
             )
          )
          + (
            select pg_catalog.count(*)
              from public.account_reactivation_legacy_repairs
             where user_id in ($ids_sql)
                or admin_user_id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from public.account_admin_actions_ledger
             where target_user_id in ($ids_sql)
                or admin_user_id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from public.account_deletion_cleanup_jobs
             where user_id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from auth.identities
             where user_id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in ($ids_sql)
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in ($ids_sql)
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "reactivation Auth API QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  if [[ -d "$qa_tmp_dir" \
    && "$qa_tmp_dir" == */boss-paegi-reactivation-auth-api.* ]]; then
    rm -rf "$qa_tmp_dir"
  fi
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

if ! status_json="$(supabase status -o json 2>/dev/null)"; then
  echo "could not read disposable local Supabase status" >&2
  exit 1
fi
qa_api_url="$(jq -er '.API_URL' <<<"$status_json")"
qa_service_key="$(jq -er '.SERVICE_ROLE_KEY' <<<"$status_json")"
unset status_json
if [[ ! "$qa_api_url" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]] \
  || [[ -z "$qa_service_key" ]]; then
  echo "local Supabase API URL/service key is unavailable" >&2
  exit 1
fi

new_uuid() {
  db_value "select pg_catalog.gen_random_uuid();"
}

admin_id="$(new_uuid)"
activate_user_id="$(new_uuid)"
cancel_user_id="$(new_uuid)"
stale_user_id="$(new_uuid)"
third_user_id="$(new_uuid)"
activate_request_id="$(new_uuid)"
cancel_request_id="$(new_uuid)"
stale_request_id="$(new_uuid)"
third_request_id="$(new_uuid)"
fixture_ids=(
  "$admin_id"
  "$activate_user_id"
  "$cancel_user_id"
  "$stale_user_id"
  "$third_user_id"
)
deleted_at="2026-07-22 01:02:03+00"
activate_real_email="restored-activate-$activate_user_id@test.local"
cancel_real_email="restored-cancel-$cancel_user_id@test.local"
stale_real_email="restored-stale-$stale_user_id@test.local"
third_current_email="third-$third_user_id@test.local"
third_real_email="desired-third-$third_user_id@test.local"

for id in "${fixture_ids[@]}" \
  "$activate_request_id" "$cancel_request_id" \
  "$stale_request_id" "$third_request_id"; do
  if [[ ! "$id" =~ ^[0-9a-f-]{36}$ ]]; then
    echo "PostgreSQL returned an invalid fixture UUID" >&2
    exit 1
  fi
done

db_psql -q -c "
  insert into auth.users(
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000'::uuid,
      '$admin_id'::uuid,
      'authenticated',
      'authenticated',
      'auth-api-admin-$admin_id@test.local',
      '',
      clock_timestamp(),
      '',
      '',
      '',
      '',
      '{\"provider\":\"email\"}'::jsonb,
      '{}'::jsonb,
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000'::uuid,
      '$activate_user_id'::uuid,
      'authenticated',
      'authenticated',
      'deleted+$activate_user_id@deleted.invalid',
      '',
      clock_timestamp(),
      '',
      '',
      '',
      '',
      '{
        \"provider\":\"email\",
        \"providers\":[\"email\",\"google\"],
        \"keep\":\"activate\"
      }'::jsonb,
      '{}'::jsonb,
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000'::uuid,
      '$cancel_user_id'::uuid,
      'authenticated',
      'authenticated',
      'deleted+$cancel_user_id@deleted.invalid',
      '',
      clock_timestamp(),
      '',
      '',
      '',
      '',
      '{
        \"provider\":\"email\",
        \"providers\":[\"email\",\"google\"],
        \"keep\":\"cancel\"
      }'::jsonb,
      '{}'::jsonb,
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000'::uuid,
      '$stale_user_id'::uuid,
      'authenticated',
      'authenticated',
      'deleted+$stale_user_id@deleted.invalid',
      '',
      clock_timestamp(),
      '',
      '',
      '',
      '',
      '{
        \"provider\":\"email\",
        \"providers\":[\"email\",\"google\"],
        \"keep\":\"stale\"
      }'::jsonb,
      '{}'::jsonb,
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000'::uuid,
      '$third_user_id'::uuid,
      'authenticated',
      'authenticated',
      '$third_current_email',
      '',
      clock_timestamp(),
      '',
      '',
      '',
      '',
      '{
        \"provider\":\"email\",
        \"providers\":[\"email\",\"google\"],
        \"keep\":\"third\"
      }'::jsonb,
      '{}'::jsonb,
      clock_timestamp(),
      clock_timestamp()
    );

  insert into public.member_accounts(
    user_id, gen_credits, email, is_admin
  ) values
    (
      '$admin_id'::uuid,
      0,
      'auth-api-admin-$admin_id@test.local',
      true
    ),
    ('$activate_user_id'::uuid, 0, null, false),
    ('$cancel_user_id'::uuid, 0, null, false),
    ('$stale_user_id'::uuid, 0, null, false),
    ('$third_user_id'::uuid, 0, null, false);

  update public.profiles
     set deleted_at = '$deleted_at'::timestamptz,
         display_name = '탈퇴한 사용자'
   where id in (
     '$activate_user_id'::uuid,
     '$cancel_user_id'::uuid,
     '$stale_user_id'::uuid,
     '$third_user_id'::uuid
   );

  insert into auth.identities(
    provider_id,
    user_id,
    identity_data,
    provider,
    created_at,
    updated_at
  ) values
    (
      '$activate_user_id',
      '$activate_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', '$activate_user_id',
        'email', 'deleted+$activate_user_id@deleted.invalid',
        'email_verified', true,
        'stable', pg_catalog.jsonb_build_object('kind', 'email')
      ),
      'email',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      'google-$activate_user_id',
      '$activate_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', 'google-$activate_user_id',
        'email', '$activate_real_email',
        'email_verified', true,
        'name', 'Activate QA',
        'avatar_url', 'https://example.test/activate.png',
        'stable', pg_catalog.jsonb_build_object(
          'provider_uid', 'activate-google'
        )
      ),
      'google',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '$cancel_user_id',
      '$cancel_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', '$cancel_user_id',
        'email', 'deleted+$cancel_user_id@deleted.invalid',
        'email_verified', true,
        'stable', pg_catalog.jsonb_build_object('kind', 'email')
      ),
      'email',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      'google-$cancel_user_id',
      '$cancel_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', 'google-$cancel_user_id',
        'email', '$cancel_real_email',
        'email_verified', true,
        'name', 'Cancel OAuth',
        'avatar_url', 'https://example.test/cancel.png',
        'stable', pg_catalog.jsonb_build_object(
          'provider_uid', 'cancel-google'
        )
      ),
      'google',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '$stale_user_id',
      '$stale_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', '$stale_user_id',
        'email', 'deleted+$stale_user_id@deleted.invalid',
        'email_verified', true,
        'stable', pg_catalog.jsonb_build_object('kind', 'email')
      ),
      'email',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      'google-$stale_user_id',
      '$stale_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', 'google-$stale_user_id',
        'email', '$stale_real_email',
        'email_verified', true,
        'name', 'Stale OAuth',
        'avatar_url', 'https://example.test/stale.png',
        'stable', pg_catalog.jsonb_build_object(
          'provider_uid', 'stale-google'
        )
      ),
      'google',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      '$third_user_id',
      '$third_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', '$third_user_id',
        'email', '$third_current_email',
        'email_verified', true,
        'stable', pg_catalog.jsonb_build_object('kind', 'email')
      ),
      'email',
      clock_timestamp(),
      clock_timestamp()
    ),
    (
      'google-$third_user_id',
      '$third_user_id'::uuid,
      pg_catalog.jsonb_build_object(
        'sub', 'google-$third_user_id',
        'email', '$third_current_email',
        'email_verified', true,
        'name', 'Third OAuth',
        'avatar_url', 'https://example.test/third.png',
        'stable', pg_catalog.jsonb_build_object(
          'provider_uid', 'third-google'
        )
      ),
      'google',
      clock_timestamp(),
      clock_timestamp()
    );
" >/dev/null

profile_generation() {
  db_value "
    select withdrawal_generation
      from public.profiles
     where id = '$1'::uuid;
  "
}

activate_generation="$(profile_generation "$activate_user_id")"
cancel_generation="$(profile_generation "$cancel_user_id")"
stale_generation="$(profile_generation "$stale_user_id")"
third_generation="$(profile_generation "$third_user_id")"

begin_and_arm() {
  local user_id="$1"
  local request_id="$2"
  local resolved_email="$3"
  local expected_generation="$4"
  db_psql -q -c "
    begin;
    select public.admin_begin_account_reactivation(
      '$user_id'::uuid,
      '$admin_id'::uuid,
      'local Auth API contract',
      '$resolved_email',
      '$deleted_at'::timestamptz,
      $expected_generation,
      '$request_id'::uuid
    );
    select public.claim_account_reactivation_job(
      '$request_id'::uuid,
      '$admin_id'::uuid,
      '$user_id'::uuid,
      120
    );
    select public.arm_account_reactivation_auth_fence(
      j.request_id,
      j.admin_user_id,
      j.user_id,
      j.lease_token,
      j.lease_version
    )
      from public.account_reactivation_jobs j
     where j.request_id = '$request_id'::uuid;
    commit;
  " >/dev/null
}

auth_step() {
  QA_LOCAL_SUPABASE_URL="$qa_api_url" \
  QA_LOCAL_SUPABASE_SERVICE_ROLE_KEY="$qa_service_key" \
    node scripts/qa/reactivation-auth-api-step.mjs "$@"
}

begin_and_arm \
  "$activate_user_id" "$activate_request_id" \
  "$activate_real_email" "$activate_generation"
auth_step \
  "$activate_user_id" \
  "$activate_real_email" \
  success \
  "deleted+$activate_user_id@deleted.invalid" \
  activate \
  activate
db_psql -q -c "
  select public.finish_account_reactivation_job(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version,
    true,
    null
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$activate_request_id'::uuid;
" >/dev/null
activation_state="$(
  db_value "
    select case
      when j.status = 'completed'
       and r.state = 'completed'
       and (r.result->>'accountReactivated')::boolean
       and p.deleted_at is null
       and p.display_name = 'Activate QA'
       and p.avatar_url = 'https://example.test/activate.png'
       and m.email = '$activate_real_email'
       and m.age_confirmed_at is null
       and m.terms_agreed_at is null
       and m.privacy_agreed_at is null
       and u.email = '$activate_real_email'
       and u.raw_app_meta_data->>'keep' = 'activate'
       and not (
         coalesce(u.raw_app_meta_data, '{}'::jsonb)
           ? 'bp_reactivation_fence'
       )
       and (
         select pg_catalog.count(*)
           from auth.identities i
          where i.user_id = '$activate_user_id'::uuid
       ) = 2
       and exists (
         select 1
           from auth.identities i
          where i.user_id = '$activate_user_id'::uuid
            and i.provider = 'email'
            and i.identity_data->>'email' = '$activate_real_email'
       )
       and exists (
         select 1
           from auth.identities i
          where i.user_id = '$activate_user_id'::uuid
            and i.provider = 'google'
            and i.identity_data->>'email' = '$activate_real_email'
            and i.identity_data->'stable'->>'provider_uid' =
                  'activate-google'
       )
       and (
         select pg_catalog.count(*)
           from public.account_admin_actions_ledger l
         where l.target_user_id = '$activate_user_id'::uuid
            and l.action_type = 'account_reactivate'
            and l.metadata->>'restored_email' =
                  '$activate_real_email'
            and l.metadata->>'restored_name' = 'Activate QA'
            and l.metadata->>'provider' = 'email'
            and l.metadata->>'email_source' = 'identity'
       ) = 1
       and not exists (
         select 1
           from public.account_reactivation_legacy_repairs x
          where x.user_id = '$activate_user_id'::uuid
       )
      then 'completed'
      else 'invalid'
    end
      from public.account_reactivation_jobs j
      join public.admin_mutation_requests r
        on r.request_id = j.request_id
      join public.profiles p on p.id = j.user_id
      join public.member_accounts m on m.user_id = j.user_id
      join auth.users u on u.id = j.user_id
     where j.request_id = '$activate_request_id'::uuid;
  "
)"
if [[ "$activation_state" != "completed" ]]; then
  echo "local Auth activation terminal state is invalid" >&2
  exit 1
fi

begin_and_arm \
  "$cancel_user_id" "$cancel_request_id" \
  "$cancel_real_email" "$cancel_generation"
auth_step \
  "$cancel_user_id" \
  "$cancel_real_email" \
  success \
  "deleted+$cancel_user_id@deleted.invalid" \
  activate \
  cancel
db_psql -q -c "
  select public.request_account_reactivation_cancellation(
    '$cancel_request_id'::uuid,
    '$cancel_user_id'::uuid,
    '$admin_id'::uuid,
    'local Auth API cancellation',
    '$deleted_at'::timestamptz,
    $cancel_generation
  );
  select public.claim_account_reactivation_job(
    '$cancel_request_id'::uuid,
    '$admin_id'::uuid,
    '$cancel_user_id'::uuid,
    120
  );
  select public.arm_account_reactivation_auth_fence(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$cancel_request_id'::uuid;
" >/dev/null
auth_step \
  "$cancel_user_id" \
  "deleted+$cancel_user_id@deleted.invalid" \
  success \
  "$cancel_real_email" \
  cancel \
  cancel
db_psql -q -c "
  select public.finish_account_reactivation_job(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version,
    true,
    null
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$cancel_request_id'::uuid;
" >/dev/null

begin_and_arm \
  "$stale_user_id" "$stale_request_id" \
  "$stale_real_email" "$stale_generation"
db_psql -q -c "
  select public.request_account_reactivation_cancellation(
    '$stale_request_id'::uuid,
    '$stale_user_id'::uuid,
    '$admin_id'::uuid,
    'invalidate stale Auth lease',
    '$deleted_at'::timestamptz,
    $stale_generation
  );
" >/dev/null
auth_step \
  "$stale_user_id" \
  "$stale_real_email" \
  error \
  "deleted+$stale_user_id@deleted.invalid" \
  activate \
  stale
db_psql -q -c "
  select public.claim_account_reactivation_job(
    '$stale_request_id'::uuid,
    '$admin_id'::uuid,
    '$stale_user_id'::uuid,
    120
  );
  select public.arm_account_reactivation_auth_fence(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$stale_request_id'::uuid;
  select public.finish_account_reactivation_job(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version,
    true,
    null
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$stale_request_id'::uuid;
" >/dev/null

db_psql -q -c "
  select public.admin_begin_account_reactivation(
    '$third_user_id'::uuid,
    '$admin_id'::uuid,
    'third identity must survive',
    '$third_real_email',
    '$deleted_at'::timestamptz,
    $third_generation,
    '$third_request_id'::uuid
  );
  select public.claim_account_reactivation_job(
    '$third_request_id'::uuid,
    '$admin_id'::uuid,
    '$third_user_id'::uuid,
    120
  );
  select public.arm_account_reactivation_auth_fence(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$third_request_id'::uuid;
" >/dev/null
auth_step \
  "$third_user_id" \
  "$third_real_email" \
  error \
  "$third_current_email" \
  activate \
  third
db_psql -q -c "
  select public.finish_account_reactivation_job(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version,
    false,
    'auth_identity_conflict'
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$third_request_id'::uuid;
" >/dev/null

terminal_state="$(
  db_value "
    select pg_catalog.string_agg(
      j.status || ':' ||
      case
        when coalesce(u.raw_app_meta_data, '{}'::jsonb)
               ? 'bp_reactivation_fence'
        then 'fenced'
        else 'scrubbed'
      end,
      ',' order by j.user_id
    )
      from public.account_reactivation_jobs j
      join auth.users u on u.id = j.user_id
     where j.user_id in (
       '$cancel_user_id'::uuid,
       '$stale_user_id'::uuid
     );
  "
)"
if [[ "$terminal_state" != "cancelled:scrubbed,cancelled:scrubbed" ]]; then
  echo "local Auth cancellation terminal state is invalid" >&2
  exit 1
fi

echo "reactivation local Auth Admin API QA passed: end-to-end activate, cancel, stale rollback, exact-fence third-real rollback"
