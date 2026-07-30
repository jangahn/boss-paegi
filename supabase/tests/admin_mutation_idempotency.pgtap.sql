-- 0085 external admin mutations: exact-payload receipts, response-loss
-- recovery, version/state fences, and two-system reactivation sequencing.
--
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(150);

-- ── Catalog and privilege boundary ────────────────────────────────────────

select has_table(
  'public',
  'admin_mutation_requests',
  'durable admin mutation receipt table exists'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.admin_mutation_requests'::regclass
  ),
  'receipt table has RLS enabled'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.admin_mutation_requests'::regclass
  ),
  0,
  'receipt table exposes no client RLS policy'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.admin_mutation_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.admin_mutation_requests',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.admin_mutation_requests',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.admin_mutation_requests',
    'DELETE'
  ),
  'service role can recover receipts but cannot forge or mutate them'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.admin_mutation_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.admin_mutation_requests',
    'SELECT'
  ),
  'browser roles cannot read receipt payloads'
);
select has_trigger(
  'public',
  'admin_mutation_requests',
  'trg_admin_mutation_requests_guard',
  'receipt rows have an append-only transition guard'
);
select has_table(
  'public',
  'account_reactivation_jobs',
  'reactivation has a durable external-sync job table'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.account_reactivation_jobs'::regclass
  ),
  'reactivation job table has RLS enabled'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.account_reactivation_jobs',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_jobs',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_jobs',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_jobs',
    'DELETE'
  )
  and not has_table_privilege(
    'anon',
    'public.account_reactivation_jobs',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.account_reactivation_jobs',
    'SELECT'
  ),
  'reactivation jobs are RPC-only for every external role'
);
select has_trigger(
  'public',
  'account_reactivation_jobs',
  'trg_account_reactivation_jobs_guard',
  'reactivation jobs have an immutable fenced transition guard'
);
select has_table(
  'public',
  'account_reactivation_legacy_repairs',
  'rolling DB-first reactivation has a durable repair outbox'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid =
       'public.account_reactivation_legacy_repairs'::regclass
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_legacy_repairs',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_legacy_repairs',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_legacy_repairs',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.account_reactivation_legacy_repairs',
    'DELETE'
  )
  and not has_table_privilege(
    'anon',
    'public.account_reactivation_legacy_repairs',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.account_reactivation_legacy_repairs',
    'SELECT'
  ),
  'legacy repair rows are RLS-protected and RPC-only'
);
select has_trigger(
  'public',
  'account_reactivation_legacy_repairs',
  'trg_account_reactivation_legacy_repairs_guard',
  'legacy repair rows have an immutable transition guard'
);
select ok(
  (
    select t.tgdeferrable and t.tginitdeferred
      from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.profiles'::regclass
       and t.tgname =
         'trg_profiles_enqueue_legacy_account_reactivation_repair'
       and not t.tgisinternal
  ),
  'legacy DB-first activation capture runs as an initially deferred constraint trigger'
);
select has_trigger(
  'public',
  'profiles',
  'trg_profiles_fence_account_reactivation_lifecycle',
  'pending reactivation jobs fence the exact profile deletion lifecycle'
);
select has_column(
  'public',
  'profiles',
  'withdrawal_generation',
  'profiles carry a non-timestamp withdrawal lifecycle generation'
);
select has_trigger(
  'public',
  'profiles',
  'trg_profiles_advance_withdrawal_generation',
  'every active-to-deleted transition advances the lifecycle generation'
);
select has_trigger(
  'auth',
  'users',
  'trg_auth_users_fence_account_reactivation',
  'Auth marker restoration is fenced by the live durable lease'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_fence_account_reactivation_auth_email()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.bp_fence_account_reactivation_auth_email()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bp_fence_account_reactivation_auth_email()',
    'EXECUTE'
  ),
  'Auth fence is trigger-only for every external role'
);
select ok(
  not exists (
    select 1
      from (
        values
          ('public.events'::regclass, 'mutation_version'),
          ('public.dolls'::regclass, 'moderation_version'),
          ('public.scores'::regclass, 'integrity_version'),
          ('public.member_accounts'::regclass, 'integrity_version')
      ) as expected(table_oid, column_name)
     where not exists (
       select 1
         from pg_catalog.pg_constraint c
        where c.conrelid = expected.table_oid
          and c.contype = 'c'
          and pg_catalog.pg_get_constraintdef(c.oid)
                like '%' || expected.column_name || '%'
          and pg_catalog.pg_get_constraintdef(c.oid)
                like '%9007199254740991%'
     )
  ),
  'all mutation versions are bounded to exact JavaScript integers'
);

create temporary table admin_mutation_rpc_manifest(
  signature text primary key
) on commit drop;
insert into admin_mutation_rpc_manifest(signature) values
  ('public.get_admin_mutation_receipt(uuid,uuid,text,text)'),
  ('public.admin_update_app_setting_idempotent(text,jsonb,integer,uuid,text,uuid)'),
  ('public.admin_save_event_idempotent(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid,bigint,uuid,text)'),
  ('public.admin_transition_event_idempotent(uuid,text,bigint,uuid,uuid)'),
  ('public.admin_moderation_action_idempotent(text,uuid,uuid,text,text,bigint,uuid)'),
  ('public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)'),
  ('public.get_moderation_purge_status(uuid,uuid,uuid)'),
  ('public.admin_integrity_action_idempotent(text,uuid,uuid,text,text,bigint,uuid)'),
  ('public.admin_begin_account_reactivation(uuid,uuid,text,text,timestamp with time zone,bigint,uuid)'),
  ('public.claim_account_reactivation_job(uuid,uuid,uuid,integer)'),
  ('public.arm_account_reactivation_auth_fence(uuid,uuid,uuid,uuid,integer)'),
  ('public.finish_account_reactivation_job(uuid,uuid,uuid,uuid,integer,boolean,text)'),
  ('public.get_account_reactivation_status(uuid,uuid,uuid)'),
  ('public.get_pending_account_reactivation(uuid,uuid)'),
  ('public.get_account_reactivation_queue_health()'),
  ('public.request_account_reactivation_cancellation(uuid,uuid,uuid,text,timestamp with time zone,bigint)'),
  ('public.claim_account_reactivation_legacy_repair(integer)'),
  ('public.arm_account_reactivation_legacy_repair_auth_fence(uuid,uuid,uuid,integer)'),
  ('public.finish_account_reactivation_legacy_repair(uuid,uuid,uuid,integer,boolean,text)'),
  ('public.get_account_reactivation_legacy_repair_status(uuid,uuid)'),
  ('public.get_admin_settlement_receipt(uuid,uuid,text,uuid)'),
  ('public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)');

