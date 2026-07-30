-- 0083 reviewer Auth <-> database durable saga contract.

begin;
select plan(66);

select has_column(
  'public',
  'reviewer_accounts',
  'auth_sync_pending',
  'reviewer classification has a durable Auth uncertainty bit'
);
select has_table(
  'public',
  'reviewer_account_jobs',
  'reviewer durable job table exists'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.reviewer_account_jobs'::regclass
  ),
  true,
  'reviewer job table has RLS enabled'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.reviewer_account_jobs',
    'SELECT'
  ),
  'service role cannot inspect raw job payloads'
);
select ok(
  not exists (
    select 1
      from pg_catalog.pg_attribute
     where attrelid = 'public.reviewer_account_jobs'::regclass
       and attnum > 0
       and not attisdropped
       and attname in ('password', 'credential', 'secret')
  ),
  'durable jobs have no password or credential-secret column'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.reviewer_accounts',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.reviewer_accounts',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.reviewer_accounts',
    'DELETE'
  ),
  'reviewer ledger mutations are RPC-only'
);
select has_function(
  'public',
  'start_reviewer_provision',
  array['uuid','uuid','text','text'],
  'provision start RPC exists'
);
select has_function(
  'public',
  'start_reviewer_auth_sync',
  array['uuid','uuid','uuid','text','boolean'],
  'Auth sync start RPC exists'
);
select has_function(
  'public',
  'claim_reviewer_account_job',
  array['uuid','integer'],
  'fenced reviewer claim RPC exists'
);
select has_function(
  'public',
  'record_reviewer_provision_auth',
  array['uuid','uuid','integer','uuid'],
  'provision Auth identity checkpoint exists'
);
select has_function(
  'public',
  'finalize_reviewer_provision',
  array['uuid','uuid','integer'],
  'atomic DB provision finalize exists'
);
select has_function(
  'public',
  'finish_reviewer_account_job',
  array['uuid','uuid','integer','boolean','boolean','text'],
  'sync finish/retry RPC exists'
);
select has_function(
  'public',
  'admin_set_reviewer_note',
  array['uuid','uuid','text'],
  'reviewer note mutation RPC exists'
);
select has_function(
  'public',
  'admin_list_reviewer_jobs',
  array['uuid','integer'],
  'safe reviewer job list RPC exists'
);
select ok(
  (
    select bool_and(p.prosecdef)
      from pg_catalog.pg_proc p
     where p.oid = any(array[
       'public.start_reviewer_provision(uuid,uuid,text,text)'::regprocedure,
       'public.start_reviewer_auth_sync(uuid,uuid,uuid,text,boolean)'::regprocedure,
       'public.claim_reviewer_account_job(uuid,integer)'::regprocedure,
       'public.record_reviewer_provision_auth(uuid,uuid,integer,uuid)'::regprocedure,
       'public.finalize_reviewer_provision(uuid,uuid,integer)'::regprocedure,
       'public.finish_reviewer_account_job(uuid,uuid,integer,boolean,boolean,text)'::regprocedure
     ])
  ),
  'all saga mutation RPCs are SECURITY DEFINER'
);
select ok(
  (
    select bool_and(
      coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
    )
      from pg_catalog.pg_proc p
     where p.oid = any(array[
       'public.start_reviewer_provision(uuid,uuid,text,text)'::regprocedure,
       'public.start_reviewer_auth_sync(uuid,uuid,uuid,text,boolean)'::regprocedure,
       'public.claim_reviewer_account_job(uuid,integer)'::regprocedure,
       'public.record_reviewer_provision_auth(uuid,uuid,integer,uuid)'::regprocedure,
       'public.finalize_reviewer_provision(uuid,uuid,integer)'::regprocedure,
       'public.finish_reviewer_account_job(uuid,uuid,integer,boolean,boolean,text)'::regprocedure
     ])
  ),
  'all saga mutation RPCs pin an empty search_path'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.start_reviewer_provision(uuid,uuid,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finish_reviewer_account_job(uuid,uuid,integer,boolean,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.start_reviewer_provision(uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.finish_reviewer_account_job(uuid,uuid,integer,boolean,boolean,text)',
    'EXECUTE'
  ),
  'only service role can drive external saga RPCs'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_reviewer_job_replay(uuid,uuid,text,jsonb)',
    'EXECUTE'
  ),
  'operation replay helper is internal'
);
select ok(
  (
    with src as (
      select
        pg_catalog.lower(pg_catalog.pg_get_functiondef(
          'public.finalize_reviewer_provision(uuid,uuid,integer)'::regprocedure
        )) as wrapper_body,
        pg_catalog.lower(pg_catalog.pg_get_functiondef(
          'public.bp_0084_legal_consent_locks(boolean,boolean)'::regprocedure
        )) as helper_body
    )
    select pg_catalog.strpos(
             wrapper_body,
             'bp_0084_legal_consent_locks(true, true)'
           ) > 0
       and pg_catalog.strpos(helper_body, 'legal:terms') > 0
       and pg_catalog.strpos(helper_body, 'legal:privacy')
             > pg_catalog.strpos(helper_body, 'legal:terms')
      from src
  ),
  'provision snapshots legal versions under terms then privacy locks'
);
select matches(
  pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.claim_reviewer_account_job(uuid,integer)'::regprocedure
  )),
  'for update skip locked',
  'job claim is safe for concurrent workers'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_indexes
     where schemaname = 'public'
       and indexname in (
         'uq_reviewer_job_active_user',
         'uq_reviewer_job_active_email'
       )
  ),
  2,
  'active jobs are unique by user and normalized email'
);

