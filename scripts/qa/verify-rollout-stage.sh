#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

stage="${1:-}"
if [[ "$stage" != "expand" && "$stage" != "contract" ]] || (( $# != 1 )); then
  echo "usage: $0 <expand|contract>" >&2
  exit 2
fi

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="supabase_db_${project_id}"
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
  exit 2
fi
if [[ "$db_name" != "postgres" ]]; then
  echo "rollout stage QA requires the local PostgREST database named postgres" >&2
  exit 2
fi

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

fail() {
  echo "rollout $stage stage QA failed: $*" >&2
  exit 1
}

run_expand_sql() {
  db_psql -Aqt <<'SQL'
begin;

create function pg_temp.qa_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $qa$
begin
  if p_condition is distinct from true then
    raise exception 'rollout expand assertion failed: %', p_message;
  end if;
end;
$qa$;

select pg_temp.qa_assert(
  exists (
    select 1
      from public.schema_migration_journal j
     where j.version = '008900_public_write_quotas'
  )
  and pg_catalog.to_regclass(
        'public.public_write_quota_buckets'
      ) is not null
  and pg_catalog.to_regclass(
        'public.public_write_attempts'
      ) is not null
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.record_public_analytics_event(text,text,jsonb)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
        'EXECUTE'
      )
  and not pg_catalog.has_table_privilege(
        'service_role', 'public.analytics_events', 'INSERT'
      )
  and not pg_catalog.has_table_privilege(
        'service_role', 'public.content_reports', 'INSERT'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.bp_probe_score_write_replay(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb)',
        'EXECUTE'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.bp_consume_report_legacy_write_quota()',
        'EXECUTE'
      )
  and not pg_catalog.has_table_privilege(
        'service_role',
        'public.public_write_quota_buckets',
        'SELECT,INSERT,UPDATE,DELETE'
      )
  and not pg_catalog.has_table_privilege(
        'service_role',
        'public.public_write_attempts',
        'SELECT,INSERT,UPDATE,DELETE'
      ),
  '008900 bounded public write surface must be applied before app rollout'
);

select pg_temp.qa_assert(
  public.bp_rollout_compatibility_enabled('legacy_score_submission'),
  'legacy score compatibility flag must be enabled'
);
select pg_temp.qa_assert(
  public.bp_rollout_compatibility_enabled('legacy_generation_transition'),
  'legacy generation compatibility flag must be enabled'
);
select pg_temp.qa_assert(
  public.bp_rollout_compatibility_enabled('legacy_checkout_reuse'),
  'legacy checkout compatibility flag must be enabled'
);
select pg_temp.qa_assert(
  not pg_catalog.has_function_privilege(
    'service_role',
    'public.bp_rollout_compatibility_enabled(text)',
    'EXECUTE'
  ),
  'rollout switch must remain private'
);

do $qa$
declare
  v_table text;
  v_signature text;
begin
  foreach v_table in array array[
    'admin_actions_ledger',
    'ai_generations',
    'analytics_events',
    'analytics_rollups',
    'app_settings',
    'app_settings_audit',
    'credit_ledger',
    'credit_lots',
    'dolls',
    'events',
    'legal_documents',
    'member_accounts',
    'order_refund_attempts',
    'orders',
    'profiles',
    'reconciliation_issues',
    'refund_requests',
    'reviewer_accounts',
    'score_flags',
    'score_highlights',
    'score_stats',
    'scores',
    'telemetry_rollups',
    'telemetry_sessions',
    'user_badges'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regclass('public.' || v_table) is not null,
      'server read table missing: ' || v_table
    );
    perform pg_temp.qa_assert(
      pg_catalog.has_table_privilege(
        'service_role',
        'public.' || v_table,
        'SELECT'
      ),
      'service read grant missing: ' || v_table
    );
  end loop;

  foreach v_signature in array array[
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'public.admin_adjust_credits(uuid,uuid,integer,text)',
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid)',
    'public.admin_publish_legal(text,date,uuid)',
    'public.admin_unpublish_legal(text,uuid)',
    'public.admin_update_app_setting(text,jsonb,integer,uuid,text)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_publish_event(uuid,uuid)',
    'public.admin_unpublish_event(uuid,uuid)',
    'public.admin_delete_event(uuid,uuid)',
    'public.admin_clear_score(uuid,uuid,text)',
    'public.admin_void_score(uuid,uuid,text)',
    'public.admin_ban_member(uuid,uuid,text)',
    'public.admin_unban_member(uuid,uuid,text)',
    'public.admin_takedown_doll(uuid,uuid,text)',
    'public.admin_dismiss_doll(uuid,uuid,text)',
    'public.admin_restore_doll(uuid,uuid,text)',
    'public.admin_begin_doll_purge(uuid,uuid,text)',
    'public.admin_reactivate_account(uuid,uuid,text,text)',
    'public.admin_settle_stuck_order(uuid,uuid,text)',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regprocedure(v_signature) is not null,
      'legacy RPC missing: ' || v_signature
    );
    perform pg_temp.qa_assert(
      pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(v_signature),
        'EXECUTE'
      ),
      'legacy RPC not executable during expand: ' || v_signature
    );
  end loop;

  foreach v_signature in array array[
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
    'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
    'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
    'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
    'public.get_admin_mutation_receipt(uuid,uuid,text,text)',
    'public.admin_update_app_setting_idempotent(text,jsonb,integer,uuid,text,uuid)',
    'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
    'public.get_moderation_purge_status(uuid,uuid,uuid)',
    'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
    'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
    'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])',
    'public.expire_generation(uuid,integer)',
    'public.claim_generation_submit_intent(uuid,uuid,integer,text,text)',
    'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regprocedure(v_signature) is not null,
      'new RPC missing: ' || v_signature
    );
    perform pg_temp.qa_assert(
      pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(v_signature),
        'EXECUTE'
      ),
      'new RPC not executable during expand: ' || v_signature
    );
  end loop;
end;
$qa$;

select pg_temp.qa_assert(
  pg_catalog.to_regprocedure(
    'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
  ) is null,
  'superseded seven-argument payment evidence backfill must be absent'
);

select pg_temp.qa_assert(
  pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'UPDATE'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'DELETE'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'UPDATE'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.content_reports', 'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'UPDATE'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'DELETE'
  ),
  'old-server direct DML compatibility must remain open'
);
select pg_temp.qa_assert(
  pg_catalog.has_table_privilege(
    'authenticated', 'public.dolls', 'DELETE'
  )
  and exists (
    select 1
      from pg_catalog.pg_policy
     where polrelid = 'public.dolls'::regclass
       and polcmd = 'd'
  ),
  'old browser doll delete must remain fenced and available'
);
select pg_temp.qa_assert(
  pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'id', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'owner_id', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'image_url', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'style_meta', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'role', 'INSERT'
  ),
  'new intent-fenced doll persistence columns must be available'
);

do $qa$
declare
  v_user uuid := pg_catalog.gen_random_uuid();
  v_new_submission uuid := pg_catalog.gen_random_uuid();
  v_legacy_session uuid := pg_catalog.gen_random_uuid();
  v_old_telemetry_ack jsonb;
  v_old_telemetry_retry jsonb;
  v_new_ack jsonb;
  v_generation uuid;
  v_expiry_generation uuid;
  v_rpc_expiry_generation uuid;
  v_generation_ack jsonb;