select is(
  (
    select pg_catalog.count(*)::integer
      from admin_mutation_rpc_manifest m
     where pg_catalog.to_regprocedure(m.signature) is not null
  ),
  22,
  'all twenty-two permanent external admin-mutation RPCs exist'
);
select ok(
  not exists (
    select 1
      from admin_mutation_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where not p.prosecdef
        or p.proconfig is distinct from array['search_path=""']::text[]
  ),
  'every external RPC is SECURITY DEFINER with an empty search_path'
);
select ok(
  not exists (
    select 1
      from admin_mutation_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where not pg_catalog.has_function_privilege(
       'service_role',
       p.oid,
       'EXECUTE'
     )
  ),
  'service role can execute every external admin-mutation RPC'
);
select ok(
  not exists (
    select 1
      from admin_mutation_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege(
             'authenticated',
             p.oid,
             'EXECUTE'
           )
  ),
  'browser roles cannot execute admin mutation RPCs'
);
select ok(
  not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_update_app_setting(text,jsonb,integer,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_clear_score(uuid,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_void_score(uuid,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_ban_member(uuid,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_unban_member(uuid,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_begin_doll_purge(uuid,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_reactivate_account(uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_complete_account_reactivation(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_settle_stuck_order(uuid,uuid,text)',
    'EXECUTE'
  ),
  'superseded non-receipt external mutation entry points are closed'
);
select ok(
  not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname like 'bp\_admin\_mutation\_%' escape '\'
       and (
         pg_catalog.has_function_privilege(
           'service_role',
           p.oid,
           'EXECUTE'
         )
         or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
         or pg_catalog.has_function_privilege(
           'authenticated',
           p.oid,
           'EXECUTE'
         )
       )
  ),
  'receipt lock/hash/store helpers have no external execute path'
);
select ok(
  (
    select pg_catalog.pg_get_expr(i.indexprs, i.indrelid)
      from pg_catalog.pg_index i
     where i.indexrelid =
       'public.uq_admin_reactivation_pending_target'::regclass
  ) is null
  and (
    select pg_catalog.pg_get_expr(i.indpred, i.indrelid)
      from pg_catalog.pg_index i
     where i.indexrelid =
       'public.uq_admin_reactivation_pending_target'::regclass
  ) like '%account_reactivate%'
  and (
    select i.indisunique
      from pg_catalog.pg_index i
     where i.indexrelid =
       'public.uq_admin_reactivation_pending_target'::regclass
  ),
  'one pending reactivation saga is enforced per account'
);

-- ── Disposable behavior fixture ───────────────────────────────────────────

create temporary table admin_mutation_ctx (
  admin_id uuid not null,
  other_admin_id uuid not null,
  owner_id uuid not null,
  reactivate_id uuid not null,
  doll_id uuid not null,
  score_id uuid not null,
  order_id uuid not null,
  deleted_at timestamptz not null,
  config_request uuid not null,
  config_second_request uuid not null,
  aborted_request uuid not null,
  event_create_request uuid not null,
  event_noop_request uuid not null,
  event_modify_request uuid not null,
  event_restore_request uuid not null,
  event_publish_request uuid not null,
  event_unpublish_request uuid not null,
  event_republish_request uuid not null,
  event_delete_request uuid not null,
  event_delete_noop_request uuid not null,
  integrity_clear_request uuid not null,
  integrity_clear_noop_request uuid not null,
  integrity_void_request uuid not null,
  integrity_reclear_request uuid not null,
  integrity_ban_request uuid not null,
  integrity_ban_noop_request uuid not null,
  integrity_unban_request uuid not null,
  integrity_reban_request uuid not null,
  moderation_dismiss_request uuid not null,
  moderation_takedown_request uuid not null,
  moderation_restore_request uuid not null,
  reactivation_request uuid not null,
  reactivation_resume_request uuid not null,
  settlement_request uuid not null,
  settlement_noop_request uuid not null,
  event_id uuid,
  event_version bigint,
  moderation_version bigint,
  reactivation_operation uuid,
  first_result jsonb,
  second_result jsonb
) on commit drop;

insert into admin_mutation_ctx
select
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  '2026-07-20 01:02:03+00'::timestamptz,
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid();

insert into auth.users(id, email, raw_app_meta_data)
select
  admin_id,
  'admin-' || admin_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from admin_mutation_ctx
union all
select
  other_admin_id,
  'other-admin-' || other_admin_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from admin_mutation_ctx
union all
select
  owner_id,
  'owner-' || owner_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from admin_mutation_ctx
union all
select
  reactivate_id,
  'deleted+' || reactivate_id::text || '@deleted.invalid',
  '{"provider":"google"}'::jsonb
  from admin_mutation_ctx;

insert into public.member_accounts(
  user_id,
  gen_credits,
  email,
  is_admin
)
select
  admin_id,
  0,
  'admin-' || admin_id::text || '@test.local',
  true
  from admin_mutation_ctx
union all
select
  other_admin_id,
  0,
  'other-admin-' || other_admin_id::text || '@test.local',
  true
  from admin_mutation_ctx
union all
select
  owner_id,
  0,
  'owner-' || owner_id::text || '@test.local',
  false
  from admin_mutation_ctx
union all
select
  reactivate_id,
  0,
  null,
  false
  from admin_mutation_ctx;

update public.profiles p
   set deleted_at = c.deleted_at,
       display_name = '탈퇴한 사용자'
  from admin_mutation_ctx c
 where p.id = c.reactivate_id;

insert into auth.identities(
  provider_id,
  user_id,
  identity_data,
  provider,
  created_at,
  updated_at
)
select
  'google-' || reactivate_id::text,
  reactivate_id,
  pg_catalog.jsonb_build_object(
    'sub',
    'google-' || reactivate_id::text,
    'email',
    'restore-' || reactivate_id::text || '@test.local',
    'name',
    '복구사용자',
    'avatar_url',
    'https://example.test/avatar.png'
  ),
  'google',
  clock_timestamp(),
  clock_timestamp()
  from admin_mutation_ctx;

insert into public.dolls(id, owner_id, image_url)
select
  doll_id,
  owner_id,
  'https://example.test/storage/v1/object/public/dolls/'
    || owner_id::text || '/' || doll_id::text || '.png'
  from admin_mutation_ctx;

insert into public.scores(
  id,
  owner_id,
  doll_id,
  score,
  weapon,
  duration_ms
)
select score_id, owner_id, doll_id, 123, 'fist', 1200
  from admin_mutation_ctx;

insert into public.content_reports(
  target_type,
  target_id,
  reason,
  detail
)
select 'doll', doll_id, 'spam', 'first fixture report'
  from admin_mutation_ctx;

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
  expected_channel_key,
  created_at
)
select
  order_id,
  owner_id,
  'qa-pack',
  1000,
  3,
  'pending',
  'portone',
  pg_catalog.replace(order_id::text, '-', ''),
  true,
  'card',
  'store-qa',
  'KRW',
  'channel-card-test',
  '2026-07-20 00:00:00+00'::timestamptz
  from admin_mutation_ctx;

select is(
  (
    select d.moderation_version
      from public.dolls d
      join admin_mutation_ctx c on c.doll_id = d.id
  ),
  1::bigint,
  'a new report advances the moderation snapshot token'
);

-- ── Config receipt and recovery contract ──────────────────────────────────

update admin_mutation_ctx c
   set first_result = public.admin_update_app_setting_idempotent(
     'marketing_copy',
     '{"hero":"A"}'::jsonb,
     0,
     c.admin_id,
     'first publish',
     c.config_request
   );

select is(
  (select (first_result->>'version')::integer from admin_mutation_ctx),
  1,
  'first config publish creates version one'
);
select is(
  (
    select public.admin_update_app_setting_idempotent(
      'marketing_copy',
      '{"hero":"A"}'::jsonb,
      0,
      admin_id,
      'first publish',
      config_request
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'same config request replays its stored result'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.app_settings_audit a
     where a.key = 'marketing_copy'
  ),
  1,
  'config replay writes one audit row'
);
select throws_ok(
  format(
    $sql$
      select public.admin_update_app_setting_idempotent(
        'marketing_copy',
        '{"hero":"DIFFERENT"}'::jsonb,
        0,
        %L::uuid,
        'first publish',
        %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select config_request from admin_mutation_ctx)
  ),
  'idempotency_conflict',
  'same request UUID cannot bind to a different exact payload'
);
select throws_ok(
  format(
    $sql$
      select public.admin_update_app_setting_idempotent(
        'marketing_copy',
        '{"hero":"B"}'::jsonb,
        0,
        %L::uuid,
        'stale publish',
        %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select config_second_request from admin_mutation_ctx)
  ),
  'version_conflict',
  'a distinct stale config request fails the version precondition'
);
select is(
  (
    select public.get_admin_mutation_receipt(
      admin_id,
      config_request,
      'config_update',
      'marketing_copy'
    )->>'state'
      from admin_mutation_ctx
  ),
  'completed',
  'completed config result is recoverable without another mutation'
);
select throws_ok(
  format(
    $sql$
      select public.get_admin_mutation_receipt(
        %L::uuid,
        %L::uuid,
        'order_settle',
        %L
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    gen_random_uuid(),
    (select order_id::text from admin_mutation_ctx)
  ),
  'invalid_request_context',
  'generic tombstoning recovery cannot preempt settlement custom recovery'
);
select is(
  (
    select public.get_admin_mutation_receipt(
      admin_id,
      aborted_request,
      'config_update',
      'site_content'
    )->>'state'
      from admin_mutation_ctx
  ),
  'aborted',
  'recovery-before-POST creates an aborted tombstone'
);
select throws_ok(
  format(
    $sql$
      select public.admin_update_app_setting_idempotent(
        'site_content',
        '{"footer":"late"}'::jsonb,
        0,
        %L::uuid,
        'late post',
        %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select aborted_request from admin_mutation_ctx)
  ),
  'request_aborted',
  'a POST arriving after recovery cannot mutate'
);
select throws_ok(
  format(
    $sql$
      select public.get_admin_mutation_receipt(
        %L::uuid,
        %L::uuid,
        'config_update',
        'marketing_copy'
      )
    $sql$,
    (select other_admin_id from admin_mutation_ctx),
    (select config_request from admin_mutation_ctx)
  ),
  'idempotency_conflict',
  'a receipt is bound to the initiating admin context'
);
select throws_ok(
  format(
    'delete from public.admin_mutation_requests where request_id = %L::uuid',
    (select aborted_request from admin_mutation_ctx)
  ),
  'admin_mutation_request_append_only',
  'even database-owner cleanup cannot silently delete a receipt'
);

-- ── Event exactly-once and cycle-safe version fencing ─────────────────────

do $event_create$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_save_event_idempotent(
    null,
    'notice',
    'Original',
    'Fixture summary',
    'Fixture body',
    null,
    null,
    null,
    false,
    true,
    false,
    false,
    10,
    true,
    false,
    7,
    c.admin_id,
    0,
    c.event_create_request,
    'new:' || c.event_create_request::text
  );
  update admin_mutation_ctx
     set event_id = (r->>'id')::uuid,
         event_version = (r->>'version')::bigint,
         first_result = r;
end;
$event_create$;

select is(
  (select event_version from admin_mutation_ctx),
  1::bigint,
  'event create starts at mutation version one'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.events e
      join admin_mutation_ctx c on c.event_id = e.id
  ),
  1,
  'event create persists exactly one row'
);
select is(
  (
    select public.admin_save_event_idempotent(
      null, 'notice', 'Original', 'Fixture summary', 'Fixture body',
      null, null, null, false, true, false, false, 10, true, false, 7,
      admin_id, 0, event_create_request,
      'new:' || event_create_request::text
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'lost event-create response replays without a duplicate row'
);
select is(
  (
    select public.admin_save_event_idempotent(
      null, 'notice', 'Original', 'Fixture summary', 'Fixture body',
      null, null, null, false, true, false, false, 10, true, false, 7,
      admin_id, 0, gen_random_uuid(),
      'new:' || event_create_request::text
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'a rotated delivery UUID converges on the same event-create intent'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.admin_mutation_requests r
      join admin_mutation_ctx c
        on r.target_key = 'new:' || c.event_create_request::text
     where r.operation = 'event_save'
       and r.state = 'completed'
  ),
  2,
  'converged event-create deliveries each receive a durable receipt'
);

do $event_noop$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_save_event_idempotent(
    c.event_id,
    'notice',
    'Original',
    'Fixture summary',
    'Fixture body',
    null,
    null,
    null,
    false,
    true,
    false,
    false,
    10,
    true,
    false,
    7,
    c.admin_id,
    1,
    c.event_noop_request,
    c.event_id::text
  );
  update admin_mutation_ctx set second_result = r;
end;
$event_noop$;

select is(
  (select second_result->>'noOp' from admin_mutation_ctx),
  'true',
  'same event snapshot and content is a durable no-op'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.events_audit a
      join admin_mutation_ctx c on c.event_id = a.event_id
  ),
  1,
  'same-content save does not manufacture an audit change'
);

do $event_changes$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_save_event_idempotent(
    c.event_id, 'notice', 'Changed', 'Fixture summary', 'Fixture body',
    null, null, null, false, true, false, false, 10, true, false, 7,
    c.admin_id, 1, c.event_modify_request, c.event_id::text
  );
  if (r->>'version')::bigint <> 2 then
    raise exception 'event_modify_version_unexpected';
  end if;
  r := public.admin_save_event_idempotent(
    c.event_id, 'notice', 'Original', 'Fixture summary', 'Fixture body',
    null, null, null, false, true, false, false, 10, true, false, 7,
    c.admin_id, 2, c.event_restore_request, c.event_id::text
  );
  update admin_mutation_ctx
     set event_version = (r->>'version')::bigint,
         second_result = r;
end;
$event_changes$;

select is(
  (select event_version from admin_mutation_ctx),
  3::bigint,
  'two real event edits advance the version twice'
);
select throws_ok(
  format(
    $sql$
      select public.admin_save_event_idempotent(
        %L::uuid, 'notice', 'Original', 'Fixture summary', 'Fixture body',
        null, null, null, false, true, false, false, 10, true, false, 7,
        %L::uuid, 1, %L::uuid, %L
      )
    $sql$,
    (select event_id from admin_mutation_ctx),
    (select admin_id from admin_mutation_ctx),
    gen_random_uuid(),
    (select event_id::text from admin_mutation_ctx)
  ),
  'version_conflict',
  'A-B-A content cycle cannot make a stale same-content save valid'
);

do $event_transitions$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_transition_event_idempotent(
    c.event_id, 'publish', 3, c.admin_id, c.event_publish_request
  );
  if (r->>'version')::bigint <> 4 then
    raise exception 'event_publish_version_unexpected';
  end if;
  r := public.admin_transition_event_idempotent(
    c.event_id, 'unpublish', 4, c.admin_id, c.event_unpublish_request
  );
  if (r->>'version')::bigint <> 5 then
    raise exception 'event_unpublish_version_unexpected';
  end if;
  r := public.admin_transition_event_idempotent(
    c.event_id, 'publish', 5, c.admin_id, c.event_republish_request
  );
  update admin_mutation_ctx
     set event_version = (r->>'version')::bigint,
         first_result = r;
end;
$event_transitions$;

select is(
  (select event_version from admin_mutation_ctx),
  6::bigint,
  'publish/unpublish/republish transitions are all versioned'
);
select is(
  (
    select public.admin_transition_event_idempotent(
      event_id,
      'publish',
      5,
      admin_id,
      event_republish_request
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'event transition response loss replays the original receipt'
);
select throws_ok(
  format(
    'select public.admin_transition_event_idempotent(%L::uuid,%L,3,%L::uuid,%L::uuid)',
    (select event_id from admin_mutation_ctx),
    'publish',
    (select admin_id from admin_mutation_ctx),
    gen_random_uuid()
  ),
  'version_conflict',
  'published-draft-published cycle rejects a stale publish snapshot'
);

do $event_delete$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_transition_event_idempotent(
    c.event_id, 'delete', 6, c.admin_id, c.event_delete_request
  );
  if (r->>'version')::bigint <> 7 then
    raise exception 'event_delete_version_unexpected';
  end if;
  r := public.admin_transition_event_idempotent(
    c.event_id, 'delete', 6, c.admin_id, c.event_delete_noop_request
  );
  update admin_mutation_ctx
     set event_version = (r->>'version')::bigint,
         second_result = r;
end;
$event_delete$;

select is(
  (select second_result->>'noOp' from admin_mutation_ctx),
  'true',
  'an equivalent delete losing by one version converges as a no-op'
);
select throws_ok(
  format(
    'select public.admin_transition_event_idempotent(%L::uuid,%L,3,%L::uuid,%L::uuid)',
    (select event_id from admin_mutation_ctx),
    'delete',
    (select admin_id from admin_mutation_ctx),
    gen_random_uuid()
  ),
  'version_conflict',
  'a much older delete snapshot cannot hide behind deleted state'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.events_audit a
      join admin_mutation_ctx c on c.event_id = a.event_id
  ),
  7,
  'event create, two edits, three status changes, and delete audit once each'
);

-- ── Integrity actions and state-cycle fencing ─────────────────────────────

do $integrity_score$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_integrity_action_idempotent(
    'clear', c.admin_id, c.score_id, 'clear fixture score',
    'registered', 0, c.integrity_clear_request
  );
  if (r->>'version')::bigint <> 1 then
    raise exception 'clear_version_unexpected';
  end if;
  r := public.admin_integrity_action_idempotent(
    'clear', c.admin_id, c.score_id, 'concurrent fixture clear',
    'registered', 0, c.integrity_clear_noop_request
  );
  if r->>'noOp' <> 'true' then
    raise exception 'concurrent_clear_not_noop';
  end if;
  r := public.admin_integrity_action_idempotent(
    'void', c.admin_id, c.score_id, 'void fixture score',
    'cleared', 1, c.integrity_void_request
  );
  if (r->>'version')::bigint <> 2 then
    raise exception 'void_version_unexpected';
  end if;
  r := public.admin_integrity_action_idempotent(
    'clear', c.admin_id, c.score_id, 'reclear fixture score',
    'voided', 2, c.integrity_reclear_request
  );
  update admin_mutation_ctx set first_result = r;
end;
$integrity_score$;

select is(
  (
    select s.integrity_version
      from public.scores s
      join admin_mutation_ctx c on c.score_id = s.id
  ),
  3::bigint,
  'score integrity status transitions have a complete monotonic token'
);
select is(
  (
    select public.admin_integrity_action_idempotent(
      'clear', admin_id, score_id, 'clear fixture score',
      'registered', 0, integrity_clear_request
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'same score action request replays exactly once'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.integrity_actions_ledger l
      join admin_mutation_ctx c on c.score_id = l.target_id
     where l.target_type = 'score'
  ),
  3,
  'score no-op and replay add no integrity ledger rows'
);
select throws_ok(
  format(
    $sql$
      select public.admin_integrity_action_idempotent(
        'clear', %L::uuid, %L::uuid, 'stale cycle clear',
        'registered', 0, %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select score_id from admin_mutation_ctx),
    gen_random_uuid()
  ),
  'state_conflict',
  'registered-cleared-voided-cleared cycle rejects a stale clear'
);

do $integrity_member$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_integrity_action_idempotent(
    'ban', c.admin_id, c.owner_id, 'ban fixture member',
    'clean', 0, c.integrity_ban_request
  );
  if (r->>'version')::bigint <> 1 then
    raise exception 'ban_version_unexpected';
  end if;
  r := public.admin_integrity_action_idempotent(
    'ban', c.admin_id, c.owner_id, 'concurrent fixture ban',
    'clean', 0, c.integrity_ban_noop_request
  );
  if r->>'noOp' <> 'true' then
    raise exception 'concurrent_ban_not_noop';
  end if;
  r := public.admin_integrity_action_idempotent(
    'unban', c.admin_id, c.owner_id, 'unban fixture member',
    'banned', 1, c.integrity_unban_request
  );
  if (r->>'version')::bigint <> 2 then
    raise exception 'unban_version_unexpected';
  end if;
  r := public.admin_integrity_action_idempotent(
    'ban', c.admin_id, c.owner_id, 'reban fixture member',
    'clean', 2, c.integrity_reban_request
  );
  update admin_mutation_ctx set second_result = r;
end;
$integrity_member$;

select is(
  (
    select m.integrity_version
      from public.member_accounts m
      join admin_mutation_ctx c on c.owner_id = m.user_id
  ),
  3::bigint,
  'ban/unban/reban advances the member integrity token'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.integrity_actions_ledger l
      join admin_mutation_ctx c on c.owner_id = l.target_id
     where l.target_type = 'member'
  ),
  3,
  'member no-op and replay add no integrity ledger rows'
);
select throws_ok(
  format(
    $sql$
      select public.admin_integrity_action_idempotent(
        'ban', %L::uuid, %L::uuid, 'stale cycle ban',
        'clean', 0, %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select owner_id from admin_mutation_ctx),
    gen_random_uuid()
  ),
  'state_conflict',
  'clean-banned-clean-banned cycle rejects a stale ban'
);

-- Return the member to an active state so settlement is independent of the
-- integrity fixture's terminal status.
select public.admin_integrity_action_idempotent(
  'unban',
  admin_id,
  owner_id,
  'final fixture unban',
  'banned',
  3,
  gen_random_uuid()
) from admin_mutation_ctx;

-- ── Moderation queue snapshot and reversible action fencing ───────────────

do $moderation_actions$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_moderation_action_idempotent(
    'dismiss', c.admin_id, c.doll_id, 'dismiss fixture reports',
    'pending', 1, c.moderation_dismiss_request
  );
  if r->>'nextState' <> 'dismissed' then
    raise exception 'dismiss_state_unexpected';
  end if;

  insert into public.content_reports(
    target_type, target_id, reason, detail
  ) values (
    'doll', c.doll_id, 'abuse', 'second fixture report'
  );

  select d.moderation_version
    into c.moderation_version
    from public.dolls d
   where d.id = c.doll_id;
  r := public.admin_moderation_action_idempotent(
    'takedown', c.admin_id, c.doll_id, 'hide fixture doll',
    'pending', c.moderation_version, c.moderation_takedown_request
  );
  c.moderation_version := (r->>'version')::bigint;
  r := public.admin_moderation_action_idempotent(
    'restore', c.admin_id, c.doll_id, 'restore fixture doll',
    'hidden', c.moderation_version, c.moderation_restore_request
  );
  update admin_mutation_ctx
     set moderation_version = (r->>'version')::bigint,
         first_result = r;
end;
$moderation_actions$;

select is(
  (
    select public.admin_moderation_action_idempotent(
      'dismiss', admin_id, doll_id, 'dismiss fixture reports',
      'pending', 1, moderation_dismiss_request
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'same moderation request replays its receipt'
);
select is(
  (
    select case
      when d.deleted_at is null
       and not exists (
         select 1
           from public.content_reports r
          where r.target_type = 'doll'
            and r.target_id = d.id
            and r.status = 'pending'
       )
      then 'dismissed'
      else 'unexpected'
    end
      from public.dolls d
      join admin_mutation_ctx c on c.doll_id = d.id
  ),
  'dismissed',
  'restore returns the doll to visible/dismissed state'
);
select is(
  (
    select (
      public.admin_moderation_queue(
        admin_id, null, doll_id, null, 10, 0
      )#>>'{rows,0,moderationVersion}'
    )::bigint
      from admin_mutation_ctx
  ),
  (select moderation_version from admin_mutation_ctx),
  'moderation queue exposes the exact current snapshot token'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.moderation_actions_ledger l
      join admin_mutation_ctx c on c.doll_id = l.target_id
  ),
  3,
  'dismiss, takedown, and restore each produce one moderation audit'
);
select throws_ok(
  format(
    $sql$
      select public.admin_moderation_action_idempotent(
        'takedown', %L::uuid, %L::uuid, 'stale moderation action',
        'pending', 3, %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select doll_id from admin_mutation_ctx),
    gen_random_uuid()
  ),
  'state_conflict',
  'a delayed moderation action cannot cross dismiss/hide/restore history'
);

-- ── Permanent moderation: exact intent + hidden snapshot ABA fence ────────

create temporary table permanent_purge_ctx (
  stale_version bigint,
  current_version bigint,
  stale_request uuid not null default gen_random_uuid(),
  request_id uuid not null default gen_random_uuid(),
  job_id uuid,
  lease jsonb,
  first_result jsonb
) on commit drop;
insert into permanent_purge_ctx default values;

do $permanent_aba$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
  v_stale bigint;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_moderation_action_idempotent(
    'takedown',
    c.admin_id,
    c.doll_id,
    'first ABA hidden state',
    'dismissed',
    c.moderation_version,
    gen_random_uuid()
  );
  v_stale := (r->>'version')::bigint;
  r := public.admin_moderation_action_idempotent(
    'restore',
    c.admin_id,
    c.doll_id,
    'restore between ABA states',
    'hidden',
    v_stale,
    gen_random_uuid()
  );
  r := public.admin_moderation_action_idempotent(
    'takedown',
    c.admin_id,
    c.doll_id,
    'second ABA hidden state',
    'dismissed',
    (r->>'version')::bigint,
    gen_random_uuid()
  );
  update permanent_purge_ctx
     set stale_version = v_stale,
         current_version = (r->>'version')::bigint;
end;
$permanent_aba$;

select ok(
  (
    select p.current_version > p.stale_version
       and d.deleted_at is not null
       and d.moderation_version = p.current_version
      from permanent_purge_ctx p
      cross join admin_mutation_ctx c
      join public.dolls d on d.id = c.doll_id
  ),
  'hidden-restore-hidden returns to hidden with a newer snapshot token'
);
select throws_ok(
  format(
    $sql$
      select public.admin_begin_doll_purge_idempotent(
        %L::uuid, %L::uuid, 'stale ABA permanent delete',
        'hidden', %s, %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select doll_id from admin_mutation_ctx),
    (select stale_version from permanent_purge_ctx),
    (select stale_request from permanent_purge_ctx)
  ),
  'state_conflict',
  'a stale first hidden snapshot cannot purge a later hidden incarnation'
);

update permanent_purge_ctx p
   set first_result = public.admin_begin_doll_purge_idempotent(
         c.admin_id,
         c.doll_id,
         'permanently delete fixture doll',
         'hidden',
         p.current_version,
         p.request_id
       )
  from admin_mutation_ctx c;
update permanent_purge_ctx
   set job_id = (first_result->>'job_id')::uuid;

select is(
  (select first_result->>'idempotent' from permanent_purge_ctx),
  'false',
  'first permanent-delete intent stores a non-replay begin result'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.moderation_purge_jobs j
      join permanent_purge_ctx p on p.job_id = j.id
     where j.status = 'pending'
  ),
  1,
  'first permanent-delete intent creates exactly one durable purge job'
);
select is(
  (
    select (
      public.admin_begin_doll_purge_idempotent(
        c.admin_id,
        c.doll_id,
        'permanently delete fixture doll',
        'hidden',
        p.current_version,
        p.request_id
      )->>'job_id'
    )::uuid
      from admin_mutation_ctx c
      cross join permanent_purge_ctx p
  ),
  (select job_id from permanent_purge_ctx),
  'same permanent-delete request replays the exact purge job'
);
select is(
  (
    select public.admin_begin_doll_purge_idempotent(
      c.admin_id,
      c.doll_id,
      'permanently delete fixture doll',
      'hidden',
      p.current_version,
      p.request_id
    )->>'idempotent'
      from admin_mutation_ctx c
      cross join permanent_purge_ctx p
  ),
  'true',
  'lost permanent-delete response returns the completed intent receipt'
);
select throws_ok(
  format(
    $sql$
      select public.admin_begin_doll_purge_idempotent(
        %L::uuid, %L::uuid, 'changed permanent delete reason',
        'hidden', %s, %L::uuid
      )
    $sql$,
    (select admin_id from admin_mutation_ctx),
    (select doll_id from admin_mutation_ctx),
    (select current_version from permanent_purge_ctx),
    (select request_id from permanent_purge_ctx)
  ),
  'idempotency_conflict',
  'same permanent-delete UUID cannot bind to a changed exact payload'
);
select is(
  (
    select (
      public.get_admin_mutation_receipt(
        c.admin_id,
        p.request_id,
        'moderation_permanent_delete',
        c.doll_id::text
      )#>>'{result,job_id}'
    )::uuid
      from admin_mutation_ctx c
      cross join permanent_purge_ctx p
  ),
  (select job_id from permanent_purge_ctx),
  'permanent-delete begin receipt is recoverable by operation and target'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.admin_mutation_requests r
      cross join permanent_purge_ctx p
     where r.request_id = p.request_id
       and r.operation = 'moderation_permanent_delete'
       and r.state = 'completed'
  ),
  1,
  'permanent-delete replay keeps exactly one append-only intent receipt'
);

update public.moderation_purge_jobs j
   set final_sweep_after =
         pg_catalog.clock_timestamp() - interval '1 second',
       next_attempt_at =
         pg_catalog.clock_timestamp() - interval '1 second'
  from permanent_purge_ctx p
 where j.id = p.job_id;
update permanent_purge_ctx
   set lease = public.claim_moderation_purge_v2(
     job_id, 120, 100
   );
select is(
  (
    select public.finish_moderation_purge_v2(
      p.job_id,
      (p.lease->>'lease_token')::uuid,
      (p.lease->>'lease_version')::integer,
      true,
      null
    )->>'status'
      from permanent_purge_ctx p
  ),
  'completed',
  'fixture reaches terminal purge after the first HTTP delivery'
);
select is(
  (
    select public.get_moderation_purge_status(
      c.admin_id,
      p.job_id,
      c.doll_id
    )->>'status'
      from admin_mutation_ctx c
      cross join permanent_purge_ctx p
  ),
  'completed',
  'unclaimable completed job has an authoritative terminal status'
);
select is(
  (
    select (
      public.admin_begin_doll_purge_idempotent(
        c.admin_id,
        c.doll_id,
        'permanently delete fixture doll',
        'hidden',
        p.current_version,
        p.request_id
      )->>'job_id'
    )::uuid
      from admin_mutation_ctx c
      cross join permanent_purge_ctx p
  ),
  (select job_id from permanent_purge_ctx),
  'same request after terminal completion replays the job used for HTTP 200 recovery'
);

-- ── Reactivation: external auth first, database activation last ───────────

create temporary table reactivation_no_member_ctx as
select
  pg_catalog.gen_random_uuid() as user_id,
  pg_catalog.gen_random_uuid() as request_id,
  '2026-07-20 01:02:04+00'::timestamptz as deleted_at;
insert into auth.users(id, email, raw_app_meta_data)
select
  n.user_id,
  'deleted+' || n.user_id::text || '@deleted.invalid',
  '{"provider":"email"}'::jsonb
  from reactivation_no_member_ctx n;
update public.profiles p
   set deleted_at = n.deleted_at,
       display_name = '탈퇴한 사용자'
  from reactivation_no_member_ctx n
 where p.id = n.user_id;
select throws_ok(
  format(
    'select public.admin_begin_account_reactivation(%L::uuid,%L::uuid,%L,%L,%L::timestamptz,%s,%L::uuid)',
    (select user_id from reactivation_no_member_ctx),
    (select admin_id from admin_mutation_ctx),
    'restore missing member',
    'missing-member@test.local',
    (select deleted_at from reactivation_no_member_ctx),
    (
      select p.withdrawal_generation
        from public.profiles p
        join reactivation_no_member_ctx n on n.user_id = p.id
    ),
    (select request_id from reactivation_no_member_ctx)
  ),
  'member_not_found',
  'reactivation cannot report success for a profile without member authority'
);

do $reactivation_begin$
declare
  c admin_mutation_ctx%rowtype;
  r jsonb;
  r2 jsonb;
begin
  select * into c from admin_mutation_ctx;
  r := public.admin_begin_account_reactivation(
    c.reactivate_id,
    c.admin_id,
    'restore fixture account',
    null,
    c.deleted_at,
    c.reactivation_request
  );
  r2 := public.admin_begin_account_reactivation(
    c.reactivate_id,
    c.admin_id,
    'restore fixture account',
    null,
    c.deleted_at,
    c.reactivation_resume_request
  );
  update admin_mutation_ctx
     set reactivation_operation =
           (r2->>'operationRequestId')::uuid,
         first_result = r,
         second_result = r2;
end;
$reactivation_begin$;

select is(
  (select first_result->>'pending' from admin_mutation_ctx),
  'true',
  'reactivation begin returns an external-sync pending step'
);
select is(
  (
    select p.deleted_at
      from public.profiles p
      join admin_mutation_ctx c on c.reactivate_id = p.id
  ),
  (select deleted_at from admin_mutation_ctx),
  'begin never exposes an active DB account before GoTrue succeeds'
);
select is(
  (select reactivation_operation from admin_mutation_ctx),
  (select reactivation_request from admin_mutation_ctx),
  'a second tab resumes the exact pending reactivation operation'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.admin_mutation_requests r
      join admin_mutation_ctx c
        on r.target_key = c.reactivate_id::text
     where r.operation = 'account_reactivate'
       and r.state = 'pending'
  ),
  1,
  'one account has exactly one pending reactivation receipt'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.account_reactivation_jobs j
      join admin_mutation_ctx c
        on c.reactivation_request = j.request_id
     where j.admin_user_id = c.admin_id
       and j.user_id = c.reactivate_id
       and j.expected_deleted_at = c.deleted_at
       and j.status = 'pending'
  ),
  1,
  'reactivation begin atomically binds one exact external-sync job'
);
select ok(
  (
    select (q.pending->>'found')::boolean
       and (q.pending->>'request_id')::uuid =
             c.reactivation_request
       and (q.pending->>'admin_user_id')::uuid = c.admin_id
       and (q.pending->>'user_id')::uuid = c.reactivate_id
       and (q.pending->>'expected_deleted_at')::timestamptz =
             c.deleted_at
       and (
             q.pending->>'expected_withdrawal_generation'
           )::bigint = p.withdrawal_generation
       and q.pending->>'job_status' = 'pending'
       and not (q.pending->>'cancel_requested')::boolean
      from admin_mutation_ctx c
      join public.profiles p on p.id = c.reactivate_id
      cross join lateral public.get_pending_account_reactivation(
        c.admin_id,
        c.reactivate_id
      ) as q(pending)
  ),
  'an admin detail reload recovers the exact pending lifecycle correlation'
);
select is(
  (
    select public.get_pending_account_reactivation(
      admin_id,
      owner_id
    )->>'found'
      from admin_mutation_ctx
  ),
  'false',
  'a pending correlation is never returned for a different target user'
);
select throws_ok(
  format(
    'select public.get_pending_account_reactivation(%L::uuid,%L::uuid)',
    (select owner_id from admin_mutation_ctx),
    (select reactivate_id from admin_mutation_ctx)
  ),
  'not_admin',
  'a non-admin cannot read any pending reactivation correlation'
);
alter table public.admin_mutation_requests
  disable trigger trg_admin_mutation_requests_guard;
update public.admin_mutation_requests r
   set request_payload = pg_catalog.jsonb_set(
         r.request_payload,
         '{resolved_email}',
         '"corrupt-pending-read@test.local"'::jsonb
       )
  from admin_mutation_ctx c
 where r.request_id = c.reactivation_request;
alter table public.admin_mutation_requests
  enable trigger trg_admin_mutation_requests_guard;
select throws_ok(
  format(
    'select public.get_pending_account_reactivation(%L::uuid,%L::uuid)',
    (select admin_id from admin_mutation_ctx),
    (select reactivate_id from admin_mutation_ctx)
  ),
  'reactivation_job_invalid',
  'a live job with a corrupt receipt is fail-visible instead of hidden as no pending work'
);
alter table public.admin_mutation_requests
  disable trigger trg_admin_mutation_requests_guard;
update public.admin_mutation_requests r
   set request_payload = pg_catalog.jsonb_set(
         r.request_payload,
         '{resolved_email}',
         pg_catalog.to_jsonb(j.resolved_email)
       )
  from public.account_reactivation_jobs j
  join admin_mutation_ctx c
    on c.reactivation_request = j.request_id
 where r.request_id = j.request_id;
alter table public.admin_mutation_requests
  enable trigger trg_admin_mutation_requests_guard;
select throws_ok(
  format(
    'update public.account_reactivation_jobs set expected_withdrawal_generation = expected_withdrawal_generation + 1 where request_id = %L::uuid',
    (select reactivation_request from admin_mutation_ctx)
  ),
  'account_reactivation_job_immutable',
  'the withdrawal lifecycle generation is immutable after job creation'
);

update admin_mutation_ctx c
   set second_result = public.claim_account_reactivation_job(
     c.reactivation_request,
     c.admin_id,
     c.reactivate_id,
     120
   );
select ok(
  (
    select (second_result->>'request_id')::uuid = reactivation_request
       and (second_result->>'admin_user_id')::uuid = admin_id
       and (second_result->>'user_id')::uuid = reactivate_id
       and (second_result->>'lease_version')::integer = 1
       and (second_result->>'attempt_count')::integer = 1
       and (second_result->>'expected_withdrawal_generation')::bigint =
             (
               select p.withdrawal_generation
                 from public.profiles p
                where p.id = reactivate_id
             )
       and second_result->'preflight_error' = 'null'::jsonb
      from admin_mutation_ctx
  ),
  'claim returns the exact request/admin/target correlation and first fence'
);
select throws_ok(
  format(
    'update public.profiles set deleted_at = deleted_at + interval ''1 second'' where id = %L::uuid',
    (select reactivate_id from admin_mutation_ctx)
  ),
  'account_reactivation_in_progress',
  'pending or leased job prevents deletion-timestamp ABA'
);
select throws_ok(
  format(
    'select public.finish_account_reactivation_job(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%s,true,null)',
    (select reactivation_request from admin_mutation_ctx),
    (select admin_id from admin_mutation_ctx),
    (select reactivate_id from admin_mutation_ctx),
    gen_random_uuid(),
    (
      select (second_result->>'lease_version')::integer
        from admin_mutation_ctx
    )
  ),
  'stale_lease',
  'wrong lease token cannot complete a reactivation'
);
select throws_ok(
  format(
    'select public.admin_complete_account_reactivation(%L::uuid,%L::uuid,%L::uuid)',
    (select reactivate_id from admin_mutation_ctx),
    (select admin_id from admin_mutation_ctx),
    (select reactivation_request from admin_mutation_ctx)
  ),
  'auth_email_not_synchronized',
  'database activation fails closed until GoTrue email is restored'
);
select is(
  (
    select p.deleted_at
      from public.profiles p
      join admin_mutation_ctx c on c.reactivate_id = p.id
  ),
  (select deleted_at from admin_mutation_ctx),
  'failed external synchronization leaves the DB account withdrawn'
);

update auth.identities i
   set identity_data = pg_catalog.jsonb_set(
         i.identity_data,
         '{email}',
         pg_catalog.to_jsonb(
           'changed-' || c.reactivate_id::text || '@test.local'
         )
       ),
       updated_at = clock_timestamp()
  from admin_mutation_ctx c
 where i.user_id = c.reactivate_id;

select is(
  (
    select public.admin_begin_account_reactivation(
      reactivate_id,
      admin_id,
      'restore fixture account',
      null,
      deleted_at,
      reactivation_request
    )->>'email'
      from admin_mutation_ctx
  ),
  (
    select 'restore-' || reactivate_id::text || '@test.local'
      from admin_mutation_ctx
  ),
  'pending reactivation replay keeps the originally resolved external email'
);
select throws_ok(
  format(
    'select public.admin_complete_account_reactivation(%L::uuid,%L::uuid,%L::uuid)',
    (select reactivate_id from admin_mutation_ctx),
    (select admin_id from admin_mutation_ctx),
    (select reactivation_request from admin_mutation_ctx)
  ),
  'reactivation_email_changed',
  'identity drift cannot change a pending request external side effect'
);

update auth.identities i
   set identity_data = pg_catalog.jsonb_set(
         i.identity_data,
         '{email}',
         pg_catalog.to_jsonb(
           'restore-' || c.reactivate_id::text || '@test.local'
         )
       ),
       updated_at = clock_timestamp()
  from admin_mutation_ctx c
 where i.user_id = c.reactivate_id;

select throws_ok(
  $stale_auth_fence$
    update auth.users u
       set email = j.resolved_email,
           raw_app_meta_data =
             coalesce(u.raw_app_meta_data, '{}'::jsonb)
             || pg_catalog.jsonb_build_object(
                  'bp_reactivation_fence',
                  pg_catalog.jsonb_build_object(
                    'request_id', j.request_id,
                    'admin_user_id', j.admin_user_id,
                    'user_id', j.user_id,
                    'lease_token', pg_catalog.gen_random_uuid(),
                    'lease_version', j.lease_version,
                    'action', 'activate',
                    'expected_deleted_at', j.expected_deleted_at,
                    'expected_withdrawal_generation',
                      j.expected_withdrawal_generation
                  )
                ),
           updated_at = clock_timestamp()
      from public.account_reactivation_jobs j
      join admin_mutation_ctx c
        on c.reactivation_request = j.request_id
     where u.id = c.reactivate_id
  $stale_auth_fence$,
  'stale_reactivation_auth_fence',
  'a wrong lease token cannot perform the external Auth side effect'
);

do $arm_main_reactivation$
declare
  c admin_mutation_ctx%rowtype;
begin
  select * into c from admin_mutation_ctx;
  perform public.arm_account_reactivation_auth_fence(
    c.reactivation_request,
    c.admin_id,
    c.reactivate_id,
    (c.second_result->>'lease_token')::uuid,
    (c.second_result->>'lease_version')::integer
  );
end;
$arm_main_reactivation$;

update auth.users u
   set email = j.resolved_email,
       updated_at = clock_timestamp()
  from public.account_reactivation_jobs j
  join admin_mutation_ctx c
    on c.reactivation_request = j.request_id
 where u.id = c.reactivate_id;

update admin_mutation_ctx c
   set first_result = public.admin_complete_account_reactivation(
     c.reactivate_id,
     c.admin_id,
     c.reactivation_request
   );

-- Production fires this deferred transition check at the end of the finish
-- transaction. pgTAP intentionally keeps one outer transaction, so flush it
-- here while Auth is still synchronized, then restore the production mode.
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair immediate;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair deferred;

select is(
  (select first_result->>'accountReactivated' from admin_mutation_ctx),
  'true',
  'rolling no-lease completion activates only after Auth synchronization'
);
select ok(
  (
    select p.deleted_at is null
       and m.email =
         'restore-' || c.reactivate_id::text || '@test.local'
       and m.reconsent_required
       and not coalesce(u.raw_app_meta_data, '{}'::jsonb)
                 ? 'bp_reactivation_fence'
      from admin_mutation_ctx c
      join public.profiles p on p.id = c.reactivate_id
      join public.member_accounts m on m.user_id = c.reactivate_id
      join auth.users u on u.id = c.reactivate_id
  ),
  'completion restores identity fields, clears its private fence, and requires fresh legal consent'
);
select is(
  (
    select public.admin_complete_account_reactivation(
      reactivate_id,
      admin_id,
      reactivation_request
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'reactivation completion response loss replays without another activation'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.account_admin_actions_ledger l
      join admin_mutation_ctx c
        on c.reactivate_id = l.target_user_id
  ),
  1,
  'reactivation replay writes one lifecycle audit row'
);
select is(
  (
    select state
      from public.admin_mutation_requests r
      join admin_mutation_ctx c
        on c.reactivation_request = r.request_id
  ),
  'completed',
  'reactivation receipt atomically reaches completed state'
);
select ok(
  (
    select public.get_account_reactivation_status(
             reactivation_request,
             admin_id,
             reactivate_id
           )->>'status' = 'completed'
       and (
         public.get_account_reactivation_queue_health()
           ->>'retry_pending'
       )::integer = 0
       and public.get_account_reactivation_queue_health()
             ->'oldest_pending' = 'null'::jsonb
      from admin_mutation_ctx
  ),
  'terminal status and queue health prove no hidden reactivation retry remains'
);

create temporary table reactivation_exact_finish_ctx (
  user_id uuid primary key,
  request_id uuid not null,
  deleted_at timestamptz not null,
  resolved_email text not null,
  expected_generation bigint,
  begin_result jsonb,
  lease jsonb,
  finish_result jsonb
) on commit drop;
insert into reactivation_exact_finish_ctx(
  user_id,
  request_id,
  deleted_at,
  resolved_email
)
values (
  pg_catalog.gen_random_uuid(),
  pg_catalog.gen_random_uuid(),
  '2026-07-20 01:02:05+00'::timestamptz,
  'exact-worker-reactivation@test.local'
);
insert into auth.users(id, email, raw_app_meta_data)
select
  user_id,
  'deleted+' || user_id::text || '@deleted.invalid',
  '{"provider":"google","keep":"preserved"}'::jsonb
  from reactivation_exact_finish_ctx;
insert into public.member_accounts(
  user_id,
  gen_credits,
  email,
  is_admin
)
select user_id, 0, null, false
  from reactivation_exact_finish_ctx;
update public.profiles p
   set deleted_at = x.deleted_at,
       display_name = '탈퇴한 사용자'
  from reactivation_exact_finish_ctx x
 where p.id = x.user_id;
insert into auth.identities(
  provider_id,
  user_id,
  identity_data,
  provider,
  created_at,
  updated_at
)
select
  'google-' || user_id::text,
  user_id,
  pg_catalog.jsonb_build_object(
    'sub', 'google-' || user_id::text,
    'email', resolved_email,
    'name', '정확완료'
  ),
  'google',
  clock_timestamp(),
  clock_timestamp()
  from reactivation_exact_finish_ctx;
update reactivation_exact_finish_ctx x
   set expected_generation = p.withdrawal_generation
  from public.profiles p
 where p.id = x.user_id;
update reactivation_exact_finish_ctx x
   set begin_result = public.admin_begin_account_reactivation(
     x.user_id,
     c.admin_id,
     'exact worker activation',
     null,
     x.deleted_at,
     x.expected_generation,
     x.request_id
   )
  from admin_mutation_ctx c;
update reactivation_exact_finish_ctx x
   set lease = public.claim_account_reactivation_job(
     x.request_id,
     c.admin_id,
     x.user_id,
     120
   )
  from admin_mutation_ctx c;
do $arm_exact_worker_reactivation$
declare
  x reactivation_exact_finish_ctx%rowtype;
  c admin_mutation_ctx%rowtype;
begin
  select * into x from reactivation_exact_finish_ctx;
  select * into c from admin_mutation_ctx;
  perform public.arm_account_reactivation_auth_fence(
    x.request_id,
    c.admin_id,
    x.user_id,
    (x.lease->>'lease_token')::uuid,
    (x.lease->>'lease_version')::integer
  );
end;
$arm_exact_worker_reactivation$;
update auth.users u
   set email = x.resolved_email,
       updated_at = clock_timestamp()
  from reactivation_exact_finish_ctx x
 where u.id = x.user_id;
update reactivation_exact_finish_ctx x
   set finish_result = public.finish_account_reactivation_job(
     x.request_id,
     c.admin_id,
     x.user_id,
     (x.lease->>'lease_token')::uuid,
     (x.lease->>'lease_version')::integer,
     true,
     null
   )
  from admin_mutation_ctx c;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair immediate;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair deferred;
select is(
  (select finish_result->>'status' from reactivation_exact_finish_ctx),
  'completed',
  'the permanent exact leased activate finish reaches completed'
);
select ok(
  (
    select p.deleted_at is null
       and p.withdrawal_generation = x.expected_generation
       and m.email = x.resolved_email
       and m.reconsent_required
       and u.email = x.resolved_email
       and u.raw_app_meta_data->>'keep' = 'preserved'
       and not coalesce(u.raw_app_meta_data, '{}'::jsonb)
                 ? 'bp_reactivation_fence'
       and j.status = 'completed'
       and j.lease_token is null
       and r.state = 'completed'
       and (r.result->>'accountReactivated')::boolean
       and (
         select pg_catalog.count(*)
           from public.account_admin_actions_ledger l
          where l.target_user_id = x.user_id
            and l.action_type = 'account_reactivate'
       ) = 1
      from reactivation_exact_finish_ctx x
      join public.profiles p on p.id = x.user_id
      join public.member_accounts m on m.user_id = x.user_id
      join auth.users u on u.id = x.user_id
      join public.account_reactivation_jobs j
        on j.request_id = x.request_id
      join public.admin_mutation_requests r
        on r.request_id = x.request_id
  ),
  'exact finish atomically activates DB, completes receipt/job/audit, and preserves unrelated metadata'
);
select ok(
  (
    select s.status->>'status' = 'completed'
       and (
             s.status->'result'->>'accountReactivated'
           )::boolean
       and (s.status->>'request_id')::uuid = x.request_id
      from reactivation_exact_finish_ctx x
      cross join admin_mutation_ctx c
      cross join lateral public.get_account_reactivation_status(
        x.request_id,
        c.admin_id,
        x.user_id
      ) as s(status)
  ),
  'exact activate finish response loss recovers from terminal status'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from reactivation_exact_finish_ctx x
      join public.account_reactivation_legacy_repairs j
        on j.user_id = x.user_id
  ),
  0,
  'the permanent Auth-first path never enqueues the rolling DB-first repair outbox'
);

do $withdraw_again_with_fenced_cleanup$
declare
  c admin_mutation_ctx%rowtype;
  v_start jsonb;
  v_lease jsonb;
  v_finish jsonb;
begin
  select * into c from admin_mutation_ctx;
  v_start := public.admin_soft_delete_account(c.reactivate_id);
  update public.account_deletion_cleanup_jobs
     set final_sweep_after =
           pg_catalog.clock_timestamp() - interval '1 second',
         next_attempt_at =
           pg_catalog.clock_timestamp() - interval '1 second'
   where id = (v_start->>'job_id')::uuid;
  v_lease := public.claim_account_deletion_cleanup_v2(
    (v_start->>'job_id')::uuid,
    120,
    100
  );
  if v_lease is null
     or not coalesce((v_lease->>'scrub_auth')::boolean, false) then
    raise exception 'later withdrawal cleanup did not become Auth-ready';
  end if;
  perform public.arm_account_deletion_cleanup_auth_fence(
    (v_start->>'job_id')::uuid,
    c.reactivate_id,
    (v_lease->>'lease_token')::uuid,
    (v_lease->>'lease_version')::integer
  );
  update auth.users
     set email =
           'deleted+' || c.reactivate_id::text || '@deleted.invalid',
         raw_user_meta_data = '{}'::jsonb,
         updated_at = pg_catalog.clock_timestamp()
   where id = c.reactivate_id;
  v_finish := public.finish_account_deletion_cleanup_v2(
    (v_start->>'job_id')::uuid,
    (v_lease->>'lease_token')::uuid,
    (v_lease->>'lease_version')::integer,
    true,
    null
  );
  if v_finish->>'status' <> 'completed' then
    raise exception 'later withdrawal cleanup did not complete: %', v_finish;
  end if;
end;
$withdraw_again_with_fenced_cleanup$;
select throws_ok(
  $completed_auth_fence$
    update auth.users u
       set email = j.resolved_email,
           updated_at = clock_timestamp()
      from public.account_reactivation_jobs j
      join admin_mutation_ctx c
        on c.reactivation_request = j.request_id
     where u.id = c.reactivate_id
  $completed_auth_fence$,
  'stale_reactivation_auth_fence',
  'a completed old lease cannot restore Auth after a later marker scrub'
);

select is(
  (
    select p.withdrawal_generation
      from public.profiles p
      join public.account_reactivation_jobs j
        on j.user_id = p.id
      join admin_mutation_ctx c
        on c.reactivation_request = j.request_id
  ),
  (
    select j.expected_withdrawal_generation + 1
      from public.account_reactivation_jobs j
      join admin_mutation_ctx c
        on c.reactivation_request = j.request_id
  ),
  'a later withdrawal advances generation even when its timestamp is identical'
);
select throws_ok(
  format(
    'select public.admin_begin_account_reactivation(%L::uuid,%L::uuid,%L,%L,%L::timestamptz,%L::uuid)',
    (select reactivate_id from admin_mutation_ctx),
    (select admin_id from admin_mutation_ctx),
    'restore fixture account',
    null,
    (select deleted_at from admin_mutation_ctx),
    (select reactivation_request from admin_mutation_ctx)
  ),
  'idempotency_conflict',
  'an exact timestamp ABA cannot replay a completed earlier generation receipt'
);

-- ── Reactivation cancellation: exact compensation, never false activation ─

create temporary table reactivation_cancel_ctx as
select
  c.admin_id,
  c.reactivate_id as user_id,
  p.deleted_at,
  p.withdrawal_generation,
  pg_catalog.gen_random_uuid() as request_id,
  pg_catalog.gen_random_uuid() as retry_request_id,
  pg_catalog.gen_random_uuid() as counter_request_id,
  null::jsonb as begin_result,
  null::jsonb as activation_lease,
  null::jsonb as cancel_request,
  null::jsonb as cancel_lease,
  null::jsonb as finish_result,
  null::jsonb as retry_finish,
  null::jsonb as counter_lease,
  null::jsonb as counter_quarantine_claim,
  null::jsonb as counter_finish
  from admin_mutation_ctx c
  join public.profiles p on p.id = c.reactivate_id;

update reactivation_cancel_ctx x
   set begin_result = public.admin_begin_account_reactivation(
     x.user_id,
     x.admin_id,
     'cancel fixture reactivation',
     null,
     x.deleted_at,
     x.withdrawal_generation,
     x.request_id
   );
select is(
  (select begin_result->>'pending' from reactivation_cancel_ctx),
  'true',
  'a later withdrawal generation can start a cancellable reactivation'
);

update reactivation_cancel_ctx x
   set activation_lease = public.claim_account_reactivation_job(
     x.request_id,
     x.admin_id,
     x.user_id,
     120
   );
select is(
  (select activation_lease->>'action' from reactivation_cancel_ctx),
  'activate',
  'the original live lease is explicitly an activation action'
);

do $arm_cancel_fixture_activation$
declare
  x reactivation_cancel_ctx%rowtype;
begin
  select * into x from reactivation_cancel_ctx;
  perform public.arm_account_reactivation_auth_fence(
    x.request_id,
    x.admin_id,
    x.user_id,
    (x.activation_lease->>'lease_token')::uuid,
    (x.activation_lease->>'lease_version')::integer
  );
end;
$arm_cancel_fixture_activation$;
update auth.users u
   set email = x.begin_result->>'email',
       updated_at = clock_timestamp()
  from reactivation_cancel_ctx x
 where u.id = x.user_id;

update reactivation_cancel_ctx x
   set cancel_request =
     public.request_account_reactivation_cancellation(
       x.request_id,
       x.user_id,
       x.admin_id,
       'cancel response-loss recovery',
       x.deleted_at,
       x.withdrawal_generation
     );
select ok(
  (
    select x.cancel_request->>'status' = 'cancel_requested'
       and j.status = 'pending'
       and j.lease_token is null
       and j.leased_until is null
       and j.cancel_requested_by = x.admin_id
       and j.cancel_reason = 'cancel response-loss recovery'
      from reactivation_cancel_ctx x
      join public.account_reactivation_jobs j
        on j.request_id = x.request_id
  ),
  'cancellation durably invalidates the paused activation lease'
);
select ok(
  (
    select (q.pending->>'found')::boolean
       and (q.pending->>'request_id')::uuid = x.request_id
       and (q.pending->>'user_id')::uuid = x.user_id
       and (q.pending->>'expected_deleted_at')::timestamptz =
             x.deleted_at
       and (
             q.pending->>'expected_withdrawal_generation'
           )::bigint = x.withdrawal_generation
       and (q.pending->>'cancel_requested')::boolean
      from reactivation_cancel_ctx x
      cross join lateral public.get_pending_account_reactivation(
        x.admin_id,
        x.user_id
      ) as q(pending)
  ),
  'a reload recovers an already-requested cancellation for compensation'
);
select ok(
  (
    select q.result->>'status' = 'cancel_requested'
       and (q.result->>'idempotent')::boolean
      and j.cancel_requested_by = x.admin_id
      and j.cancel_reason = 'cancel response-loss recovery'
      from reactivation_cancel_ctx x
      join public.account_reactivation_jobs j
        on j.request_id = x.request_id
      cross join admin_mutation_ctx c
      cross join lateral
        public.request_account_reactivation_cancellation(
          x.request_id,
          x.user_id,
          c.other_admin_id,
          'resume from another admin tab',
          x.deleted_at,
          x.withdrawal_generation
        ) as q(result)
  ),
  'another active admin can resume but cannot rewrite a durable cancel intent'
);
select throws_ok(
  format(
    'select public.finish_account_reactivation_job(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%s,true,null)',
    (select request_id from reactivation_cancel_ctx),
    (select admin_id from reactivation_cancel_ctx),
    (select user_id from reactivation_cancel_ctx),
    (
      select activation_lease->>'lease_token'
        from reactivation_cancel_ctx
    ),
    (
      select (activation_lease->>'lease_version')::integer
        from reactivation_cancel_ctx
    )
  ),
  'stale_lease',
  'a paused activation worker cannot finish after cancellation wins'
);

update reactivation_cancel_ctx x
   set cancel_lease = public.claim_account_reactivation_job(
     x.request_id,
     x.admin_id,
     x.user_id,
     120
   );
select ok(
  (
    select cancel_lease->>'action' = 'cancel'
       and (cancel_lease->>'lease_version')::integer >
             (activation_lease->>'lease_version')::integer
      from reactivation_cancel_ctx
  ),
  'the replacement lease is a new monotonic cancellation action'
);

do $arm_cancel_fixture_compensation$
declare
  x reactivation_cancel_ctx%rowtype;
begin
  select * into x from reactivation_cancel_ctx;
  perform public.arm_account_reactivation_auth_fence(
    x.request_id,
    x.admin_id,
    x.user_id,
    (x.cancel_lease->>'lease_token')::uuid,
    (x.cancel_lease->>'lease_version')::integer
  );
end;
$arm_cancel_fixture_compensation$;
select throws_ok(
  $cancel_third_auth_identity$
    update auth.users u
       set email = 'third-cancel-identity@test.local',
           updated_at = clock_timestamp()
      from reactivation_cancel_ctx x
     where u.id = x.user_id
  $cancel_third_auth_identity$,
  'stale_reactivation_auth_fence',
  'a cancellation lease can scrub only its exact restored email'
);
update auth.users u
   set email =
         'deleted+' || x.user_id::text || '@deleted.invalid',
       updated_at = clock_timestamp()
  from reactivation_cancel_ctx x
 where u.id = x.user_id;
update reactivation_cancel_ctx x
   set finish_result = public.finish_account_reactivation_job(
     x.request_id,
     x.admin_id,
     x.user_id,
     (x.cancel_lease->>'lease_token')::uuid,
     (x.cancel_lease->>'lease_version')::integer,
     true,
     null
   );
select is(
  (select finish_result->>'status' from reactivation_cancel_ctx),
  'cancelled',
  'exact real-to-marker compensation reaches a cancelled terminal result'
);
select ok(
  (
    select p.deleted_at = x.deleted_at
       and p.withdrawal_generation = x.withdrawal_generation
       and u.email =
             'deleted+' || x.user_id::text || '@deleted.invalid'
       and not coalesce(u.raw_app_meta_data, '{}'::jsonb)
                 ? 'bp_reactivation_fence'
       and j.status = 'cancelled'
       and r.state = 'cancelled'
       and (r.result->>'cancelled')::boolean
       and (
         select pg_catalog.count(*)
           from public.account_admin_actions_ledger l
          where l.target_user_id = x.user_id
            and l.metadata->>'operation_request_id' =
                  x.request_id::text
            and l.metadata->>'cancelled' = 'true'
       ) = 1
      from reactivation_cancel_ctx x
      join public.profiles p on p.id = x.user_id
      join auth.users u on u.id = x.user_id
      join public.account_reactivation_jobs j
        on j.request_id = x.request_id
      join public.admin_mutation_requests r
        on r.request_id = x.request_id
  ),
  'cancel terminal state preserves deletion, scrubs only its fence, and audits once'
);
select ok(
  (
    select q.status->>'status' = 'cancelled'
       and (q.status->'result'->>'cancelled')::boolean
       and (q.status->>'request_id')::uuid = x.request_id
      from reactivation_cancel_ctx x
      cross join lateral public.get_account_reactivation_status(
        x.request_id,
        x.admin_id,
        x.user_id
      ) as q(status)
  ),
  'cancel response loss recovers only from exact cancelled durable status'
);
select ok(
  (
    select q.result->>'status' = 'cancelled'
       and (q.result->>'idempotent')::boolean
      from reactivation_cancel_ctx x
      cross join lateral
        public.request_account_reactivation_cancellation(
          x.request_id,
          x.user_id,
          x.admin_id,
          'cancel response-loss recovery',
          x.deleted_at,
          x.withdrawal_generation
        ) as q(result)
  ),
  'the exact cancellation request replays without another side effect'
);

do $cancelled_operation_reopens$
declare
  x reactivation_cancel_ctx%rowtype;
  v_lease jsonb;
begin
  select * into x from reactivation_cancel_ctx;
  perform public.admin_begin_account_reactivation(
    x.user_id,
    x.admin_id,
    'retry after cancelled operation',
    null,
    x.deleted_at,
    x.withdrawal_generation,
    x.retry_request_id
  );
  perform public.request_account_reactivation_cancellation(
    x.retry_request_id,
    x.user_id,
    x.admin_id,
    'cancel clean retry operation',
    x.deleted_at,
    x.withdrawal_generation
  );
  v_lease := public.claim_account_reactivation_job(
    x.retry_request_id,
    x.admin_id,
    x.user_id,
    120
  );
  update reactivation_cancel_ctx
     set retry_finish = public.finish_account_reactivation_job(
       x.retry_request_id,
       x.admin_id,
       x.user_id,
       (v_lease->>'lease_token')::uuid,
       (v_lease->>'lease_version')::integer,
       true,
       null
     );
end;
$cancelled_operation_reopens$;
select ok(
  (
    select retry_finish->>'status' = 'cancelled'
       and public.get_account_reactivation_status(
             retry_request_id,
             admin_id,
             user_id
           )->>'status' = 'cancelled'
      from reactivation_cancel_ctx
  ),
  'a cancelled receipt frees the same lifecycle for a fresh exact operation'
);

do $counter_boundary_cancel_begin$
declare
  x reactivation_cancel_ctx%rowtype;
begin
  select * into x from reactivation_cancel_ctx;
  perform public.admin_begin_account_reactivation(
    x.user_id,
    x.admin_id,
    'counter boundary cancellation',
    null,
    x.deleted_at,
    x.withdrawal_generation,
    x.counter_request_id
  );
  perform public.request_account_reactivation_cancellation(
    x.counter_request_id,
    x.user_id,
    x.admin_id,
    'counter boundary cancellation',
    x.deleted_at,
    x.withdrawal_generation
  );
end;
$counter_boundary_cancel_begin$;
-- Seed the mathematically reachable max-1 boundary without executing two
-- billion retries. The guard is immediately restored before product code runs.
alter table public.account_reactivation_jobs
  disable trigger trg_account_reactivation_jobs_guard;
update public.account_reactivation_jobs j
   set lease_version = 2147483646,
       attempt_count = 2147483646,
       next_attempt_at = clock_timestamp()
  from reactivation_cancel_ctx x
 where j.request_id = x.counter_request_id;
alter table public.account_reactivation_jobs
  enable trigger trg_account_reactivation_jobs_guard;
update reactivation_cancel_ctx x
   set counter_lease = public.claim_account_reactivation_job(
     x.counter_request_id,
     x.admin_id,
     x.user_id,
     120
   );
do $counter_boundary_retry$
declare
  x reactivation_cancel_ctx%rowtype;
begin
  select * into x from reactivation_cancel_ctx;
  perform public.finish_account_reactivation_job(
    x.counter_request_id,
    x.admin_id,
    x.user_id,
    (x.counter_lease->>'lease_token')::uuid,
    (x.counter_lease->>'lease_version')::integer,
    false,
    'forced_counter_boundary_retry'
  );
end;
$counter_boundary_retry$;
alter table public.account_reactivation_jobs
  disable trigger trg_account_reactivation_jobs_guard;
update public.account_reactivation_jobs j
   set next_attempt_at = clock_timestamp()
  from reactivation_cancel_ctx x
 where j.request_id = x.counter_request_id;
alter table public.account_reactivation_jobs
  enable trigger trg_account_reactivation_jobs_guard;
update reactivation_cancel_ctx x
   set counter_quarantine_claim =
     public.claim_account_reactivation_job(
       x.counter_request_id,
       x.admin_id,
       x.user_id,
       120
     );
select ok(
  (
    select (x.counter_lease->>'lease_version')::integer =
             2147483647
       and (x.counter_lease->>'attempt_count')::integer =
             2147483647
       and x.counter_quarantine_claim is null
       and j.status = 'pending'
       and j.last_error = 'lease_counter_exhausted'
       and j.next_attempt_at =
             '9999-12-31 23:59:59+00'::timestamptz
      from reactivation_cancel_ctx x
      join public.account_reactivation_jobs j
        on j.request_id = x.counter_request_id
  ),
  'max-1 reaches max exactly, then quarantines without overflow or queue poisoning'
);
do $counter_boundary_cancel_recover$
declare
  x reactivation_cancel_ctx%rowtype;
  v_lease jsonb;
begin
  select * into x from reactivation_cancel_ctx;
  perform public.request_account_reactivation_cancellation(
    x.counter_request_id,
    x.user_id,
    x.admin_id,
    'counter boundary cancellation',
    x.deleted_at,
    x.withdrawal_generation
  );
  v_lease := public.claim_account_reactivation_job(
    x.counter_request_id,
    x.admin_id,
    x.user_id,
    120
  );
  update reactivation_cancel_ctx
     set counter_finish = public.finish_account_reactivation_job(
       x.counter_request_id,
       x.admin_id,
       x.user_id,
       (v_lease->>'lease_token')::uuid,
       (v_lease->>'lease_version')::integer,
       true,
       null
     );
end;
$counter_boundary_cancel_recover$;
select ok(
  (
    select counter_finish->>'status' = 'cancelled'
       and public.get_account_reactivation_status(
             counter_request_id,
             admin_id,
             user_id
           )->>'status' = 'cancelled'
      from reactivation_cancel_ctx
  ),
  'an existing exhausted cancel intent resets its counter epoch and still converges'
);

-- ── Rolling DB-first repair: deferred capture and permanent exact fence ───

create temporary table legacy_repair_ctx (
  user_id uuid primary key,
  resolved_email text not null,
  expected_generation bigint,
  job_id uuid,
  lease jsonb,
  finish_result jsonb
) on commit drop;
insert into legacy_repair_ctx(user_id, resolved_email)
values (
  pg_catalog.gen_random_uuid(),
  'legacy-repair@test.local'
);
insert into auth.users(id, email, raw_app_meta_data)
select
  user_id,
  'deleted+' || user_id::text || '@deleted.invalid',
  '{"provider":"google"}'::jsonb
  from legacy_repair_ctx;
insert into public.member_accounts(
  user_id,
  gen_credits,
  email,
  is_admin
)
select user_id, 0, null, false
  from legacy_repair_ctx;
update public.profiles p
   set deleted_at = '2026-07-20 01:04:00+00'::timestamptz
  from legacy_repair_ctx x
 where p.id = x.user_id;

-- This is the old route's DB-first transaction shape. The constraint trigger
-- must observe the final member email, not the intermediate null.
update public.profiles p
   set deleted_at = null
  from legacy_repair_ctx x
 where p.id = x.user_id;
update public.member_accounts m
   set email = x.resolved_email
  from legacy_repair_ctx x
 where m.user_id = x.user_id;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair immediate;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair deferred;
update legacy_repair_ctx x
   set expected_generation = p.withdrawal_generation,
       job_id = j.id
  from public.profiles p
  join public.account_reactivation_legacy_repairs j
    on j.user_id = p.id
   and j.expected_withdrawal_generation =
         p.withdrawal_generation
 where p.id = x.user_id;
select ok(
  (
    select j.status = 'pending'
       and j.resolved_email = x.resolved_email
       and j.expected_withdrawal_generation =
             x.expected_generation
      from legacy_repair_ctx x
      join public.account_reactivation_legacy_repairs j
        on j.id = x.job_id
  ),
  'the deferred trigger durably captures the old DB-first orphan'
);
select throws_ok(
  $legacy_unfenced_auth_update$
    update auth.users u
       set email = x.resolved_email,
           updated_at = clock_timestamp()
      from legacy_repair_ctx x
     where u.id = x.user_id
  $legacy_unfenced_auth_update$,
  'stale_reactivation_auth_fence',
  'post-contract marker restoration rejects an unfenced legacy repair'
);

update legacy_repair_ctx
   set lease =
     public.claim_account_reactivation_legacy_repair(120);
select ok(
  (
    select lease->>'status' = 'leased'
       and (lease->>'job_id')::uuid = job_id
       and (lease->>'user_id')::uuid = user_id
       and lease->>'email' = resolved_email
       and (lease->>'expected_withdrawal_generation')::bigint =
             expected_generation
       and lease->'preflight_error' = 'null'::jsonb
      from legacy_repair_ctx
  ),
  'legacy repair claim binds exact job, user, email, generation, and lease'
);
select throws_ok(
  format(
    'select public.arm_account_reactivation_legacy_repair_auth_fence(%L::uuid,%L::uuid,%L::uuid,%s)',
    (select job_id from legacy_repair_ctx),
    (select user_id from legacy_repair_ctx),
    pg_catalog.gen_random_uuid(),
    (
      select (lease->>'lease_version')::integer
        from legacy_repair_ctx
    )
  ),
  'stale_lease',
  'a wrong token cannot arm a legacy Auth repair fence'
);
do $arm_legacy_repair$
declare
  x legacy_repair_ctx%rowtype;
begin
  select * into x from legacy_repair_ctx;
  perform public.arm_account_reactivation_legacy_repair_auth_fence(
    x.job_id,
    x.user_id,
    (x.lease->>'lease_token')::uuid,
    (x.lease->>'lease_version')::integer
  );
end;
$arm_legacy_repair$;
select throws_ok(
  $legacy_third_auth_identity$
    update auth.users u
       set email = 'third-legacy-identity@test.local',
           updated_at = clock_timestamp()
      from legacy_repair_ctx x
     where u.id = x.user_id
  $legacy_third_auth_identity$,
  'stale_reactivation_auth_fence',
  'a legacy fence cannot overwrite a third real Auth identity'
);
update auth.users u
   set email = x.resolved_email,
       updated_at = clock_timestamp()
  from legacy_repair_ctx x
 where u.id = x.user_id;
select throws_ok(
  format(
    'select public.finish_account_reactivation_legacy_repair(%L::uuid,%L::uuid,%L::uuid,%s,true,null)',
    (select job_id from legacy_repair_ctx),
    (select user_id from legacy_repair_ctx),
    pg_catalog.gen_random_uuid(),
    (
      select (lease->>'lease_version')::integer
        from legacy_repair_ctx
    )
  ),
  'stale_lease',
  'a wrong token cannot finish a legacy Auth repair'
);
update legacy_repair_ctx x
   set finish_result =
     public.finish_account_reactivation_legacy_repair(
       x.job_id,
       x.user_id,
       (x.lease->>'lease_token')::uuid,
       (x.lease->>'lease_version')::integer,
       true,
       null
     );
select is(
  (select finish_result->>'status' from legacy_repair_ctx),
  'completed',
  'exact legacy marker-to-email repair reaches terminal completion'
);
select ok(
  (
    select p.deleted_at is null
       and p.withdrawal_generation = x.expected_generation
       and m.email = x.resolved_email
       and u.email = x.resolved_email
       and not coalesce(u.raw_app_meta_data, '{}'::jsonb)
                 ? 'bp_reactivation_fence'
       and j.status = 'completed'
      from legacy_repair_ctx x
      join public.profiles p on p.id = x.user_id
      join public.member_accounts m on m.user_id = x.user_id
      join auth.users u on u.id = x.user_id
      join public.account_reactivation_legacy_repairs j
        on j.id = x.job_id
  ),
  'legacy completion preserves the active lifecycle and scrubs only its fence'
);
select is(
  (
    select public.get_account_reactivation_legacy_repair_status(
      job_id,
      user_id
    )->>'status'
      from legacy_repair_ctx
  ),
  'completed',
  'legacy finish response loss is recoverable from immutable status'
);

create temporary table legacy_retry_supersede_ctx (
  user_id uuid primary key,
  resolved_email text not null,
  job_id uuid,
  lease jsonb,
  retry_result jsonb,
  second_lease jsonb,
  second_retry_result jsonb,
  supersede_result jsonb
) on commit drop;
insert into legacy_retry_supersede_ctx(user_id, resolved_email)
values (
  pg_catalog.gen_random_uuid(),
  'legacy-retry-supersede@test.local'
);
insert into auth.users(id, email, raw_app_meta_data)
select
  user_id,
  'deleted+' || user_id::text || '@deleted.invalid',
  '{"provider":"google","keep":"preserved"}'::jsonb
  from legacy_retry_supersede_ctx;
insert into public.member_accounts(
  user_id,
  gen_credits,
  email,
  is_admin
)
select user_id, 0, resolved_email, false
  from legacy_retry_supersede_ctx;
with inserted as (
  insert into public.account_reactivation_legacy_repairs(
    user_id,
    expected_withdrawal_generation,
    resolved_email
  )
  select user_id, 0, resolved_email
    from legacy_retry_supersede_ctx
  returning id
)
update legacy_retry_supersede_ctx
   set job_id = (select id from inserted);
update legacy_retry_supersede_ctx
   set lease = public.claim_account_reactivation_legacy_repair(120);
do $arm_failed_legacy_repair$
declare
  x legacy_retry_supersede_ctx%rowtype;
begin
  select * into x from legacy_retry_supersede_ctx;
  perform public.arm_account_reactivation_legacy_repair_auth_fence(
    x.job_id,
    x.user_id,
    (x.lease->>'lease_token')::uuid,
    (x.lease->>'lease_version')::integer
  );
end;
$arm_failed_legacy_repair$;
update legacy_retry_supersede_ctx x
   set retry_result =
     public.finish_account_reactivation_legacy_repair(
       x.job_id,
       x.user_id,
       (x.lease->>'lease_token')::uuid,
       (x.lease->>'lease_version')::integer,
       false,
       'simulated_auth_failure'
     );
-- Advance only this disposable fixture past its tested backoff. The guard is
-- disabled solely for clock setup; claim/supersede and fence scrub still run
-- through their production functions.
alter table public.account_reactivation_legacy_repairs
  disable trigger trg_account_reactivation_legacy_repairs_guard;
update public.account_reactivation_legacy_repairs j
   set next_attempt_at = clock_timestamp() - interval '1 second'
  from legacy_retry_supersede_ctx x
 where j.id = x.job_id;
alter table public.account_reactivation_legacy_repairs
  enable trigger trg_account_reactivation_legacy_repairs_guard;
update public.member_accounts m
   set email = 'changed-before-retry@test.local'
  from legacy_retry_supersede_ctx x
 where m.user_id = x.user_id;
update legacy_retry_supersede_ctx
   set second_lease =
     public.claim_account_reactivation_legacy_repair(120);
update legacy_retry_supersede_ctx x
   set second_retry_result =
     public.finish_account_reactivation_legacy_repair(
       x.job_id,
       x.user_id,
       (x.second_lease->>'lease_token')::uuid,
       (x.second_lease->>'lease_version')::integer,
       false,
       'member_email_changed'
     );
alter table public.account_reactivation_legacy_repairs
  disable trigger trg_account_reactivation_legacy_repairs_guard;
update public.account_reactivation_legacy_repairs j
   set next_attempt_at = clock_timestamp() - interval '1 second'
  from legacy_retry_supersede_ctx x
 where j.id = x.job_id;
alter table public.account_reactivation_legacy_repairs
  enable trigger trg_account_reactivation_legacy_repairs_guard;
update public.profiles p
   set deleted_at = '2026-07-20 01:04:30+00'::timestamptz
  from legacy_retry_supersede_ctx x
 where p.id = x.user_id;
update legacy_retry_supersede_ctx
   set supersede_result =
     public.claim_account_reactivation_legacy_repair(120);
select ok(
  (
    select retry_result->>'status' = 'pending'
       and second_lease->>'preflight_error' =
             'member_email_changed'
       and (
             second_lease->>'lease_version'
           )::integer > (lease->>'lease_version')::integer
       and second_retry_result->>'status' = 'pending'
       and supersede_result->>'status' = 'superseded'
       and j.status = 'superseded'
       and u.raw_app_meta_data->>'keep' = 'preserved'
       and not coalesce(u.raw_app_meta_data, '{}'::jsonb)
                 ? 'bp_reactivation_fence'
      from legacy_retry_supersede_ctx x
      join public.account_reactivation_legacy_repairs j
        on j.id = x.job_id
      join auth.users u on u.id = x.user_id
  ),
  'failed legacy retry followed by withdrawal terminally scrubs only its immutable exact fence'
);

create temporary table legacy_counter_ctx (
  user_id uuid primary key,
  resolved_email text not null,
  job_id uuid
) on commit drop;
insert into legacy_counter_ctx(user_id, resolved_email)
values (
  pg_catalog.gen_random_uuid(),
  'legacy-counter-boundary@test.local'
);
insert into auth.users(id, email, raw_app_meta_data)
select
  user_id,
  'deleted+' || user_id::text || '@deleted.invalid',
  '{"provider":"google"}'::jsonb
  from legacy_counter_ctx;
insert into public.member_accounts(
  user_id,
  gen_credits,
  email,
  is_admin
)
select user_id, 0, resolved_email, false
  from legacy_counter_ctx;
with inserted as (
  insert into public.account_reactivation_legacy_repairs(
    user_id,
    expected_withdrawal_generation,
    resolved_email,
    lease_version,
    attempt_count
  )
  select
    user_id,
    0,
    resolved_email,
    2147483647,
    2147483647
    from legacy_counter_ctx
  returning id
)
update legacy_counter_ctx
   set job_id = (select id from inserted);

create temporary table legacy_supersede_ctx (
  user_id uuid primary key,
  resolved_email text not null,
  claim_result jsonb
) on commit drop;
insert into legacy_supersede_ctx(user_id, resolved_email)
values (
  pg_catalog.gen_random_uuid(),
  'legacy-superseded@test.local'
);
insert into auth.users(id, email, raw_app_meta_data)
select
  user_id,
  'third-existing-legacy@test.local',
  '{"provider":"google"}'::jsonb
  from legacy_supersede_ctx;
insert into public.member_accounts(
  user_id,
  gen_credits,
  email,
  is_admin
)
select user_id, 0, null, false
  from legacy_supersede_ctx;
update public.profiles p
   set deleted_at = '2026-07-20 01:05:00+00'::timestamptz
  from legacy_supersede_ctx x
 where p.id = x.user_id;
update public.profiles p
   set deleted_at = null
  from legacy_supersede_ctx x
 where p.id = x.user_id;
update public.member_accounts m
   set email = x.resolved_email
  from legacy_supersede_ctx x
 where m.user_id = x.user_id;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair immediate;
set constraints
  trg_profiles_enqueue_legacy_account_reactivation_repair deferred;
update public.profiles p
   set deleted_at = '2026-07-20 01:05:01+00'::timestamptz
  from legacy_supersede_ctx x
 where p.id = x.user_id;
update legacy_supersede_ctx
   set claim_result =
     public.claim_account_reactivation_legacy_repair(120);
select ok(
  (
    select claim_result->>'status' = 'superseded'
       and (claim_result->>'user_id')::uuid = user_id
       and (
         select u.email = 'third-existing-legacy@test.local'
           from auth.users u
           where u.id = user_id
       )
       and (
         select j.status = 'pending'
            and j.last_error = 'lease_counter_exhausted'
            and j.next_attempt_at =
                  '9999-12-31 23:59:59+00'::timestamptz
           from legacy_counter_ctx b
           join public.account_reactivation_legacy_repairs j
             on j.id = b.job_id
       )
      from legacy_supersede_ctx
  ),
  'legacy max counters quarantine without head-blocking a captured third-real supersede'
);

-- ── Settlement: recovery before PortOne and financial exactly-once ────────

select is(
  (
    select public.get_admin_settlement_receipt(
      admin_id,
      order_id,
      'settle fixture order',
      settlement_request
    )->>'found'
      from admin_mutation_ctx
  ),
  'false',
  'settlement recovery peek does not tombstone a new request'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.admin_mutation_requests r
      join admin_mutation_ctx c
        on c.settlement_request = r.request_id
  ),
  0,
  'new settlement receipt lookup performs no write'
);

update admin_mutation_ctx c
   set first_result = public.admin_settle_stuck_order_verified(
     c.admin_id,
     c.order_id,
     'settle fixture order',
     c.settlement_request,
     '2026-07-20 01:00:00+00'::timestamptz,
     'fixture-settlement-transaction',
     'https://example.test/fixture-receipt',
     pg_catalog.jsonb_build_object(
       'id', pg_catalog.replace(c.order_id::text, '-', ''),
       'status', 'PAID',
       'transactionId', 'fixture-settlement-transaction',
       'paidAt', '2026-07-20 01:00:00+00',
       'receiptUrl', 'https://example.test/fixture-receipt',
       'amount', pg_catalog.jsonb_build_object('total', 1000),
       'storeId', 'store-qa',
       'currency', 'KRW',
       'channel', pg_catalog.jsonb_build_object(
         'type', 'TEST',
         'key', 'channel-card-test'
       )
     )
   );

select is(
  (select (first_result->>'after')::integer from admin_mutation_ctx),
  3,
  'first verified settlement grants the configured credits'
);
select is(
  (
    select public.admin_settle_stuck_order_verified(
      admin_id,
      order_id,
      'settle fixture order',
      settlement_request,
      '2026-07-20 01:00:00+00'::timestamptz,
      'fixture-settlement-transaction',
      'https://example.test/fixture-receipt',
      pg_catalog.jsonb_build_object(
        'id', pg_catalog.replace(order_id::text, '-', ''),
        'status', 'PAID',
        'transactionId', 'fixture-settlement-transaction',
        'paidAt', '2026-07-20 01:00:00+00',
        'receiptUrl', 'https://example.test/fixture-receipt',
        'amount', pg_catalog.jsonb_build_object('total', 1000),
        'storeId', 'store-qa',
        'currency', 'KRW',
        'channel', pg_catalog.jsonb_build_object(
          'type', 'TEST',
          'key', 'channel-card-test'
        )
      )
    )->>'idempotent'
      from admin_mutation_ctx
  ),
  'true',
  'same settlement request replays without another financial mutation'
);
select is(
  (
    select public.get_admin_settlement_receipt(
      admin_id,
      order_id,
      'settle fixture order',
      settlement_request
    )#>>'{result,after}'
      from admin_mutation_ctx
  ),
  '3',
  'settlement result is recoverable before another PortOne call'
);
select is(
  (
    select public.admin_settle_stuck_order_verified(
      admin_id,
      order_id,
      'settle fixture order',
      settlement_noop_request,
      '2026-07-20 01:00:00+00'::timestamptz,
      'fixture-settlement-transaction',
      'https://example.test/fixture-receipt',
      pg_catalog.jsonb_build_object(
        'id', pg_catalog.replace(order_id::text, '-', ''),
        'status', 'PAID',
        'transactionId', 'fixture-settlement-transaction',
        'paidAt', '2026-07-20 01:00:00+00',
        'receiptUrl', 'https://example.test/fixture-receipt',
        'amount', pg_catalog.jsonb_build_object('total', 1000),
        'storeId', 'store-qa',
        'currency', 'KRW',
        'channel', pg_catalog.jsonb_build_object(
          'type', 'TEST',
          'key', 'channel-card-test'
        )
      )
    )->>'noOp'
      from admin_mutation_ctx
  ),
  'true',
  'a distinct stale tab converges on the unique settlement ledger'
);
select is(
  (
    select m.gen_credits
      from public.member_accounts m
      join admin_mutation_ctx c on c.owner_id = m.user_id
  ),
  3,
  'settlement replay and convergence never double-grant credits'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.credit_lots l
      join admin_mutation_ctx c on c.order_id = l.order_uuid
  ),
  1,
  'settlement creates one purchase lot'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.admin_actions_ledger l
      join admin_mutation_ctx c on c.order_id = l.order_uuid
     where l.action_type = 'settle_stuck'
  ),
  1,
  'settlement creates one financial admin audit row'
);
select is(
  (
    select o.status
      from public.orders o
      join admin_mutation_ctx c on c.order_id = o.order_uuid
  ),
  'paid',
  'settled order reaches paid state exactly once'
);

-- ── Moderation read cardinality: exact count + deterministic latest preview ─

create temporary table moderation_cap_ctx (
  doll_id uuid not null default gen_random_uuid(),
  result jsonb
) on commit drop;
insert into moderation_cap_ctx default values;

insert into public.dolls(id, owner_id, image_url)
select
  q.doll_id,
  c.owner_id,
  c.owner_id::text || '/' || q.doll_id::text || '.png'
  from moderation_cap_ctx q
  cross join admin_mutation_ctx c;

insert into public.content_reports(
  id,
  target_type,
  target_id,
  reason,
  detail,
  created_at
)
select
  pg_catalog.lpad(pg_catalog.to_hex(g.n), 32, '0')::uuid,
  'doll',
  q.doll_id,
  'portrait',
  'bounded moderation preview fixture ' || g.n::text,
  '2099-01-01 00:00:00+00'::timestamptz
    + pg_catalog.make_interval(secs => ((g.n - 1) / 2))
  from moderation_cap_ctx q
  cross join pg_catalog.generate_series(1, 101) as g(n);

update moderation_cap_ctx q
   set result = public.admin_moderation_queue(
     c.admin_id,
     null,
     q.doll_id,
     null,
     1000000,
     0
   )
  from admin_mutation_ctx c;

select is(
  (select (result#>>'{rows,0,report_count}')::integer
     from moderation_cap_ctx),
  101,
  'moderation queue keeps the exact report count above its preview cap'
);
select is(
  (select pg_catalog.jsonb_array_length(result#>'{rows,0,reports}')
     from moderation_cap_ctx),
  100,
  'moderation queue returns at most one hundred report details'
);
select is(
  (select (result#>>'{rows,0,reports_truncated}')::boolean
     from moderation_cap_ctx),
  true,
  'moderation queue marks a truncated report preview explicitly'
);
select ok(
  (
    select
      (result#>>'{rows,0,reports,0,id}')::uuid =
        pg_catalog.lpad(pg_catalog.to_hex(101), 32, '0')::uuid
      and
      (result#>>'{rows,0,reports,99,id}')::uuid =
        pg_catalog.lpad(pg_catalog.to_hex(2), 32, '0')::uuid
      from moderation_cap_ctx
  ),
  'moderation preview is exact created_at desc then id desc order'
);

select * from finish();
rollback;