create temporary table reviewer_ctx (
  admin_id uuid not null,
  reviewer_id uuid not null,
  conflict_user_id uuid not null,
  email text not null,
  conflict_email text not null,
  provision_op uuid not null,
  conflict_op uuid not null,
  start_result jsonb,
  replay_result jsonb,
  lease_one jsonb,
  conflict_start jsonb,
  conflict_lease jsonb,
  inactive_op uuid,
  inactive_start jsonb,
  inactive_lease_one jsonb,
  inactive_lease_two jsonb,
  active_op uuid,
  active_start jsonb,
  active_lease jsonb,
  reset_op uuid,
  reset_start jsonb,
  reset_lease jsonb,
  delete_op uuid,
  delete_start jsonb,
  delete_lease jsonb
) on commit drop;

do $fixture$
declare
  v_admin uuid := gen_random_uuid();
  v_reviewer uuid := gen_random_uuid();
  v_conflict uuid := gen_random_uuid();
begin
  insert into auth.users(id, email)
  values (v_admin, 'reviewer-saga-admin-' || v_admin || '@test.local');
  insert into public.member_accounts(user_id, gen_credits, is_admin)
  values (v_admin, 0, true)
  on conflict (user_id) do update set is_admin = true;
  insert into reviewer_ctx(
    admin_id,
    reviewer_id,
    conflict_user_id,
    email,
    conflict_email,
    provision_op,
    conflict_op
  )
  values (
    v_admin,
    v_reviewer,
    v_conflict,
    'reviewer-saga-' || v_reviewer || '@test.local',
    'reviewer-conflict-' || v_conflict || '@test.local',
    gen_random_uuid(),
    gen_random_uuid()
  );
end;
$fixture$;

update reviewer_ctx c
   set start_result = public.start_reviewer_provision(
     c.admin_id,
     c.provision_op,
     upper(c.email),
     ' durable fixture '
   );
select is(
  start_result->>'status',
  'pending',
  'provision intent is durable before any Auth call'
) from reviewer_ctx;
select is(
  (
    select j.email || '|' || coalesce(j.note, '')
      from public.reviewer_account_jobs j
      join reviewer_ctx c on j.id = (c.start_result->>'job_id')::uuid
  ),
  (
    select email || '|durable fixture'
      from reviewer_ctx
  ),
  'provision start normalizes and persists only non-secret request data'
);

update reviewer_ctx c
   set replay_result = public.start_reviewer_provision(
     c.admin_id,
     c.provision_op,
     upper(c.email),
     ' durable fixture '
   );
select is(
  replay_result->>'job_id',
  start_result->>'job_id',
  'same provision operation replays the same durable job'
) from reviewer_ctx;
select is(
  (
    select count(*)::int
      from public.reviewer_account_jobs j
      join reviewer_ctx c on j.operation_id = c.provision_op
  ),
  1,
  'provision replay never duplicates a job'
);
select throws_ok(
  format(
    'select public.start_reviewer_provision(%L::uuid,%L::uuid,%L,%L)',
    admin_id,
    provision_op,
    email,
    'different note'
  ),
  'P0001',
  'request_conflict',
  'operation UUID cannot be reused for another provision payload'
) from reviewer_ctx;