begin
  insert into auth.users(id, email)
  values (
    v_user,
    'rollout-expand-' || v_user::text || '@test.local'
  );
  insert into public.member_accounts(user_id, gen_credits)
  values (v_user, 3)
  on conflict (user_id) do update set gen_credits = excluded.gen_credits;

  begin
    perform public.submit_score_with_review(
      v_user,
      null,
      100,
      'fist',
      1000,
      1,
      'normal',
      null,
      'registered',
      '[]'::jsonb,
      '{}'::jsonb,
      0,
      'qa-rollout-old'
    );
    raise exception 'unsafe old score shape unexpectedly committed';
  exception
    when sqlstate 'P0001' then
      perform pg_temp.qa_assert(
        sqlerrm = 'client_upgrade_required',
        'old score without either stable identity must fail closed'
      );
  end;
  perform pg_temp.qa_assert(
    not exists (
      select 1
        from public.scores s
       where s.owner_id = v_user
    ),
    'rejected identity-free old score must leave no row'
  );

  update public.telemetry_budget
     set degrade_mode = 'full',
         over_budget = false,
         new_sessions_today = 0,
         day_kst = (pg_catalog.now() at time zone 'Asia/Seoul')::date
   where id = true;
  perform pg_temp.qa_assert(
    (
      public.ingest_telemetry_delta(
        v_legacy_session,
        v_user,
        true,
        pg_catalog.jsonb_build_object(
          'deviceClass', 'desktop-pointer',
          'summary', pg_catalog.jsonb_build_object(
            'seqHigh', 1,
            'durationMs', 1000,
            'totals', pg_catalog.jsonb_build_object(
              'score', 102,
              'hitCount', 1,
              'maxCombo', 1
            )
          ),
          'events', '[]'::jsonb
        )
      )->>'ok'
    ) = 'true',
    'old telemetry protocol must remain available'
  );
  v_old_telemetry_ack := public.submit_score_with_review(
    v_user,
    null,
    102,
    'fist',
    1000,
    1,
    'normal',
    v_legacy_session,
    'registered',
    '[]'::jsonb,
    '{}'::jsonb,
    0,
    'qa-rollout-old-telemetry'
  );
  v_old_telemetry_retry := public.submit_score_with_review(
    v_user,
    null,
    102,
    'fist',
    1000,
    1,
    'normal',
    v_legacy_session,
    'registered',
    '[]'::jsonb,
    '{}'::jsonb,
    0,
    'qa-rollout-old-telemetry'
  );
  perform pg_temp.qa_assert(
    v_old_telemetry_ack->>'duplicate' = 'false'
    and v_old_telemetry_retry->>'duplicate' = 'true'
    and v_old_telemetry_retry->>'scoreId' =
      v_old_telemetry_ack->>'scoreId'
    and (
      select pg_catalog.count(*) = 1
        from public.scores s
       where s.telemetry_session_id = v_legacy_session
    ),
    'old telemetry-backed score response loss must converge exactly once'
  );

  v_new_ack := public.submit_score_with_review(
    v_user,
    null,
    101,
    'hammer',
    1000,
    1,
    'normal',
    null,
    'registered',
    '[]'::jsonb,
    pg_catalog.jsonb_build_object(
      'submissionId', v_new_submission,
      'submissionFingerprint', pg_catalog.repeat('a', 64)
    ),
    0,
    'qa-rollout-new'
  );
  perform pg_temp.qa_assert(
    v_new_ack->>'duplicate' = 'false'
    and exists (
      select 1
        from public.scores s
       where s.id = (v_new_ack->>'scoreId')::uuid
         and s.submission_id = v_new_submission
         and s.submission_fingerprint = pg_catalog.repeat('a', 64)
    ),
    'new score request must preserve its exact identity'
  );

  v_generation := pg_catalog.gen_random_uuid();
  insert into public.ai_generations(id, owner_id, status)
  values (v_generation, v_user, 'failed');
  update public.ai_generations
     set status = 'done'
   where id = v_generation;
  perform pg_temp.qa_assert(
    (select status = 'done'
       from public.ai_generations
      where id = v_generation),
    'old late provider recovery failed-to-done transition must converge'
  );

  v_expiry_generation := pg_catalog.gen_random_uuid();
  insert into public.ai_generations(id, owner_id, status)
  values (v_expiry_generation, v_user, 'done');
  update public.ai_generations
     set status = 'failed',
         fail_reason = 'expired'
   where id = v_expiry_generation;
  perform pg_temp.qa_assert(
    (select status = 'expired'
       from public.ai_generations
      where id = v_expiry_generation),
    'old direct done-to-failed expiry must map to expired'
  );

  v_rpc_expiry_generation := pg_catalog.gen_random_uuid();
  insert into public.ai_generations(id, owner_id, status)
  values (v_rpc_expiry_generation, v_user, 'done');
  v_generation_ack := public.mark_generation_failed_and_refund(
    v_rpc_expiry_generation,
    'expired'
  );
  perform pg_temp.qa_assert(
    v_generation_ack->>'outcome' = 'expired'
    and v_generation_ack->>'refunded' = 'false'
    and (
      select status = 'expired'
        from public.ai_generations
       where id = v_rpc_expiry_generation
    ),
    'old paid expiry RPC shape must converge without refund'
  );
end;
$qa$;

do $qa$
declare
  v_user uuid := pg_catalog.gen_random_uuid();
  v_legacy_user uuid := pg_catalog.gen_random_uuid();
  v_upgrade_user uuid := pg_catalog.gen_random_uuid();
  v_admin uuid := pg_catalog.gen_random_uuid();
  v_legacy_settle_user uuid := pg_catalog.gen_random_uuid();
  v_old_order uuid := pg_catalog.gen_random_uuid();
  v_legacy_paid_order uuid := pg_catalog.gen_random_uuid();
  v_legacy_settle_order uuid := pg_catalog.gen_random_uuid();
  v_new_candidate uuid := pg_catalog.gen_random_uuid();
  v_unique_candidate uuid := pg_catalog.gen_random_uuid();
  v_settle_request uuid := pg_catalog.gen_random_uuid();
  v_legacy_settle_paid_at timestamptz :=
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_replayed uuid;
  v_ack jsonb;
  v_error text;