update reviewer_ctx c
   set lease_one = public.claim_reviewer_account_job(
     (c.start_result->>'job_id')::uuid,
     120
   );
select is(
  lease_one->>'attempt_count',
  '1',
  'first provision claim receives attempt one'
) from reviewer_ctx;
select is(
  (
    select public.claim_reviewer_account_job(
      (start_result->>'job_id')::uuid,
      120
    )
      from reviewer_ctx
  ),
  null,
  'a live lease cannot be double-claimed'
);

insert into auth.users(id, email, raw_app_meta_data)
select
  reviewer_id,
  email,
  pg_catalog.jsonb_build_object(
    'reviewer',
    true,
    'reviewer_job_id',
    start_result->>'job_id'
  )
  from reviewer_ctx;
select is(
  (
    select public.record_reviewer_provision_auth(
      (start_result->>'job_id')::uuid,
      (lease_one->>'lease_token')::uuid,
      (lease_one->>'lease_version')::integer,
      reviewer_id
    )->>'user_id'
      from reviewer_ctx
  ),
  (select reviewer_id::text from reviewer_ctx),
  'Auth identity is durably checkpointed under the fenced lease'
);
select is(
  (
    select public.finalize_reviewer_provision(
      (start_result->>'job_id')::uuid,
      (lease_one->>'lease_token')::uuid,
      (lease_one->>'lease_version')::integer
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'provision DB state finalizes atomically'
);
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'true|false',
  'completed provision is active and not uncertain'
);
select is(
  (
    select m.gen_credits::text || '|' || (m.age_confirmed_at is not null)::text
      from public.member_accounts m
      join reviewer_ctx c on c.reviewer_id = m.user_id
  ),
  '0|true',
  'reviewer provision stamps membership with no signup credit'
);
select is(
  (
    select j.status
      from public.reviewer_account_jobs j
      join reviewer_ctx c on j.id = (c.start_result->>'job_id')::uuid
  ),
  'completed',
  'provision job completion commits with reviewer row'
);
select is(
  (
    select public.start_reviewer_provision(
      admin_id,
      provision_op,
      upper(email),
      ' durable fixture '
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'response-loss retry observes completed provision'
);

-- A non-reviewer Auth identity cannot be adopted by an orphan recovery.
update reviewer_ctx c
   set conflict_start = public.start_reviewer_provision(
     c.admin_id,
     c.conflict_op,
     c.conflict_email,
     null
   );
update reviewer_ctx c
   set conflict_lease = public.claim_reviewer_account_job(
     (c.conflict_start->>'job_id')::uuid,
     120
   );
insert into auth.users(
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  conflict_user_id,
  conflict_email,
  '{}'::jsonb,
  pg_catalog.jsonb_build_object(
    'reviewer',
    true,
    'reviewer_job_id',
    conflict_start->>'job_id'
  )
  from reviewer_ctx;
select throws_ok(
  format(
    'select public.record_reviewer_provision_auth(%L::uuid,%L::uuid,%L::integer,%L::uuid)',
    (conflict_start->>'job_id')::uuid,
    (conflict_lease->>'lease_token')::uuid,
    (conflict_lease->>'lease_version')::integer,
    conflict_user_id
  ),
  'P0001',
  'auth_identity_invalid',
  'user-editable metadata cannot authorize reviewer orphan adoption'
) from reviewer_ctx;
select is(
  (
    select public.finish_reviewer_account_job(
      (conflict_start->>'job_id')::uuid,
      (conflict_lease->>'lease_token')::uuid,
      (conflict_lease->>'lease_version')::integer,
      false,
      true,
      'auth_email_conflict'
    )->>'status'
      from reviewer_ctx
  ),
  'failed',
  'permanent Auth email conflict becomes visible terminal work'
);

-- set_active starts with the DB uncertainty bit, then retries under a new fence.
update reviewer_ctx
   set inactive_op = gen_random_uuid();
update reviewer_ctx c
   set inactive_start = public.start_reviewer_auth_sync(
     c.admin_id,
     c.inactive_op,
     c.reviewer_id,
     'set_active',
     false
   );
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'false|true',
  'deactivation is payment-fail-closed before GoTrue ban'
);
update reviewer_ctx c
   set inactive_lease_one = public.claim_reviewer_account_job(
     (c.inactive_start->>'job_id')::uuid,
     120
   );
select is(
  (
    select public.finish_reviewer_account_job(
      (inactive_start->>'job_id')::uuid,
      (inactive_lease_one->>'lease_token')::uuid,
      (inactive_lease_one->>'lease_version')::integer,
      false,
      false,
      'auth_temporarily_unavailable'
    )->>'status'
      from reviewer_ctx
  ),
  'pending',
  'transient Auth failure returns the durable job to pending'
);
select is(
  (
    select r.auth_sync_pending
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  true,
  'transient failure cannot clear payment uncertainty'
);
update public.reviewer_account_jobs j
   set next_attempt_at = clock_timestamp() - interval '1 second'
  from reviewer_ctx c
 where j.id = (c.inactive_start->>'job_id')::uuid;
update reviewer_ctx c
   set inactive_lease_two = public.claim_reviewer_account_job(
     (c.inactive_start->>'job_id')::uuid,
     120
   );
select is(
  inactive_lease_two->>'lease_version',
  '2',
  'retry receives a new fencing version'
) from reviewer_ctx;
select throws_ok(
  format(
    $sql$
      select public.finish_reviewer_account_job(
        %L::uuid,%L::uuid,%L::integer,true,false,null
      )
    $sql$,
    (inactive_start->>'job_id')::uuid,
    (inactive_lease_one->>'lease_token')::uuid,
    (inactive_lease_one->>'lease_version')::integer
  ),
  'P0001',
  'stale_lease',
  'stale worker cannot finish a re-leased job'
) from reviewer_ctx;
select is(
  (
    select public.finish_reviewer_account_job(
      (inactive_start->>'job_id')::uuid,
      (inactive_lease_two->>'lease_token')::uuid,
      (inactive_lease_two->>'lease_version')::integer,
      true,
      false,
      null
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'current worker completes deactivation'
);
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'false|false',
  'successful ban completion clears uncertainty while retaining inactive SoT'
);

update reviewer_ctx
   set active_op = gen_random_uuid();
update reviewer_ctx c
   set active_start = public.start_reviewer_auth_sync(
     c.admin_id,
     c.active_op,
     c.reviewer_id,
     'set_active',
     true
   );
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'true|true',
  'reactivation remains unavailable until Auth unban is confirmed'
);
update reviewer_ctx c
   set active_lease = public.claim_reviewer_account_job(
     (c.active_start->>'job_id')::uuid,
     120
   );
select is(
  (
    select public.finish_reviewer_account_job(
      (active_start->>'job_id')::uuid,
      (active_lease->>'lease_token')::uuid,
      (active_lease->>'lease_version')::integer,
      true,
      false,
      null
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'confirmed unban completes reactivation'
);
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'true|false',
  'completed reactivation is classified as reviewer again'
);

update reviewer_ctx
   set reset_op = gen_random_uuid();
update reviewer_ctx c
   set reset_start = public.start_reviewer_auth_sync(
     c.admin_id,
     c.reset_op,
     c.reviewer_id,
     'reset_password',
     null
   );
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'true|true',
  'password-reset intent is durable and payment-fail-closed before GoTrue'
);
select is(
  (
    select j.action || '|' || coalesce(j.desired_active::text, 'null')
      from public.reviewer_account_jobs j
      join reviewer_ctx c
        on j.id = (c.reset_start->>'job_id')::uuid
  ),
  'reset_password|null',
  'password-reset job stores no password and no unrelated target state'
);
update reviewer_ctx c
   set reset_lease = public.claim_reviewer_account_job(
     (c.reset_start->>'job_id')::uuid,
     120
   );
select is(
  (
    select public.finish_reviewer_account_job(
      (reset_start->>'job_id')::uuid,
      (reset_lease->>'lease_token')::uuid,
      (reset_lease->>'lease_version')::integer,
      true,
      false,
      null
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'confirmed password reset completes its durable receipt'
);
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'true|false',
  'password-reset completion preserves active state and clears uncertainty'
);
select is(
  (
    select public.start_reviewer_auth_sync(
      admin_id,
      reset_op,
      reviewer_id,
      'reset_password',
      null
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'password-reset response-loss retry replays the completed receipt'
);
select is(
  (
    select public.admin_set_reviewer_note(
      admin_id,
      reviewer_id,
      ' revised note '
    )->>'ok'
      from reviewer_ctx
  ),
  'true',
  'note update remains available through an admin-checked RPC'
);
select is(
  (
    select note
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'revised note',
  'note RPC normalizes the stored note'
);

update reviewer_ctx
   set delete_op = gen_random_uuid();
update reviewer_ctx c
   set delete_start = public.start_reviewer_auth_sync(
     c.admin_id,
     c.delete_op,
     c.reviewer_id,
     'delete',
     null
   );
select is(
  (
    select r.active::text || '|' || r.auth_sync_pending::text
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  'false|true',
  'delete intent blocks payment before Auth ban'
);
update reviewer_ctx c
   set delete_lease = public.claim_reviewer_account_job(
     (c.delete_start->>'job_id')::uuid,
     120
   );
select is(
  (
    select public.finish_reviewer_account_job(
      (delete_start->>'job_id')::uuid,
      (delete_lease->>'lease_token')::uuid,
      (delete_lease->>'lease_version')::integer,
      true,
      false,
      null
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'confirmed Auth ban completes reviewer deletion'
);
select is(
  (
    select count(*)::int
      from public.reviewer_accounts r
      join reviewer_ctx c on c.reviewer_id = r.user_id
  ),
  0,
  'reviewer row is removed only after successful Auth ban'
);
select is(
  (
    select public.start_reviewer_auth_sync(
      admin_id,
      delete_op,
      reviewer_id,
      'delete',
      null
    )->>'status'
      from reviewer_ctx
  ),
  'completed',
  'delete response-loss retry replays after the ledger row is gone'
);
select is(
  (
    select count(*)::int
      from reviewer_ctx c
      cross join lateral public.admin_list_reviewer_jobs(
        c.admin_id,
        50
      ) j
     where j.status = 'failed'
  ),
  1,
  'admin-safe job list exposes the terminal conflict for repair'
);

select throws_ok(
  format(
    'select public.start_reviewer_provision(%L::uuid,%L::uuid,%L,null)',
    gen_random_uuid(),
    gen_random_uuid(),
    'not-admin@example.test'
  ),
  'P0001',
  'not_admin',
  'provision start revalidates active admin inside the database'
);
select throws_ok(
  format(
    'select public.admin_set_reviewer_note(%L::uuid,%L::uuid,%L)',
    admin_id,
    reviewer_id,
    repeat('x', 2001)
  ),
  'P0001',
  'invalid_note',
  'database rejects oversized reviewer notes'
) from reviewer_ctx;
select throws_ok(
  format(
    'select public.start_reviewer_provision(%L::uuid,null,%L,null)',
    admin_id,
    'missing-op@example.test'
  ),
  'P0001',
  'operation_id_required',
  'provision requires an operation UUID'
) from reviewer_ctx;
select throws_ok(
  format(
    'select public.start_reviewer_auth_sync(%L::uuid,%L::uuid,%L::uuid,null,null)',
    admin_id,
    gen_random_uuid(),
    reviewer_id
  ),
  'P0001',
  'invalid_action',
  'null Auth sync action fails closed'
) from reviewer_ctx;
select throws_ok(
  format(
    'select public.start_reviewer_auth_sync(%L::uuid,%L::uuid,%L::uuid,%L,null)',
    admin_id,
    gen_random_uuid(),
    reviewer_id,
    'set_active'
  ),
  'P0001',
  'invalid_action',
  'set_active requires an explicit target state'
) from reviewer_ctx;
select throws_ok(
  format(
    'select public.start_reviewer_auth_sync(%L::uuid,%L::uuid,%L::uuid,%L,true)',
    admin_id,
    gen_random_uuid(),
    reviewer_id,
    'delete'
  ),
  'P0001',
  'invalid_action',
  'delete rejects a target-active payload'
) from reviewer_ctx;
select throws_ok(
  format(
    'select public.start_reviewer_auth_sync(%L::uuid,%L::uuid,%L::uuid,%L,true)',
    admin_id,
    gen_random_uuid(),
    reviewer_id,
    'reset_password'
  ),
  'P0001',
  'invalid_action',
  'password reset rejects an unrelated target-active payload'
) from reviewer_ctx;
select throws_ok(
  format(
    'select * from public.admin_list_reviewer_jobs(%L::uuid,50)',
    gen_random_uuid()
  ),
  'P0001',
  'not_admin',
  'safe job list revalidates active admin'
);

select * from finish();
rollback;