begin
  insert into public.app_settings(key, value)
  values (
    'growth_levers',
    pg_catalog.jsonb_build_object(
      'products',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_rollout_checkout',
          'goodname', 'QA rollout checkout',
          'price', 1900,
          'credits', 3,
          'active', true
        )
      )
    )
  )
  on conflict (key) do update set value = excluded.value;

  insert into auth.users(id, email)
  values
  (
    v_user,
    'rollout-checkout-' || v_user::text || '@test.local'
  ),
  (
    v_legacy_user,
    'rollout-legacy-payment-' || v_legacy_user::text || '@test.local'
  ),
  (
    v_upgrade_user,
    'rollout-upgrade-required-' || v_upgrade_user::text || '@test.local'
  ),
  (
    v_admin,
    'rollout-legacy-admin-' || v_admin::text || '@test.local'
  ),
  (
    v_legacy_settle_user,
    'rollout-legacy-settle-' || v_legacy_settle_user::text ||
      '@test.local'
  );
  insert into public.member_accounts(user_id, gen_credits, is_admin)
  values
    (v_admin, 0, true),
    (v_legacy_settle_user, 0, false),
    (v_legacy_user, 0, false),
    (v_user, 0, false),
    (v_upgrade_user, 0, false)
  on conflict (user_id) do update
    set is_admin = excluded.is_admin;

  -- These rows model orders minted before the expand boundary. After 008899 the
  -- old nine-argument RPC is replay-only and must never create another
  -- all-NULL evidence snapshot.
  insert into public.orders(
    order_uuid,
    user_id,
    product_id,
    amount,
    credits,
    status,
    provider,
    payment_id,
    is_test,
    pay_channel,
    expected_store_id,
    expected_currency,
    expected_channel_key
  )
  values
  (
    v_legacy_paid_order,
    v_legacy_user,
    'qa_rollout_checkout',
    1900,
    3,
    'pending',
    'portone',
    pg_catalog.replace(v_legacy_paid_order::text, '-', ''),
    false,
    'card',
    null,
    null,
    null
  ),
  (
    v_legacy_settle_order,
    v_legacy_settle_user,
    'qa_rollout_checkout',
    1900,
    3,
    'pending',
    'portone',
    pg_catalog.replace(v_legacy_settle_order::text, '-', ''),
    false,
    'card',
    null,
    null,
    null
  ),
  (
    v_old_order,
    v_user,
    'qa_rollout_checkout',
    1900,
    3,
    'pending',
    'portone',
    pg_catalog.replace(v_old_order::text, '-', ''),
    false,
    'card',
    null,
    null,
    null
  );

  begin
    perform public.create_pending_order(
      v_upgrade_user,
      pg_catalog.gen_random_uuid(),
      'qa_rollout_checkout',
      1900,
      3,
      pg_catalog.repeat('0', 32),
      'portone',
      'card',
      false
    );
    raise exception 'old checkout minted a post-expand NULL order';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'payment_id_format' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    not exists (
      select 1 from public.orders o where o.user_id = v_upgrade_user
    ),
    'invalid old checkout evidence must not create an order'
  );

  begin
    v_replayed := public.create_pending_order(
      v_upgrade_user,
      v_new_candidate,
      'qa_rollout_checkout',
      1900,
      3,
      pg_catalog.replace(v_new_candidate::text, '-', ''),
      'portone',
      'card',
      false
    );
    raise exception 'old checkout minted a post-expand NULL order';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'checkout_upgrade_required' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    not exists (
      select 1 from public.orders o where o.user_id = v_upgrade_user
    ),
    'zero-candidate old checkout must fail closed without a new intent'
  );

  v_replayed := public.create_pending_order(
    v_user,
    v_old_order,
    'qa_rollout_checkout',
    1900,
    3,
    pg_catalog.replace(v_old_order::text, '-', ''),
    'portone',
    'card',
    false
  );
  perform pg_temp.qa_assert(
    v_replayed = v_old_order,
    'old checkout may replay only its exact pre-expand pending identifier'
  );

  begin
    perform public.create_pending_order(
      v_user,
      v_new_candidate,
      'qa_rollout_checkout',
      1900,
      3,
      pg_catalog.replace(v_new_candidate::text, '-', ''),
      'portone',
      'card',
      false
    );
    raise exception 'old checkout exposed a second payment identifier';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'checkout_reuse_required' then
        raise;
      end if;
  end;

  begin
    insert into public.orders(
      order_uuid,
      user_id,
      product_id,
      amount,
      credits,
      status,
      provider,
      payment_id,
      is_test,
      pay_channel
    )
    values (
      v_unique_candidate,
      v_user,
      'qa_rollout_checkout',
      1900,
      3,
      'pending',
      'portone',
      pg_catalog.replace(v_unique_candidate::text, '-', ''),
      false,
      'card'
    );
    raise exception 'unique unresolved-intent fence accepted a duplicate';
  exception
    when unique_violation then
      null;
  end;
  perform pg_temp.qa_assert(
    (select pg_catalog.count(*) = 1
       from public.orders o
      where o.user_id = v_user),
    'database uniqueness must preserve one unresolved intent per user'
  );

  begin
    perform public.mark_paid_and_grant(
      v_legacy_paid_order,
      'qa-expand-legacy-tx',
      1900,
      pg_catalog.jsonb_build_object(
        'id',
        pg_catalog.replace(v_legacy_paid_order::text, '-', ''),
        'status',
        'PAID',
        'transactionId',
        'qa-expand-legacy-tx',
        'paidAt',
        v_legacy_settle_paid_at,
        'amount',
        pg_catalog.jsonb_build_object('total', 1900),
        'storeId',
        'store-qa',
        'currency',
        'KRW',
        'channel',
        pg_catalog.jsonb_build_object(
          'type', 'LIVE', 'key', 'channel-card-live'
        )
      ),
      v_legacy_settle_paid_at,
      null
    );
    raise exception 'legacy NULL evidence unexpectedly granted credits';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'payment_evidence_incomplete' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    (
      select o.status <> 'paid'
         and o.paid_at is null
         and m.gen_credits = 0
        from public.orders o
        join public.member_accounts m on m.user_id = o.user_id
       where o.order_uuid = v_legacy_paid_order
    ),
    'legacy NULL evidence payment must remain unresolved and ungranted'
  );

  v_ack := public.backfill_portone_order_payment_evidence(
    v_legacy_paid_order,
    pg_catalog.replace(v_legacy_paid_order::text, '-', ''),
    1900,
    false,
    'card',
    'store-qa',
    'KRW',
    'channel-card-live'
  );
  perform public.mark_paid_and_grant(
    v_legacy_paid_order,
    'qa-expand-legacy-tx',
    1900,
    pg_catalog.jsonb_build_object(
      'id',
      pg_catalog.replace(v_legacy_paid_order::text, '-', ''),
      'status',
      'PAID',
      'transactionId',
      'qa-expand-legacy-tx',
      'paidAt',
      v_legacy_settle_paid_at,
      'amount',
      pg_catalog.jsonb_build_object('total', 1900),
      'storeId',
      'store-qa',
      'currency',
      'KRW',
      'channel',
      pg_catalog.jsonb_build_object(
        'type', 'LIVE', 'key', 'channel-card-live'
      )
    ),
    v_legacy_settle_paid_at,
    null
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'updated'
    and (
      select o.status = 'paid'
         and o.paid_at = v_legacy_settle_paid_at
         and m.gen_credits = 3
        from public.orders o
        join public.member_accounts m on m.user_id = o.user_id
       where o.order_uuid = v_legacy_paid_order
    ),
    'provider-backed adoption must unlock exactly one paid grant'
  );

  begin
    perform public.admin_settle_stuck_order_verified(
      v_admin,
      v_legacy_settle_order,
      'expand legacy verified settlement',
      v_settle_request,
      v_legacy_settle_paid_at,
      'qa-expand-legacy-settle-tx',
      null,
      pg_catalog.jsonb_build_object(
        'id',
        pg_catalog.replace(v_legacy_settle_order::text, '-', ''),
        'status',
        'PAID',
        'transactionId',
        'qa-expand-legacy-settle-tx',
        'paidAt',
        v_legacy_settle_paid_at,
        'amount',
        pg_catalog.jsonb_build_object('total', 1900),
        'storeId',
        'store-qa',
        'currency',
        'KRW',
        'channel',
        pg_catalog.jsonb_build_object(
          'type', 'LIVE', 'key', 'channel-card-live'
        )
      )
    );
    raise exception 'legacy NULL evidence admin settlement unexpectedly paid';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'payment_evidence_incomplete' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    (
      select o.status <> 'paid'
         and o.paid_at is null
         and m.gen_credits = 0
        from public.orders o
        join public.member_accounts m on m.user_id = o.user_id
       where o.order_uuid = v_legacy_settle_order
    ),
    'legacy NULL evidence admin settlement must fail closed'
  );

  perform public.backfill_portone_order_payment_evidence(
    v_legacy_settle_order,
    pg_catalog.replace(v_legacy_settle_order::text, '-', ''),
    1900,
    false,
    'card',
    'store-qa',
    'KRW',
    'channel-card-live'
  );
  v_ack := public.admin_settle_stuck_order_verified(
    v_admin,
    v_legacy_settle_order,
    'expand legacy verified settlement',
    v_settle_request,
    v_legacy_settle_paid_at,
    'qa-expand-legacy-settle-tx',
    null,
    pg_catalog.jsonb_build_object(
      'id',
      pg_catalog.replace(v_legacy_settle_order::text, '-', ''),
      'status',
      'PAID',
      'transactionId',
      'qa-expand-legacy-settle-tx',
      'paidAt',
      v_legacy_settle_paid_at,
      'amount',
      pg_catalog.jsonb_build_object('total', 1900),
      'storeId',
      'store-qa',
      'currency',
      'KRW',
      'channel',
      pg_catalog.jsonb_build_object(
        'type', 'LIVE', 'key', 'channel-card-live'
      )
    )
  );
  perform pg_temp.qa_assert(
    v_ack->>'ok' = 'true'
    and v_ack->>'credits' = '3'
    and (
      select o.status = 'paid'
         and m.gen_credits = 3
        from public.orders o
        join public.member_accounts m on m.user_id = o.user_id
       where o.order_uuid = v_legacy_settle_order
    ),
    'provider-backed adoption must unlock verified admin settlement'
  );

  perform pg_temp.qa_assert(
    (
      select o.expected_store_id is null
         and o.expected_currency is null
         and o.expected_channel_key is null
        from public.orders o
       where o.order_uuid = v_old_order
    ),
    'legacy checkout must retain an explicit NULL evidence snapshot'
  );

  begin
    perform public.create_or_reuse_pending_order(
      v_user,
      v_old_order,
      'qa_rollout_checkout',
      1900,
      3,
      pg_catalog.replace(v_old_order::text, '-', ''),
      'portone',
      'card',
      false,
      'store-qa',
      'KRW',
      'channel-card-live'
    );
    raise exception 'same-candidate legacy evidence was guessed by new server';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'legacy_checkout_refresh_required' then
        raise;
      end if;
  end;

  begin
    update public.app_settings
       set value = pg_catalog.jsonb_build_object(
         'products',
         pg_catalog.jsonb_build_array(
           pg_catalog.jsonb_build_object(
             'productId', 'qa_rollout_checkout',
             'goodname', 'QA rollout checkout',
             'price', 1900,
             'credits', 4,
             'active', true
           )
         )
       )
     where key = 'growth_levers';
    raise exception 'same-price/different-credit legacy config update succeeded';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'checkout_config_change_pending' then
        raise;
      end if;
  end;

  begin
    perform public.create_or_reuse_pending_order(
      v_user,
      v_new_candidate,
      'qa_rollout_checkout',
      1900,
      3,
      pg_catalog.replace(v_new_candidate::text, '-', ''),
      'portone',
      'card',
      false,
      'store-qa',
      'KRW',
      'channel-card-live'
    );
    raise exception 'legacy checkout evidence was guessed by the new server';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'legacy_checkout_refresh_required' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    (
      select count(*) = 1
         and pg_catalog.bool_and(o.expected_store_id is null)
         and pg_catalog.bool_and(o.expected_currency is null)
         and pg_catalog.bool_and(o.expected_channel_key is null)
        from public.orders o
       where o.user_id = v_user
    ),
    'new checkout must reject rather than infer a legacy NULL snapshot'
  );

  v_ack := public.backfill_portone_order_payment_evidence(
    v_old_order,
    pg_catalog.replace(v_old_order::text, '-', ''),
    1900,
    false,
    'card',
    'store-qa',
    'KRW',
    'channel-card-live'
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'updated'
    and (v_ack->>'order_uuid')::uuid = v_old_order
    and v_ack->>'pay_channel' = 'card'
    and v_ack->>'expected_store_id' = 'store-qa'
    and v_ack->>'expected_currency' = 'KRW'
    and v_ack->>'expected_channel_key' = 'channel-card-live'
    and (
      select o.expected_store_id = 'store-qa'
         and o.expected_currency = 'KRW'
         and o.expected_channel_key = 'channel-card-live'
        from public.orders o
       where o.order_uuid = v_old_order
    ),
    'expand-only backfill must adopt one exact provider-proven tuple'
  );
  v_ack := public.backfill_portone_order_payment_evidence(
    v_old_order,
    pg_catalog.replace(v_old_order::text, '-', ''),
    1900,
    false,
    'card',
    'store-qa',
    'KRW',
    'channel-card-live'
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'already_exact',
    'exact backfill replay must be idempotent'
  );
  begin
    perform public.backfill_portone_order_payment_evidence(
      v_old_order,
      pg_catalog.replace(v_old_order::text, '-', ''),
      1900,
      false,
      'tosspay',
      'store-qa',
      'KRW',
      'channel-card-live'
    );
    raise exception 'cross-channel evidence backfill unexpectedly succeeded';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'payment_evidence_order_mismatch' then
        raise;
      end if;
  end;
  begin
    perform public.backfill_portone_order_payment_evidence(
      v_old_order,
      pg_catalog.replace(v_old_order::text, '-', ''),
      1900,
      false,
      'card',
      'store-qa',
      'KRW',
      'channel-other'
    );
    raise exception 'conflicting evidence backfill unexpectedly succeeded';
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error = message_text;
      if v_error <> 'payment_evidence_snapshot_conflict' then
        raise;
      end if;
  end;

  v_ack := public.create_or_reuse_pending_order(
    v_user,
    v_old_order,
    'qa_rollout_checkout',
    1900,
    3,
    pg_catalog.replace(v_old_order::text, '-', ''),
    'portone',
    'card',
    false,
    'store-rotated',
    'KRW',
    'channel-card-rotated'
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'replayed'
    and (v_ack->>'order_uuid')::uuid = v_old_order
    and v_ack->>'expected_store_id' = 'store-qa'
    and v_ack->>'expected_currency' = 'KRW'
    and v_ack->>'expected_channel_key' = 'channel-card-live',
    'same-candidate replay must preserve the adopted immutable tuple'
  );

  v_ack := public.create_or_reuse_pending_order(
    v_user,
    v_new_candidate,
    'qa_rollout_checkout',
    1900,
    3,
    pg_catalog.replace(v_new_candidate::text, '-', ''),
    'portone',
    'card',
    false,
    'store-rotated',
    'KRW',
    'channel-card-rotated'
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'reused'
    and (v_ack->>'order_uuid')::uuid = v_old_order
    and v_ack->>'expected_store_id' = 'store-qa'
    and v_ack->>'expected_currency' = 'KRW'
    and v_ack->>'expected_channel_key' = 'channel-card-live'
    and (
      select count(*) = 1
        from public.orders o
       where o.user_id = v_user
    ),
    'different-candidate reuse must preserve the adopted tuple after config rotation'
  );
end;
$qa$;

select 'rollout_expand_sql_ok';
rollback;
SQL
}

run_contract_sql() {
  db_psql -Aqt <<'SQL'
begin;

create function pg_temp.qa_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $qa$
begin
  if p_condition is distinct from true then
    raise exception 'rollout contract assertion failed: %', p_message;
  end if;
end;
$qa$;

select pg_temp.qa_assert(
  exists (
    select 1
      from public.schema_migration_journal j
     where j.version = '008900_public_write_quotas'
  )
  and pg_catalog.to_regclass(
        'public.public_write_quota_buckets'
      ) is not null
  and pg_catalog.to_regclass(
        'public.public_write_attempts'
      ) is not null
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.record_public_analytics_event(text,text,jsonb)',
        'EXECUTE'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)',
        'EXECUTE'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
        'EXECUTE'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
        'EXECUTE'
      )
  and pg_catalog.has_function_privilege(
        'service_role',
        'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
        'EXECUTE'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)',
        'EXECUTE'
      )
  and not pg_catalog.has_table_privilege(
        'service_role', 'public.analytics_events', 'INSERT'
      )
  and not pg_catalog.has_table_privilege(
        'service_role', 'public.content_reports', 'INSERT'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.bp_probe_score_write_replay(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb)',
        'EXECUTE'
      )
  and not pg_catalog.has_function_privilege(
        'service_role',
        'public.bp_consume_report_legacy_write_quota()',
        'EXECUTE'
      )
  and not pg_catalog.has_table_privilege(
        'service_role',
        'public.public_write_quota_buckets',
        'SELECT,INSERT,UPDATE,DELETE'
      )
  and not pg_catalog.has_table_privilege(
        'service_role',
        'public.public_write_attempts',
        'SELECT,INSERT,UPDATE,DELETE'
      ),
  '008900 bounded public write surface must survive contract cleanup'
);

select pg_temp.qa_assert(
  not public.bp_rollout_compatibility_enabled('legacy_score_submission')
  and not public.bp_rollout_compatibility_enabled(
    'legacy_generation_transition'
  )
  and not public.bp_rollout_compatibility_enabled(
    'legacy_checkout_reuse'
  ),
  'all bounded rollout flags must be disabled'
);
select pg_temp.qa_assert(
  pg_catalog.to_regprocedure(
    'public.admin_adjust_credits(uuid,uuid,integer,text)'
  ) is null,
  'legacy four-argument credit adjustment must be dropped'
);
select pg_temp.qa_assert(
  pg_catalog.to_regprocedure(
    'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
  ) is null
  and pg_catalog.to_regprocedure(
    'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
  ) is null
  and exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.orders'::regclass
       and c.conname = 'orders_portone_payment_evidence_required_check'
       and c.contype = 'c'
       and c.convalidated
  ),
  'contract must remove temporary backfill and require complete PortOne evidence'
);
select pg_temp.qa_assert(
  (
    select normalized like '%providerisdistinctfrom''portone''%'
       and normalized like '%payment_idisnotnull%'
       and normalized like '%payment_id=replace%order_uuid%-%'
       and normalized like '%expected_store_idisnotnull%'
       and normalized like '%expected_currencyisnotnull%'
       and normalized like '%expected_channel_keyisnotnull%'
      from (
        select pg_catalog.replace(
                 pg_catalog.regexp_replace(
                   pg_catalog.lower(
                     pg_catalog.pg_get_constraintdef(c.oid)
                   ),
                   '[[:space:]()]',
                   '',
                   'g'
                 ),
                 '::text',
                 ''
               ) as normalized
          from pg_catalog.pg_constraint c
         where c.conrelid = 'public.orders'::regclass
           and c.conname =
                 'orders_portone_payment_evidence_required_check'
      ) definition
  ),
  'required evidence CHECK must bind UUID-derived payment id and complete tuple'
);
select pg_temp.qa_assert(
  not pg_catalog.has_table_privilege(
    'authenticated', 'public.dolls', 'DELETE'
  )
  and not exists (
    select 1
      from pg_catalog.pg_policy
     where polrelid = 'public.dolls'::regclass
       and polcmd = 'd'
  ),
  'old browser doll delete surface must be closed'
);
select pg_temp.qa_assert(
  not pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.content_reports', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'DELETE'
  ),
  'all old direct server DML grants must be closed'
);
select pg_temp.qa_assert(
  pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'id', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'owner_id', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'image_url', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'style_meta', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'role', 'INSERT'
  )
  and not pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'deleted_at', 'INSERT'
  ),
  'only the permanent intent-fenced doll insert columns may remain'
);

do $qa$
declare
  v_table text;
  v_signature text;
begin
  foreach v_table in array array[
    'admin_actions_ledger',
    'ai_generations',
    'analytics_events',
    'analytics_rollups',
    'app_settings',
    'app_settings_audit',
    'credit_ledger',
    'credit_lots',
    'dolls',
    'events',
    'legal_documents',
    'member_accounts',
    'order_refund_attempts',
    'orders',
    'profiles',
    'reconciliation_issues',
    'refund_requests',
    'reviewer_accounts',
    'score_flags',
    'score_highlights',
    'score_stats',
    'scores',
    'telemetry_rollups',
    'telemetry_sessions',
    'user_badges'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regclass('public.' || v_table) is not null
      and pg_catalog.has_table_privilege(
        'service_role',
        'public.' || v_table,
        'SELECT'
      ),
      'permanent service read unavailable: ' || v_table
    );
  end loop;

  foreach v_signature in array array[
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid)',
    'public.admin_publish_legal(text,date,uuid)',
    'public.admin_unpublish_legal(text,uuid)',
    'public.admin_update_app_setting(text,jsonb,integer,uuid,text)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_publish_event(uuid,uuid)',
    'public.admin_unpublish_event(uuid,uuid)',
    'public.admin_delete_event(uuid,uuid)',
    'public.admin_clear_score(uuid,uuid,text)',
    'public.admin_void_score(uuid,uuid,text)',
    'public.admin_ban_member(uuid,uuid,text)',
    'public.admin_unban_member(uuid,uuid,text)',
    'public.admin_takedown_doll(uuid,uuid,text)',
    'public.admin_dismiss_doll(uuid,uuid,text)',
    'public.admin_restore_doll(uuid,uuid,text)',
    'public.admin_begin_doll_purge(uuid,uuid,text)',
    'public.admin_reactivate_account(uuid,uuid,text,text)',
    'public.admin_settle_stuck_order(uuid,uuid,text)',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regprocedure(v_signature) is not null,
      'legacy implementation unexpectedly missing: ' || v_signature
    );
    perform pg_temp.qa_assert(
      not pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(v_signature),
        'EXECUTE'
      ),
      'legacy RPC remains externally executable: ' || v_signature
    );
  end loop;

  perform pg_temp.qa_assert(
    pg_catalog.to_regprocedure(
      'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
    ) is null,
    'evidence-free checkout overload remains after contract'
  );
  perform pg_temp.qa_assert(
    not pg_catalog.has_function_privilege(
      'service_role',
      'public.bp_008905_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
      'EXECUTE'
    ),
    'private checkout implementation became externally executable'
  );

  foreach v_signature in array array[
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
    'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
    'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
    'public.get_admin_mutation_receipt(uuid,uuid,text,text)',
    'public.admin_update_app_setting_idempotent(text,jsonb,integer,uuid,text,uuid)',
    'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
    'public.get_moderation_purge_status(uuid,uuid,uuid)',
    'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
    'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
    'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])',
    'public.expire_generation(uuid,integer)',
    'public.claim_generation_submit_intent(uuid,uuid,integer,text,text)',
    'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regprocedure(v_signature) is not null
      and pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(v_signature),
        'EXECUTE'
      ),
      'new RPC unavailable after contract: ' || v_signature
    );
  end loop;
end;
$qa$;

do $qa$
declare
  v_user uuid := pg_catalog.gen_random_uuid();
  v_submission uuid := pg_catalog.gen_random_uuid();
  v_ack jsonb;
  v_checkout_order uuid := pg_catalog.gen_random_uuid();
  v_checkout_request uuid := pg_catalog.gen_random_uuid();
  v_offer jsonb;
  v_legacy_order uuid := pg_catalog.gen_random_uuid();
  v_missing_payment_order uuid := pg_catalog.gen_random_uuid();
  v_foreign_payment_order uuid := pg_catalog.gen_random_uuid();
  v_constraint text;
  v_failed_generation uuid := pg_catalog.gen_random_uuid();
  v_old_expiry_generation uuid := pg_catalog.gen_random_uuid();
  v_new_expiry_generation uuid := pg_catalog.gen_random_uuid();
begin
  insert into auth.users(id, email)
  values (
    v_user,
    'rollout-contract-' || v_user::text || '@test.local'
  );
  insert into public.member_accounts(user_id, gen_credits)
  values (v_user, 3)
  on conflict (user_id) do update set gen_credits = excluded.gen_credits;

  insert into public.app_settings(key, value)
  values (
    'growth_levers',
    pg_catalog.jsonb_build_object(
      'products',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_contract_checkout',
          'goodname', 'QA contract checkout',
          'price', 1900,
          'credits', 3,
          'active', true
        )
      )
    )
  )
  on conflict (key) do update set value = excluded.value;

  v_offer := public.record_commerce_display_evidence(
    'credits_offer',
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'copyVersion', 'credits-offer-2026-07-30-v1',
      'surface', 'credits_offer',
      'payMode', 'live',
      'products', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_contract_checkout',
          'goodname', 'QA contract checkout',
          'priceKrwVatIncluded', 1900,
          'credits', 3
        )
      ),
      'channels', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'method', 'card',
          'label', '카드'
        )
      ),
      'displayCopy', pg_catalog.jsonb_build_object(
        'summary',
          '캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.',
        'supply',
          '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.',
        'validity',
          '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.',
        'refund',
          '미사용 생성권은 환불받을 수 있어요(무료로 지급받은 생성권은 제외). 일부만 사용했더라도 남은 수량만큼 환불돼요. 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한돼요.',
        'refundReferencePrefix',
          '정확한 산정 기준·차감 순서·절차는',
        'termsLinkLabel', '이용약관 제10조',
        'refundReferenceSuffix', '를 확인해주세요.',
        'price', '표시 가격은 부가세 포함 최종 결제 금액이에요.'
      )
    )
  );

  v_ack := public.create_or_reuse_pending_order(
    v_user,
    v_checkout_order,
    'qa_contract_checkout',
    1900,
    3,
    pg_catalog.replace(v_checkout_order::text, '-', ''),
    'portone',
    'card',
    false,
    'store-contract',
    'KRW',
    'channel-contract-live',
    v_checkout_request,
    'QA contract checkout',
    (v_offer->>'evidence_id')::uuid,
    v_offer->>'snapshot_sha256',
    'checkout-withdrawal-limit-2026-07-30-v1',
    '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
    true
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'ready'
    and (v_ack->>'order_uuid')::uuid = v_checkout_order
    and v_ack->>'payment_id' =
          pg_catalog.replace(v_checkout_order::text, '-', '')
    and v_ack->>'expected_store_id' = 'store-contract'
    and v_ack->>'expected_currency' = 'KRW'
    and v_ack->>'expected_channel_key' = 'channel-contract-live'
    and (v_ack->>'checkout_request_id')::uuid = v_checkout_request
    and v_ack->>'withdrawal_confirmed' = 'true'
    and (
      select o.payment_id =
               pg_catalog.replace(o.order_uuid::text, '-', '')
         and o.expected_store_id = 'store-contract'
         and o.expected_currency = 'KRW'
         and o.expected_channel_key = 'channel-contract-live'
         and e.user_id = v_user
         and e.product_name = 'QA contract checkout'
         and e.amount = 1900
         and e.credits = 3
         and e.pay_mode = 'live'
         and e.pay_channel = 'card'
         and e.confirmed
        from public.orders o
        join public.checkout_withdrawal_acceptance_evidence e
          on e.order_uuid = o.order_uuid
       where o.order_uuid = v_checkout_order
    ),
    'contract-stage fresh checkout must atomically persist complete evidence'
  );

  v_ack := public.create_or_reuse_pending_order(
    v_user,
    v_checkout_order,
    'qa_contract_checkout',
    1900,
    3,
    pg_catalog.replace(v_checkout_order::text, '-', ''),
    'portone',
    'card',
    false,
    'store-rotated',
    'KRW',
    'channel-rotated',
    v_checkout_request,
    'QA contract checkout',
    (v_offer->>'evidence_id')::uuid,
    v_offer->>'snapshot_sha256',
    'checkout-withdrawal-limit-2026-07-30-v1',
    '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
    true
  );
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'replayed'
    and (v_ack->>'order_uuid')::uuid = v_checkout_order
    and v_ack->>'expected_store_id' = 'store-contract'
    and v_ack->>'expected_currency' = 'KRW'
    and v_ack->>'expected_channel_key' = 'channel-contract-live'
    and (v_ack->>'checkout_request_id')::uuid = v_checkout_request
    and (
      select pg_catalog.count(*) = 1
        from public.checkout_withdrawal_acceptance_evidence e
       where e.request_id = v_checkout_request
    )
    and (
      select pg_catalog.count(*) = 1
        from public.orders o
       where o.user_id = v_user
         and o.product_id = 'qa_contract_checkout'
    ),
    'contract-stage same-candidate replay must preserve its original tuple'
  );

  begin
    insert into public.orders(
      order_uuid,
      user_id,
      product_id,
      amount,
      credits,
      status,
      provider,
      payment_id,
      is_test,
      pay_channel
    )
    values (
      v_legacy_order,
      v_user,
      'qa_contract_legacy_order',
      1900,
      3,
      'pending',
      'portone',
      pg_catalog.replace(v_legacy_order::text, '-', ''),
      false,
      'card'
    );
    raise exception 'legacy NULL PortOne order unexpectedly inserted';
  exception
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from
           'orders_portone_payment_evidence_required_check' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    not exists (
      select 1
        from public.orders o
       where o.order_uuid = v_legacy_order
    ),
    'required evidence CHECK must reject and persist no legacy PortOne order'
  );

  begin
    insert into public.orders(
      order_uuid,
      user_id,
      product_id,
      amount,
      credits,
      status,
      provider,
      payment_id,
      is_test,
      pay_channel,
      expected_store_id,
      expected_currency,
      expected_channel_key
    )
    values (
      v_missing_payment_order,
      v_user,
      'qa_contract_missing_payment',
      1900,
      3,
      'pending',
      'portone',
      null,
      false,
      'card',
      'store-contract',
      'KRW',
      'channel-contract-live'
    );
    raise exception 'PortOne order without payment id unexpectedly inserted';
  exception
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from
           'orders_portone_payment_evidence_required_check' then
        raise;
      end if;
  end;

  begin
    insert into public.orders(
      order_uuid,
      user_id,
      product_id,
      amount,
      credits,
      status,
      provider,
      payment_id,
      is_test,
      pay_channel,
      expected_store_id,
      expected_currency,
      expected_channel_key
    )
    values (
      v_foreign_payment_order,
      v_user,
      'qa_contract_foreign_payment',
      1900,
      3,
      'pending',
      'portone',
      (
        case
          when pg_catalog.left(
                 pg_catalog.replace(v_foreign_payment_order::text, '-', ''),
                 1
               ) = '0'
            then '1'
          else '0'
        end
      ) || pg_catalog.substr(
        pg_catalog.replace(v_foreign_payment_order::text, '-', ''),
        2
      ),
      false,
      'card',
      'store-contract',
      'KRW',
      'channel-contract-live'
    );
    raise exception 'foreign PortOne payment id unexpectedly inserted';
  exception
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from
           'orders_portone_payment_evidence_required_check' then
        raise;
      end if;
  end;
  perform pg_temp.qa_assert(
    not exists (
      select 1
        from public.orders o
       where o.order_uuid in (
         v_legacy_order,
         v_missing_payment_order,
         v_foreign_payment_order
       )
    ),
    'required evidence CHECK persists no incomplete or foreign identity'
  );

  begin
    perform public.submit_score_with_review(
      v_user,
      null,
      100,
      'fist',
      1000,
      1,
      'normal',
      null,
      'registered',
      '[]'::jsonb,
      '{}'::jsonb,
      0,
      'qa-contract-old'
    );
    raise exception 'old score request unexpectedly accepted';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'invalid_submission_id' then
        raise;
      end if;
  end;

  v_ack := public.submit_score_with_review(
    v_user,
    null,
    101,
    'hammer',
    1000,
    1,
    'normal',
    null,
    'registered',
    '[]'::jsonb,
    pg_catalog.jsonb_build_object(
      'submissionId', v_submission,
      'submissionFingerprint', pg_catalog.repeat('b', 64)
    ),
    0,
    'qa-contract-new',
    pg_catalog.repeat('c', 64)
  );
  perform pg_temp.qa_assert(
    v_ack->>'duplicate' = 'false'
    and exists (
      select 1
        from public.scores s
       where s.id = (v_ack->>'scoreId')::uuid
         and s.submission_id = v_submission
    ),
    'new score protocol must remain available after contract'
  );

  insert into public.ai_generations(id, owner_id, status)
  values (v_failed_generation, v_user, 'failed');
  begin
    update public.ai_generations
       set status = 'done'
     where id = v_failed_generation;
    raise exception 'old failed-to-done transition unexpectedly accepted';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'invalid_generation_transition:failed->done' then
        raise;
      end if;
  end;

  insert into public.ai_generations(id, owner_id, status)
  values (v_old_expiry_generation, v_user, 'done');
  begin
    perform public.mark_generation_failed_and_refund(
      v_old_expiry_generation,
      'expired'
    );
    raise exception 'old done-expiry RPC shape unexpectedly accepted';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'invalid_state' then
        raise;
      end if;
  end;

  insert into public.ai_generations(id, owner_id, status)
  values (v_new_expiry_generation, v_user, 'done');
  v_ack := public.expire_generation(v_new_expiry_generation);
  perform pg_temp.qa_assert(
    v_ack->>'outcome' = 'expired'
    and (
      select status = 'expired'
        from public.ai_generations
       where id = v_new_expiry_generation
    ),
    'new explicit generation expiry must remain available'
  );
end;
$qa$;

select 'rollout_contract_sql_ok';
rollback;
SQL
}

if [[ "$stage" == "expand" ]]; then
  if ! sql_output="$(run_expand_sql 2>&1)"; then
    printf '%s\n' "$sql_output" >&2
    fail "SQL compatibility checks failed"
  fi
  marker="rollout_expand_sql_ok"
else
  if ! sql_output="$(run_contract_sql 2>&1)"; then
    printf '%s\n' "$sql_output" >&2
    fail "SQL contract checks failed"
  fi
  marker="rollout_contract_sql_ok"
fi
marker_count="$(printf '%s\n' "$sql_output" | grep -Fxc "$marker" || true)"
[[ "$marker_count" == "1" ]] \
  || fail "SQL marker missing or duplicated: $marker"

command -v supabase >/dev/null 2>&1 \
  || fail "Supabase CLI is required for local PostgREST verification"
command -v curl >/dev/null 2>&1 \
  || fail "curl is required for local PostgREST verification"
if ! status_env="$(supabase status -o env 2>/dev/null)"; then
  fail "could not read disposable Supabase status"
fi
eval "$status_env"
: "${API_URL:?local Supabase status did not provide API_URL}"
: "${ANON_KEY:?local Supabase status did not provide ANON_KEY}"
: "${SERVICE_ROLE_KEY:?local Supabase status did not provide SERVICE_ROLE_KEY}"
: "${JWT_SECRET:?local Supabase status did not provide JWT_SECRET}"
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*)
    ;;
  *)
    fail "refusing to run rollout QA against a non-local API URL"
    ;;
esac

read_tables=(
  admin_actions_ledger
  ai_generations
  analytics_events
  analytics_rollups
  app_settings
  app_settings_audit
  credit_ledger
  credit_lots
  dolls
  events
  legal_documents
  member_accounts
  order_refund_attempts
  orders
  profiles
  reconciliation_issues
  refund_requests
  reviewer_accounts
  score_flags
  score_highlights
  score_stats
  scores
  telemetry_rollups
  telemetry_sessions
  user_badges
)
for table_name in "${read_tables[@]}"; do
  http_status=""
  for _ in $(seq 1 20); do
    http_status="$(
      curl --globoff --silent --show-error \
        --connect-timeout 2 \
        --max-time 5 \
        --output /dev/null \
        --write-out '%{http_code}' \
        --header "apikey: $SERVICE_ROLE_KEY" \
        --header "Authorization: Bearer $SERVICE_ROLE_KEY" \
        "$API_URL/rest/v1/$table_name?select=*&limit=0" \
        || true
    )"
    if [[ "$http_status" == "200" || "$http_status" == "206" ]]; then
      break
    fi
    sleep 0.25
  done
  [[ "$http_status" == "200" || "$http_status" == "206" ]] \
    || fail "PostgREST service read failed for $table_name (HTTP $http_status)"
done

command -v node >/dev/null 2>&1 \
  || fail "Node.js is required for local authenticated-role JWT verification"
authenticated_token="$(
  QA_LOCAL_JWT_SECRET="$JWT_SECRET" node -e '
    const crypto = require("node:crypto");
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
      email: "rollout-rpc-authenticated@test.local",
      iss: "supabase",
      role: "authenticated",
      sub: "00000000-0000-4000-8000-000000000099",
    });
    const input = `${header}.${payload}`;
    const signature = crypto
      .createHmac("sha256", process.env.QA_LOCAL_JWT_SECRET)
      .update(input)
      .digest("base64url");
    process.stdout.write(`${input}.${signature}`);
  '
)"
[[ "$authenticated_token" == *.*.* ]] \
  || fail "could not mint the local authenticated-role QA token"

for auth_probe in \
  "anon|$ANON_KEY" \
  "authenticated|$authenticated_token"; do
  IFS='|' read -r auth_probe_role auth_probe_token <<<"$auth_probe"
  auth_probe_status="$(
    curl --globoff --silent --show-error \
      --connect-timeout 2 \
      --max-time 5 \
      --output /dev/null \
      --write-out '%{http_code}' \
      --header "apikey: $ANON_KEY" \
      --header "Authorization: Bearer $auth_probe_token" \
      "$API_URL/rest/v1/profiles?select=id&limit=0" \
      || true
  )"
  [[ "$auth_probe_status" == "200" || "$auth_probe_status" == "206" ]] \
    || fail "$auth_probe_role QA token failed its PostgREST read probe"
done

backfill_payload_eight='{
  "p_order_uuid":"00000000-0000-4000-8000-000000000001",
  "p_payment_id":"00000000000040008000000000000001",
  "p_amount":0,
  "p_is_test":false,
  "p_pay_channel":"card",
  "p_expected_store_id":"store-qa",
  "p_expected_currency":"KRW",
  "p_expected_channel_key":"channel-card-live"
}'
backfill_payload_seven='{
  "p_order_uuid":"00000000-0000-4000-8000-000000000001",
  "p_payment_id":"00000000000040008000000000000001",
  "p_amount":0,
  "p_is_test":false,
  "p_expected_store_id":"store-qa",
  "p_expected_currency":"KRW",
  "p_expected_channel_key":"channel-card-live"
}'

postgrest_rpc() {
  rpc_api_key="$1"
  rpc_bearer="$2"
  rpc_payload="$3"
  curl --globoff --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --request POST \
    --header "apikey: $rpc_api_key" \
    --header "Authorization: Bearer $rpc_bearer" \
    --header "Content-Type: application/json" \
    --data "$rpc_payload" \
    --write-out $'\n%{http_code}' \
    "$API_URL/rest/v1/rpc/backfill_portone_order_payment_evidence"
}

assert_rpc_denied_or_hidden() {
  rpc_label="$1"
  rpc_response="$2"
  rpc_status="${rpc_response##*$'\n'}"
  rpc_body="${rpc_response%$'\n'*}"
  case "$rpc_status" in
    401|403|404)
      ;;
    *)
      fail "$rpc_label unexpectedly reached the backfill implementation (HTTP $rpc_status)"
      ;;
  esac
  [[ "$rpc_body" != *"invalid_payment_evidence_snapshot"* ]] \
    || fail "$rpc_label executed the service-only backfill implementation"
}

service_rpc_response=""
for _ in $(seq 1 20); do
  service_rpc_response="$(
    postgrest_rpc \
      "$SERVICE_ROLE_KEY" \
      "$SERVICE_ROLE_KEY" \
      "$backfill_payload_eight" \
      || true
  )"
  service_rpc_status="${service_rpc_response##*$'\n'}"
  service_rpc_body="${service_rpc_response%$'\n'*}"
  if [[ "$stage" == "expand" \
        && "$service_rpc_status" == "400" \
        && "$service_rpc_body" == *"invalid_payment_evidence_snapshot"* ]]; then
    break
  fi
  if [[ "$stage" == "contract" && "$service_rpc_status" == "404" ]]; then
    break
  fi
  sleep 0.25
done
if [[ "$stage" == "expand" ]]; then
  [[ "$service_rpc_status" == "400" \
     && "$service_rpc_body" == *"invalid_payment_evidence_snapshot"* ]] \
    || fail "service_role could not call the eight-argument backfill RPC"
  assert_rpc_denied_or_hidden \
    "anon eight-argument backfill" \
    "$(
      postgrest_rpc "$ANON_KEY" "$ANON_KEY" "$backfill_payload_eight" \
        || true
    )"
  assert_rpc_denied_or_hidden \
    "authenticated eight-argument backfill" \
    "$(
      postgrest_rpc \
        "$ANON_KEY" \
        "$authenticated_token" \
        "$backfill_payload_eight" \
        || true
    )"
else
  [[ "$service_rpc_status" == "404" \
     && "$service_rpc_body" != *"invalid_payment_evidence_snapshot"* ]] \
    || fail "contract still exposes the eight-argument backfill RPC"
fi

seven_rpc_response="$(
  postgrest_rpc \
    "$SERVICE_ROLE_KEY" \
    "$SERVICE_ROLE_KEY" \
    "$backfill_payload_seven" \
    || true
)"
seven_rpc_status="${seven_rpc_response##*$'\n'}"
seven_rpc_body="${seven_rpc_response%$'\n'*}"
[[ "$seven_rpc_status" == "404" \
   && "$seven_rpc_body" != *"invalid_payment_evidence_snapshot"* ]] \
  || fail "superseded seven-argument backfill remains callable"

echo "rollout $stage stage QA passed:"
echo "  SQL state/protocol/ACL checks: passed"
echo "  PostgREST service reads: ${#read_tables[@]}/${#read_tables[@]}"
if [[ "$stage" == "expand" ]]; then
  echo "  PostgREST payment backfill: service-only 8-arg; 7-arg absent"
else
  echo "  PostgREST payment backfill: 7/8-arg signatures absent"
fi
