-- Durable anonymous Auth cleanup after OAuth data reassignment.
--
-- The database commits the reassignment receipt and arms the cleanup lease in
-- one transaction. Auth deletion remains an external side effect, so this
-- rollback-only suite proves generation fencing, response-loss confirmation,
-- retry leases, UUID-reuse protection, and terminal retention.

begin;
select plan(71);

create temporary table oauth_cleanup_results (
  name text primary key,
  value jsonb
) on commit drop;

create or replace function pg_temp.prepare_oauth_cleanup_flow(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_target_is_member boolean default false
)
returns void
language plpgsql
as $$
declare
  v_value jsonb;
begin
  delete from public.oauth_flow_intents
   where flow_id = p_flow_id;
  delete from auth.users
   where id in (p_source_user_id, p_target_user_id);

  insert into auth.users(
    id,
    email,
    is_anonymous,
    created_at,
    updated_at
  )
  values
    (
      p_source_user_id,
      'oauth-cleanup-source-' || p_source_user_id::text ||
        '@test.local',
      true,
      pg_catalog.clock_timestamp() - interval '50 days',
      pg_catalog.clock_timestamp() - interval '50 days'
    ),
    (
      p_target_user_id,
      'oauth-cleanup-target-' || p_target_user_id::text ||
        '@test.local',
      false,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    );
  insert into auth.sessions(id, user_id, created_at, updated_at)
  values (
    p_target_session_id,
    p_target_user_id,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

  v_value := public.begin_oauth_flow_intent(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    true,
    'google',
    '/consent',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fixture begin failed: %', v_value;
  end if;

  v_value := public.claim_oauth_flow_intent(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    'google',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fixture claim failed: %', v_value;
  end if;

  v_value := public.bind_oauth_flow_intent_target(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    'google',
    p_target_user_id,
    p_target_session_id,
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fixture bind failed: %', v_value;
  end if;

  if p_target_is_member then
    insert into public.member_accounts(user_id)
    values (p_target_user_id);
  end if;

  v_value := public.finalize_oauth_flow_intent(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    'google',
    '/consent',
    'completed',
    p_target_user_id,
    p_target_session_id,
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/consent',
    'continue'
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fixture finalize failed: %', v_value;
  end if;

  v_value := public.release_oauth_flow_intent(
    p_flow_id,
    p_target_user_id,
    p_target_session_id,
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fixture release failed: %', v_value;
  end if;
end;
$$;

-- Build a completed historical flow without asking begin() to create an
-- anonymous cleanup receipt. The test can then install a deliberately stale
-- source-generation snapshot while every production Auth fence remains
-- enabled. This models pre-fence or out-of-band state without weakening the
-- database under test.
create or replace function pg_temp.prepare_oauth_cleanup_fault_flow(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_source_auth_is_anonymous boolean,
  p_cleanup_generation_matches boolean
)
returns void
language plpgsql
as $$
declare
  v_value jsonb;
begin
  delete from public.oauth_flow_intents
   where flow_id = p_flow_id;
  delete from auth.users
   where id in (p_source_user_id, p_target_user_id);

  insert into auth.users(
    id,
    email,
    is_anonymous,
    created_at,
    updated_at
  )
  values
    (
      p_source_user_id,
      'oauth-cleanup-fault-source-' || p_source_user_id::text ||
        '@test.local',
      p_source_auth_is_anonymous,
      pg_catalog.clock_timestamp() - interval '50 days',
      pg_catalog.clock_timestamp() - interval '50 days'
    ),
    (
      p_target_user_id,
      'oauth-cleanup-fault-target-' || p_target_user_id::text ||
        '@test.local',
      false,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    );
  insert into auth.sessions(id, user_id, created_at, updated_at)
  values (
    p_target_session_id,
    p_target_user_id,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

  v_value := public.begin_oauth_flow_intent(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    false,
    'google',
    '/consent',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fault fixture begin failed: %', v_value;
  end if;
  v_value := public.claim_oauth_flow_intent(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    'google',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fault fixture claim failed: %', v_value;
  end if;
  v_value := public.bind_oauth_flow_intent_target(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    'google',
    p_target_user_id,
    p_target_session_id,
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fault fixture bind failed: %', v_value;
  end if;
  v_value := public.finalize_oauth_flow_intent(
    p_flow_id,
    p_source_user_id,
    p_source_session_id,
    'google',
    '/consent',
    'completed',
    p_target_user_id,
    p_target_session_id,
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/consent',
    'continue'
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fault fixture finalize failed: %', v_value;
  end if;
  v_value := public.release_oauth_flow_intent(
    p_flow_id,
    p_target_user_id,
    p_target_session_id,
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  );
  if v_value->>'ok' <> 'true' then
    raise exception 'cleanup fault fixture release failed: %', v_value;
  end if;

  update public.oauth_flow_intents
     set source_is_anonymous = true
   where flow_id = p_flow_id;

  insert into public.oauth_anon_auth_cleanup_jobs(
    cleanup_id,
    flow_id,
    source_user_id,
    source_auth_created_at,
    source_auth_instance_id,
    status,
    created_at,
    recover_until
  )
  select
    flow.flow_id,
    flow.flow_id,
    flow.source_user_id,
    source_user.created_at + case
      when p_cleanup_generation_matches then interval '0'
      else interval '1 microsecond'
    end,
    source_user.instance_id,
    'dormant',
    flow.created_at,
    greatest(flow.released_at, flow.created_at) +
      interval '30 days 5 seconds'
  from public.oauth_flow_intents as flow
  join auth.users as source_user
    on source_user.id = flow.source_user_id
  where flow.flow_id = p_flow_id;
end;
$$;

select has_table(
  'public',
  'oauth_anon_auth_cleanup_jobs',
  'anonymous Auth cleanup has a durable flow-scoped job table'
);

select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid =
       'public.oauth_anon_auth_cleanup_jobs'::regclass
  ),
  true,
  'cleanup jobs have RLS enabled'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_policy
     where polrelid =
       'public.oauth_anon_auth_cleanup_jobs'::regclass
  ),
  0,
  'cleanup jobs have no direct client policy'
);

select is(
  (
    select pg_catalog.array_agg(
             attname::text
             order by attnum
           )
      from pg_catalog.pg_attribute
     where attrelid =
       'public.oauth_anon_auth_cleanup_jobs'::regclass
       and attnum > 0
       and not attisdropped
  ),
  array[
    'cleanup_id',
    'flow_id',
    'legacy_source_user_id',
    'source_user_id',
    'source_auth_created_at',
    'source_auth_instance_id',
    'status',
    'quarantine_reason',
    'quarantined_at',
    'recover_until',
    'scrubbed_at',
    'access_revoked_at',
    'consumed_target_session_id',
    'consumed_target_session_created_at',
    'consumed_access_token_sha256',
    'consumed_refresh_token_sha256',
    'lease_token',
    'lease_version',
    'attempt_count',
    'next_attempt_at',
    'lease_expires_at',
    'last_error',
    'created_at',
    'armed_at',
    'finished_at'
  ]::text[],
  'cleanup job stores only source generation, lease, retry, and receipt state'
);

select ok(
  (
    select pg_catalog.bool_and(
      not pg_catalog.has_table_privilege(
        role_name,
        'public.oauth_anon_auth_cleanup_jobs',
        privilege_name
      )
    )
      from pg_catalog.unnest(array[
        'anon',
        'authenticated',
        'service_role'
      ]) role_name
      cross join pg_catalog.unnest(array[
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER'
      ]) privilege_name
  ),
  'no API role can read or mutate cleanup receipts directly'
);

select has_trigger(
  'auth',
  'users',
  'trg_auth_users_fence_oauth_anon_cleanup_insert',
  'Auth user insertion participates in the pending cleanup fence'
);

select has_trigger(
  'auth',
  'users',
  'trg_auth_users_fence_oauth_anon_cleanup_update',
  'Auth user generation or anonymous-state changes share the cleanup fence'
);

select ok(
  (
    select p.prosecdef
       and coalesce(p.proconfig, '{}'::text[])
         @> array['search_path=""']
       and not exists (
         select 1
           from pg_catalog.unnest(array[
             'anon',
             'authenticated',
             'service_role'
           ]) role_name
          where pg_catalog.has_function_privilege(
            role_name,
            p.oid,
            'EXECUTE'
          )
       )
       and not exists (
         select 1
           from pg_catalog.aclexplode(
             coalesce(
               p.proacl,
               pg_catalog.acldefault(
                 'f'::"char",
                 p.proowner
               )
             )
           ) acl
          where acl.grantee = 0
            and acl.privilege_type = 'EXECUTE'
       )
      from pg_catalog.pg_proc p
     where p.oid =
       'public.fence_oauth_anon_auth_cleanup_user()'::regprocedure
  ),
  'Auth generation trigger is an empty-search-path definer without an API surface'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.unnest(array[
        'public.claim_oauth_anon_auth_cleanup(uuid,integer)'::regprocedure,
        'public.verify_oauth_anon_auth_cleanup_source(uuid,uuid,integer)'::regprocedure,
        'public.finish_oauth_anon_auth_cleanup(uuid,uuid,integer,text,text)'::regprocedure
      ]) function_oid
  ),
  3,
  'all three exact cleanup RPC signatures exist'
);

select ok(
  (
    select pg_catalog.bool_and(
             p.prosecdef
             and coalesce(
                   p.proconfig,
                   '{}'::text[]
                 ) @> array['search_path=""']
             and pg_catalog.has_function_privilege(
               'service_role',
               p.oid,
               'EXECUTE'
             )
             and not pg_catalog.has_function_privilege(
               'anon',
               p.oid,
               'EXECUTE'
             )
             and not pg_catalog.has_function_privilege(
               'authenticated',
               p.oid,
               'EXECUTE'
             )
             and not exists (
               select 1
                 from pg_catalog.aclexplode(
                   coalesce(
                     p.proacl,
                     pg_catalog.acldefault(
                       'f'::"char",
                       p.proowner
                     )
                   )
                 ) acl
                where acl.grantee = 0
                  and acl.privilege_type = 'EXECUTE'
             )
           )
      from pg_catalog.pg_proc p
     where p.oid = any(array[
       'public.claim_oauth_anon_auth_cleanup(uuid,integer)'::regprocedure,
       'public.verify_oauth_anon_auth_cleanup_source(uuid,uuid,integer)'::regprocedure,
       'public.finish_oauth_anon_auth_cleanup(uuid,uuid,integer,text,text)'::regprocedure
     ])
  ),
  'cleanup RPCs are service-role-only empty-search-path definers'
);

select ok(
  (
    select not p.prosecdef
       and coalesce(p.proconfig, '{}'::text[])
         = array['search_path=""']::text[]
       and not exists (
         select 1
           from pg_catalog.aclexplode(
             coalesce(
               p.proacl,
               pg_catalog.acldefault(
                 'f'::"char",
                 p.proowner
               )
             )
           ) acl
          where acl.grantee <> p.proowner
            and acl.privilege_type = 'EXECUTE'
       )
      from pg_catalog.pg_proc p
     where p.oid =
       'public.guard_oauth_critical_relation_truncate()'::regprocedure
  ),
  'critical-relation TRUNCATE guard is owner-only with an exact empty search path'
);

select ok(
  (
    select pg_catalog.count(*) = 8
       and pg_catalog.count(t.oid) = 8
       and (
         select pg_catalog.count(*) = 8
           from pg_catalog.pg_trigger actual
          where actual.tgname =
            'trg_oauth_critical_relation_truncate'
            and not actual.tgisinternal
       )
       and coalesce(
         pg_catalog.bool_and(
           not t.tgisinternal
           and t.tgenabled = 'O'
           and t.tgtype = 34
           and t.tgqual is null
           and t.tgconstraint = 0
           and t.tgparentid = 0
           and not t.tgdeferrable
           and not t.tginitdeferred
           and t.tgfoid =
             'public.guard_oauth_critical_relation_truncate()'::regprocedure
           and pg_catalog.cardinality(
             t.tgattr::smallint[]
           ) = 0
         ),
         false
       )
      from (
        values
          ('public.anon_data_reassignments'),
          ('public.oauth_flow_intents'),
          ('public.oauth_anon_auth_cleanup_jobs'),
          ('public.oauth_quarantined_score_highlights'),
          ('public.oauth_deidentified_score_owner_tombstones'),
          ('public.oauth_auth_session_id_tombstones'),
          ('public.legacy_signup_migration_receipts'),
          ('public.oauth_rollout_deployment_qualifications')
      ) expected(relation_name)
      left join pg_catalog.pg_trigger t
        on t.tgrelid =
          pg_catalog.to_regclass(expected.relation_name)
       and t.tgname =
         'trg_oauth_critical_relation_truncate'
  ),
  'all eight critical private relations have the exact BEFORE TRUNCATE statement guard'
);

select throws_ok(
  $sql$
    truncate table public.oauth_quarantined_score_highlights
  $sql$,
  'P0001',
  'oauth_critical_relation_truncate_forbidden',
  'owner-level TRUNCATE fails with the exact permanent-denial error'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000001',
  '94100000-0000-4000-8000-000000000001',
  '94200000-0000-4000-8000-000000000001',
  '94300000-0000-4000-8000-000000000001',
  '94400000-0000-4000-8000-000000000001'
);

select ok(
  (
    select cleanup.status = 'dormant'
       and cleanup.source_user_id = source_user.id
       and cleanup.source_auth_created_at =
         source_user.created_at
       and cleanup.source_auth_instance_id
         is not distinct from source_user.instance_id
       and cleanup.armed_at is null
      from public.oauth_anon_auth_cleanup_jobs as cleanup
      join auth.users as source_user
        on source_user.id = cleanup.source_user_id
     where cleanup.flow_id =
       '94000000-0000-4000-8000-000000000001'
  ),
  'begin captures the exact original Auth generation as a dormant receipt'
);

insert into oauth_cleanup_results(name, value)
values (
  'consume',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000001',
    '94300000-0000-4000-8000-000000000001',
    '94400000-0000-4000-8000-000000000001',
    '94100000-0000-4000-8000-000000000001',
    repeat('a', 64),
    repeat('b', 64)
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'alreadyConsumed' = 'false'
       and (
         select pg_catalog.count(*)::integer
           from pg_catalog.jsonb_object_keys(value)
       ) = 5
      from oauth_cleanup_results
     where name = 'consume'
  ),
  'migration consumption keeps its exact public five-key receipt'
);

select ok(
  (
    select flow.migration_consumed_at is not null
       and cleanup.status = 'pending'
       and cleanup.armed_at is not null
       and cleanup.next_attempt_at is not null
       and cleanup.finished_at is null
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
     where flow.flow_id =
       '94000000-0000-4000-8000-000000000001'
  ),
  'reassignment receipt and retryable Auth cleanup arm commit together'
);

select throws_ok(
  $sql$
    insert into auth.users(id, email, is_anonymous)
    values (
      '94100000-0000-4000-8000-000000000001',
      'reused-while-pending@test.local',
      false
    )
  $sql$,
  '23514',
  'oauth_anon_auth_cleanup_pending',
  'pending cleanup rejects source UUID reuse before uniqueness is considered'
);

select throws_ok(
  $sql$
    update auth.users
       set is_anonymous = false
     where id = '94100000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'oauth_anon_auth_cleanup_pending',
  'pending cleanup rejects promotion of the exact source generation'
);

insert into oauth_cleanup_results(name, value)
values (
  'claim_one',
  public.claim_oauth_anon_auth_cleanup(
    '94500000-0000-4000-8000-000000000001',
    20
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'cleanupId' =
         '94000000-0000-4000-8000-000000000001'
       and value->>'sourceUserId' =
         '94100000-0000-4000-8000-000000000001'
       and value->>'leaseToken' =
         '94500000-0000-4000-8000-000000000001'
       and value->>'leaseVersion' = '1'
       and value->>'attemptCount' = '1'
       and value->'sourceAuthCreatedAt' <> 'null'::jsonb
       and (
         select pg_catalog.count(*)::integer
           from pg_catalog.jsonb_object_keys(value)
       ) = 7
      from oauth_cleanup_results
     where name = 'claim_one'
  ),
  'claim returns an exact source-generation and lease fence'
);

select is(
  public.verify_oauth_anon_auth_cleanup_source(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000099',
    1
  ),
  '{"ok":false,"error":"oauth_anon_auth_cleanup_lease_conflict"}'::jsonb,
  'source verification rejects a mismatched lease token'
);

select is(
  public.verify_oauth_anon_auth_cleanup_source(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000001',
    1
  ),
  '{"ok":true,"cleanupId":"94000000-0000-4000-8000-000000000001","state":"deletable"}'::jsonb,
  'only the exact original anonymous Auth generation is deletable'
);

select is(
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000001',
    1,
    'completed',
    null
  ),
  '{"ok":false,"error":"oauth_anon_auth_cleanup_outcome_mismatch"}'::jsonb,
  'delete acknowledgement cannot complete while Auth still contains the source'
);

select is(
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000001',
    1,
    'protected',
    'source_generation_changed'
  ),
  '{"ok":false,"error":"oauth_anon_auth_cleanup_outcome_mismatch"}'::jsonb,
  'the exact original generation cannot be falsely protected'
);

insert into oauth_cleanup_results(name, value)
values (
  'retry_one',
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000001',
    1,
    'pending',
    'auth_delete_not_confirmed'
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'status' = 'pending'
       and value->>'leaseVersion' = '1'
       and (value->>'nextAttemptAt')::timestamptz >
         pg_catalog.clock_timestamp()
      from oauth_cleanup_results
     where name = 'retry_one'
  ),
  'retry clears the lease and records bounded exponential backoff'
);

select is(
  public.claim_oauth_anon_auth_cleanup(
    '94500000-0000-4000-8000-000000000002',
    20
  ),
  '{"ok":true,"idle":true,"pendingBacklog":1}'::jsonb,
  'an idle claim preserves future durable retry backlog instead of false-green null'
);

update public.oauth_anon_auth_cleanup_jobs
   set next_attempt_at = pg_catalog.clock_timestamp()
 where flow_id =
   '94000000-0000-4000-8000-000000000001';

insert into oauth_cleanup_results(name, value)
values (
  'claim_two',
  public.claim_oauth_anon_auth_cleanup(
    '94500000-0000-4000-8000-000000000002',
    20
  )
);

select ok(
  (
    select value->>'leaseVersion' = '2'
       and value->>'attemptCount' = '2'
       and value->>'leaseToken' =
         '94500000-0000-4000-8000-000000000002'
      from oauth_cleanup_results
     where name = 'claim_two'
  ),
  'a due retry advances both lease and attempt fences exactly once'
);

select is(
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000001',
    1,
    'pending',
    'stale_worker'
  ),
  '{"ok":false,"error":"oauth_anon_auth_cleanup_lease_conflict"}'::jsonb,
  'a reclaimed job rejects the stale worker finish'
);

delete from auth.users
 where id = '94100000-0000-4000-8000-000000000001';

select throws_ok(
  $sql$
    insert into auth.users(id, email, is_anonymous)
    values (
      '94100000-0000-4000-8000-000000000001',
      'reused-while-leased@test.local',
      false
    )
  $sql$,
  '23514',
  'oauth_anon_auth_cleanup_pending',
  'a lost-delete window rejects UUID reuse while the lease is open'
);

select is(
  public.verify_oauth_anon_auth_cleanup_source(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000002',
    2
  ),
  '{"ok":true,"cleanupId":"94000000-0000-4000-8000-000000000001","state":"absent"}'::jsonb,
  'fresh authoritative verification observes the committed Auth absence'
);

select is(
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000002',
    2,
    'completed',
    null
  )->>'status',
  'completed',
  'fresh absence and the exact lease commit the terminal cleanup receipt'
);

select throws_ok(
  $sql$
    insert into auth.users(
      id,
      email,
      is_anonymous,
      created_at,
      updated_at
    )
    values (
      '94100000-0000-4000-8000-000000000001',
      'valid-reuse-after-completion@test.local',
      false,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    )
  $sql$,
  '23514',
  'anon_reassignment_principal_tombstoned',
  'a committed reassignment permanently rejects source UUID generation reuse'
);

select ok(
  (
    select not exists (
             select 1
               from auth.users
              where id =
                '94100000-0000-4000-8000-000000000001'
           )
       and exists (
             select 1
               from public.anon_data_reassignments
              where source_user_id =
                '94100000-0000-4000-8000-000000000001'
           )
  ),
  'terminal cleanup keeps the source absent behind its permanent reassignment tombstone'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() - interval '40 days'
    as created_at
)
update public.oauth_flow_intents
   set created_at = stamp.created_at,
       expires_at = stamp.created_at + interval '10 minutes',
       claimed_at = stamp.created_at + interval '1 minute',
       finished_at = stamp.created_at + interval '2 minutes',
       released_at = stamp.created_at + interval '3 minutes',
       migration_consumed_at =
         stamp.created_at + interval '4 minutes'
  from stamp
 where flow_id =
   '94000000-0000-4000-8000-000000000001';

select is(
  public.prune_oauth_flow_intents(500)->>'prunedTerminal',
  '0',
  'recent cleanup completion extends terminal flow retention'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_anon_auth_cleanup_jobs
   set created_at = stamp.now_at - interval '45 days',
       armed_at = stamp.now_at - interval '44 days',
       finished_at = stamp.now_at - interval '36 days'
  from stamp
 where flow_id =
   '94000000-0000-4000-8000-000000000001';

select is(
  public.prune_oauth_flow_intents(500)->>'prunedTerminal',
  '1',
  'terminal flow becomes pruneable only after its cleanup receipt retention'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id =
       '94000000-0000-4000-8000-000000000001'
  ),
  0,
  'retention removes the old OAuth flow'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_anon_auth_cleanup_jobs
     where flow_id =
       '94000000-0000-4000-8000-000000000001'
  ),
  0,
  'flow retention cascades only the already-terminal cleanup receipt'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.anon_data_reassignments
     where source_user_id =
       '94100000-0000-4000-8000-000000000001'
  ),
  1,
  'flow pruning preserves the permanent source principal tombstone'
);

select pg_temp.prepare_oauth_cleanup_fault_flow(
  '94000000-0000-4000-8000-000000000002',
  '94100000-0000-4000-8000-000000000002',
  '94200000-0000-4000-8000-000000000002',
  '94300000-0000-4000-8000-000000000002',
  '94400000-0000-4000-8000-000000000002',
  false,
  true
);

select is(
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000002',
    '94300000-0000-4000-8000-000000000002',
    '94400000-0000-4000-8000-000000000002',
    '94100000-0000-4000-8000-000000000002',
    repeat('a', 64),
    repeat('b', 64)
  )->'migrationResult',
  '{"ok":true,"skipped":"source_not_anonymous"}'::jsonb,
  'a reused non-anonymous source generation converges without reassignment'
);

select ok(
  (
    select flow.migration_consumed_at is not null
       and flow.migration_result =
         '{"ok":true,"skipped":"source_not_anonymous"}'::jsonb
       and cleanup.status = 'blocked'
       and cleanup.quarantine_reason = 'migration_blocked'
       and cleanup.last_error = 'source_not_anonymous'
       and cleanup.armed_at is null
       and cleanup.finished_at is null
       and not exists (
         select 1
           from public.anon_data_reassignments as reassignment
          where reassignment.source_user_id =
            flow.source_user_id
       )
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
     where flow.flow_id =
       '94000000-0000-4000-8000-000000000002'
  ),
  'a non-anonymous source commits no transfer and an explicit blocked privacy receipt'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from auth.users
     where id =
       '94100000-0000-4000-8000-000000000002'
       and not is_anonymous
  ),
  1,
  'the reused valid source survives a rejected migration'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000003',
  '94100000-0000-4000-8000-000000000003',
  '94200000-0000-4000-8000-000000000003',
  '94300000-0000-4000-8000-000000000003',
  '94400000-0000-4000-8000-000000000003'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000003',
    '94300000-0000-4000-8000-000000000003',
    '94400000-0000-4000-8000-000000000003',
    '94100000-0000-4000-8000-000000000003',
    repeat('a', 64),
    repeat('b', 64)
  )->>'ok',
  'true',
  'protected fault-injection fixture first commits a normal migration'
);

-- Simulate a pre-fence stale generation receipt while every current Auth
-- trigger stays enabled. The worker must still converge to protected, never
-- delete the live principal, and release the retry fence only through finish.
update public.oauth_anon_auth_cleanup_jobs
   set status = 'dormant',
       armed_at = null,
       next_attempt_at = null,
       source_auth_created_at =
         source_auth_created_at - interval '1 microsecond'
 where flow_id =
   '94000000-0000-4000-8000-000000000003';
update public.oauth_anon_auth_cleanup_jobs
   set status = 'pending',
       armed_at = pg_catalog.clock_timestamp(),
       next_attempt_at = pg_catalog.clock_timestamp()
 where flow_id =
   '94000000-0000-4000-8000-000000000003';

insert into oauth_cleanup_results(name, value)
values (
  'protected_claim',
  public.claim_oauth_anon_auth_cleanup(
    '94500000-0000-4000-8000-000000000003',
    20
  )
);

select is(
  public.verify_oauth_anon_auth_cleanup_source(
    '94000000-0000-4000-8000-000000000003',
    '94500000-0000-4000-8000-000000000003',
    1
  )->>'state',
  'protected',
  'fresh DB verification identifies a replaced or promoted source'
);

select is(
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000003',
    '94500000-0000-4000-8000-000000000003',
    1,
    'protected',
    'source_generation_changed'
  )->>'status',
  'protected',
  'exact mismatch commits a protected terminal receipt'
);

select throws_ok(
  $sql$
    update auth.users
       set created_at = created_at + interval '1 microsecond'
     where id = '94100000-0000-4000-8000-000000000003'
  $sql$,
  '23514',
  'anon_reassignment_principal_tombstoned',
  'protected cleanup never weakens the permanent reassignment principal tombstone'
);

select is(
  (
    select pg_catalog.count(*)::integer
     from auth.users
     where id =
       '94100000-0000-4000-8000-000000000003'
       and is_anonymous
  ),
  1,
  'protected convergence never deletes the live mismatched source generation'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000004',
  '94100000-0000-4000-8000-000000000004',
  '94200000-0000-4000-8000-000000000004',
  '94300000-0000-4000-8000-000000000004',
  '94400000-0000-4000-8000-000000000004',
  true
);

select ok(
  (
    select flow.migration_consumed_at is not null
       and flow.migration_result =
         '{"ok":true,"skipped":"target_already_member"}'::jsonb
       and cleanup.status = 'quarantined'
       and cleanup.quarantine_reason = 'target_already_member'
       and cleanup.quarantined_at is not null
       and cleanup.access_revoked_at is not null
       and cleanup.armed_at is null
       and cleanup.finished_at is null
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
     where flow.flow_id =
       '94000000-0000-4000-8000-000000000004'
  ),
  'existing-member finalize atomically records no transfer and recoverable source quarantine'
);

select ok(
  (
    select replay->>'ok' = 'true'
       and replay->>'alreadyConsumed' = 'true'
       and replay->'migrationResult' =
         '{"ok":true,"skipped":"target_already_member"}'::jsonb
      from (
        select public.consume_oauth_flow_intent_migration(
          '94000000-0000-4000-8000-000000000004',
          '94300000-0000-4000-8000-000000000004',
          '94400000-0000-4000-8000-000000000004',
          '94100000-0000-4000-8000-000000000004',
          repeat('a', 64),
          repeat('b', 64)
        ) as replay
      ) replay_result
  ),
  'not-applicable replay returns only its no-transfer receipt and cannot masquerade as a merge'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from auth.users
     where id = '94100000-0000-4000-8000-000000000004'
       and is_anonymous
  ),
  1,
  'existing-member no-merge protection preserves the separate anonymous Auth principal'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000005',
  '94100000-0000-4000-8000-000000000005',
  '94200000-0000-4000-8000-000000000005',
  '94300000-0000-4000-8000-000000000005',
  '94400000-0000-4000-8000-000000000005'
);

select ok(
  (
    select discovered->>'ok' = 'true'
       and discovered->>'flowId' =
         '94000000-0000-4000-8000-000000000005'
       and discovered->>'state' = 'completed'
       and discovered->>'active' = 'false'
       and discovered->'migrationConsumedAt' = 'null'::jsonb
      from (
        select
          public.recover_active_oauth_flow_by_observed_session(
            '94300000-0000-4000-8000-000000000005',
            '94400000-0000-4000-8000-000000000005'
          ) as discovered
      ) discovery
  ),
  'released unconsumed anonymous migration remains discoverable after its query parameter is stripped'
);

insert into public.member_accounts(user_id)
values ('94300000-0000-4000-8000-000000000005');

insert into oauth_cleanup_results(name, value)
select
  'target_member_after_finalize',
  public.complete_oauth_flow_intent_migration_without_transfer(
    '94000000-0000-4000-8000-000000000005',
    '94300000-0000-4000-8000-000000000005',
    '94400000-0000-4000-8000-000000000005',
    '94100000-0000-4000-8000-000000000005',
    'target_already_member'
  );

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'flowId' =
         '94000000-0000-4000-8000-000000000005'
       and value->>'alreadyConsumed' = 'false'
       and value->'migrationResult' =
         '{"ok":true,"skipped":"target_already_member"}'::jsonb
       and (
         select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(value)
       ) = 5
      from oauth_cleanup_results
     where name = 'target_member_after_finalize'
  ),
  'post-finalize member creation commits an exact no-transfer receipt'
);

select ok(
  (
    select flow.migration_consumed_at is not null
       and cleanup.status = 'quarantined'
       and cleanup.quarantine_reason = 'target_already_member'
       and cleanup.quarantined_at is not null
       and cleanup.access_revoked_at is not null
       and cleanup.finished_at is null
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
     where flow.flow_id =
       '94000000-0000-4000-8000-000000000005'
  ),
  'post-finalize no-transfer receipt and recoverable quarantine commit atomically'
);

select ok(
  (
    select replay->>'ok' = 'true'
       and replay->>'alreadyConsumed' = 'true'
       and replay->'migrationResult' =
         '{"ok":true,"skipped":"target_already_member"}'::jsonb
      from (
        select
          public.complete_oauth_flow_intent_migration_without_transfer(
            '94000000-0000-4000-8000-000000000005',
            '94300000-0000-4000-8000-000000000005',
            '94400000-0000-4000-8000-000000000005',
            '94100000-0000-4000-8000-000000000005',
            'target_already_member'
          ) as replay
      ) replay_result
  ),
  'a committed no-transfer receipt replays idempotently for its exact proven reason'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from auth.users
     where id = '94100000-0000-4000-8000-000000000005'
       and is_anonymous
  ),
  1,
  'post-finalize target-member protection preserves the anonymous Auth principal'
);

select is(
  public.recover_active_oauth_flow_by_observed_session(
    '94300000-0000-4000-8000-000000000005',
    '94400000-0000-4000-8000-000000000005'
  ),
  '{"ok":true,"state":"absent","active":false}'::jsonb,
  'discovery stops surfacing the flow only after migration reaches a durable terminal receipt'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000006',
  '94100000-0000-4000-8000-000000000006',
  '94200000-0000-4000-8000-000000000006',
  '94300000-0000-4000-8000-000000000006',
  '94400000-0000-4000-8000-000000000006'
);

select is(
  public.complete_oauth_flow_intent_migration_without_transfer(
    '94000000-0000-4000-8000-000000000006',
    '94300000-0000-4000-8000-000000000006',
    '94400000-0000-4000-8000-000000000006',
    '94100000-0000-4000-8000-000000000006',
    'target_already_member'
  ),
  '{"ok":false,"error":"oauth_flow_migration_skip_reason_not_proven"}'::jsonb,
  'service role cannot assert a no-transfer reason that the locked database state does not prove'
);

select ok(
  (
    select flow.migration_consumed_at is null
       and cleanup.status = 'dormant'
       and cleanup.armed_at is null
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
     where flow.flow_id =
       '94000000-0000-4000-8000-000000000006'
  ),
  'an unproven reason leaves both flow and cleanup receipts untouched'
);

insert into public.member_accounts(user_id)
values ('94300000-0000-4000-8000-000000000006');

insert into oauth_cleanup_results(name, value)
select
  'consume_target_member_race',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000006',
    '94300000-0000-4000-8000-000000000006',
    '94400000-0000-4000-8000-000000000006',
    '94100000-0000-4000-8000-000000000006',
    repeat('a', 64),
    repeat('b', 64)
  );

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'alreadyConsumed' = 'false'
       and value->'migrationResult' =
         '{"ok":true,"skipped":"target_already_member"}'::jsonb
      from oauth_cleanup_results
     where name = 'consume_target_member_race'
  ),
  'consume rechecks a target-member race under the ownership lock and returns no-transfer'
);

select ok(
  (
    select flow.migration_result =
           '{"ok":true,"skipped":"target_already_member"}'::jsonb
       and cleanup.status = 'quarantined'
       and cleanup.quarantine_reason = 'target_already_member'
       and cleanup.access_revoked_at is not null
       and source_user.is_anonymous
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
      join auth.users as source_user
        on source_user.id = cleanup.source_user_id
     where flow.flow_id =
       '94000000-0000-4000-8000-000000000006'
  ),
  'the consume/member race cannot arm deletion or merge the quarantined anonymous source'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000007',
  '94100000-0000-4000-8000-000000000007',
  '94200000-0000-4000-8000-000000000007',
  '94300000-0000-4000-8000-000000000007',
  '94400000-0000-4000-8000-000000000007'
);
insert into public.member_accounts(user_id)
values ('94100000-0000-4000-8000-000000000007');
insert into oauth_cleanup_results(name, value)
select
  'consume_source_member',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000007',
    '94300000-0000-4000-8000-000000000007',
    '94400000-0000-4000-8000-000000000007',
    '94100000-0000-4000-8000-000000000007',
    repeat('a', 64),
    repeat('b', 64)
  );

select is(
  (
    select value->'migrationResult'
      from oauth_cleanup_results
     where name = 'consume_source_member'
  ),
  '{"ok":true,"skipped":"source_is_member"}'::jsonb,
  'consume atomically protects a source that became a member'
);

select pg_temp.prepare_oauth_cleanup_fault_flow(
  '94000000-0000-4000-8000-000000000008',
  '94100000-0000-4000-8000-000000000008',
  '94200000-0000-4000-8000-000000000008',
  '94300000-0000-4000-8000-000000000008',
  '94400000-0000-4000-8000-000000000008',
  false,
  true
);
insert into oauth_cleanup_results(name, value)
select
  'consume_source_promoted',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000008',
    '94300000-0000-4000-8000-000000000008',
    '94400000-0000-4000-8000-000000000008',
    '94100000-0000-4000-8000-000000000008',
    repeat('a', 64),
    repeat('b', 64)
  );

select is(
  (
    select value->'migrationResult'
      from oauth_cleanup_results
     where name = 'consume_source_promoted'
  ),
  '{"ok":true,"skipped":"source_not_anonymous"}'::jsonb,
  'consume atomically protects a source promoted before migration'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000009',
  '94100000-0000-4000-8000-000000000009',
  '94200000-0000-4000-8000-000000000009',
  '94300000-0000-4000-8000-000000000009',
  '94400000-0000-4000-8000-000000000009'
);
insert into public.dolls(owner_id, image_url)
values (
  '94100000-0000-4000-8000-000000000009',
  'https://example.com/unsupported-source.png'
);
insert into oauth_cleanup_results(name, value)
select
  'consume_unsupported_data',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000009',
    '94300000-0000-4000-8000-000000000009',
    '94400000-0000-4000-8000-000000000009',
    '94100000-0000-4000-8000-000000000009',
    repeat('a', 64),
    repeat('b', 64)
  );

select is(
  (
    select value->'migrationResult'
      from oauth_cleanup_results
     where name = 'consume_unsupported_data'
  ),
  '{"ok":true,"skipped":"unexpected_source_data"}'::jsonb,
  'consume atomically protects unsupported source-owned data created after the app count'
);

select pg_temp.prepare_oauth_cleanup_fault_flow(
  '94000000-0000-4000-8000-000000000010',
  '94100000-0000-4000-8000-000000000010',
  '94200000-0000-4000-8000-000000000010',
  '94300000-0000-4000-8000-000000000010',
  '94400000-0000-4000-8000-000000000010',
  true,
  false
);
insert into oauth_cleanup_results(name, value)
select
  'consume_generation_changed',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000010',
    '94300000-0000-4000-8000-000000000010',
    '94400000-0000-4000-8000-000000000010',
    '94100000-0000-4000-8000-000000000010',
    repeat('a', 64),
    repeat('b', 64)
  );

select is(
  (
    select value->'migrationResult'
      from oauth_cleanup_results
     where name = 'consume_generation_changed'
  ),
  '{"ok":true,"skipped":"source_generation_changed"}'::jsonb,
  'consume never transfers or deletes a reused anonymous UUID generation'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        using (flow_id)
     where flow.flow_id in (
       '94000000-0000-4000-8000-000000000007',
       '94000000-0000-4000-8000-000000000008',
       '94000000-0000-4000-8000-000000000009',
       '94000000-0000-4000-8000-000000000010'
     )
       and flow.migration_consumed_at is not null
       and cleanup.status = 'blocked'
       and cleanup.quarantine_reason = 'migration_blocked'
       and cleanup.last_error =
         flow.migration_result->>'skipped'
       and cleanup.armed_at is null
       and cleanup.finished_at is null
  ),
  4,
  'every source-side no-transfer reason remains explicit blocked non-green privacy work'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.anon_data_reassignments
     where source_user_id in (
       '94100000-0000-4000-8000-000000000005',
       '94100000-0000-4000-8000-000000000006',
       '94100000-0000-4000-8000-000000000007',
       '94100000-0000-4000-8000-000000000008',
       '94100000-0000-4000-8000-000000000009',
       '94100000-0000-4000-8000-000000000010'
     )
  ),
  0,
  'no-transfer terminal receipts never create an anonymous ownership reassignment winner'
);

insert into oauth_cleanup_results(name, value)
values (
  'privacy_before_attempt_limit',
  public.oauth_anon_privacy_status()
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000011',
  '94100000-0000-4000-8000-000000000011',
  '94200000-0000-4000-8000-000000000011',
  '94300000-0000-4000-8000-000000000011',
  '94400000-0000-4000-8000-000000000011'
);
insert into oauth_cleanup_results(name, value)
values (
  'consume_attempt_limit',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000011',
    '94300000-0000-4000-8000-000000000011',
    '94400000-0000-4000-8000-000000000011',
    '94100000-0000-4000-8000-000000000011',
    repeat('a', 64),
    repeat('b', 64)
  )
);
update public.oauth_anon_auth_cleanup_jobs
   set lease_version = 2147483646,
       attempt_count = 2147483646,
       next_attempt_at = pg_catalog.clock_timestamp(),
       last_error = 'prior_retry'
 where flow_id =
   '94000000-0000-4000-8000-000000000011';

insert into oauth_cleanup_results(name, value)
values (
  'claim_attempt_limit',
  public.claim_oauth_anon_auth_cleanup(
    '94500000-0000-4000-8000-000000000011',
    20
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'cleanupId' =
         '94000000-0000-4000-8000-000000000011'
       and value->>'leaseToken' =
         '94500000-0000-4000-8000-000000000011'
       and value->>'leaseVersion' = '2147483647'
       and value->>'attemptCount' = '2147483647'
       and (
         select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(value)
       ) = 7
      from oauth_cleanup_results
     where name = 'claim_attempt_limit'
  ),
  'the max-minus-one pending lease is claimed exactly once at the integer bound'
);

insert into oauth_cleanup_results(name, value)
values (
  'finish_attempt_limit',
  public.finish_oauth_anon_auth_cleanup(
    '94000000-0000-4000-8000-000000000011',
    '94500000-0000-4000-8000-000000000011',
    2147483647,
    'pending',
    'last_attempt_failed'
  )
);

select is(
  (
    select value
      from oauth_cleanup_results
     where name = 'finish_attempt_limit'
  ),
  '{"ok":true,"cleanupId":"94000000-0000-4000-8000-000000000011","status":"protected","leaseVersion":2147483647,"nextAttemptAt":null}'::jsonb,
  'a pending finish at the final lease becomes an explicit terminal failure'
);

select ok(
  (
    select status = 'protected'
       and lease_version = 2147483647
       and attempt_count = 2147483647
       and lease_token is null
       and lease_expires_at is null
       and next_attempt_at is null
       and last_error = 'cleanup_attempt_limit_exhausted'
       and finished_at is not null
      from public.oauth_anon_auth_cleanup_jobs
     where flow_id =
       '94000000-0000-4000-8000-000000000011'
  ),
  'the final pending finish cannot wrap its counter or disappear from failure monitoring'
);

select pg_temp.prepare_oauth_cleanup_flow(
  '94000000-0000-4000-8000-000000000012',
  '94100000-0000-4000-8000-000000000012',
  '94200000-0000-4000-8000-000000000012',
  '94300000-0000-4000-8000-000000000012',
  '94400000-0000-4000-8000-000000000012'
);
insert into oauth_cleanup_results(name, value)
values (
  'consume_crashed_final_lease',
  public.consume_oauth_flow_intent_migration(
    '94000000-0000-4000-8000-000000000012',
    '94300000-0000-4000-8000-000000000012',
    '94400000-0000-4000-8000-000000000012',
    '94100000-0000-4000-8000-000000000012',
    repeat('a', 64),
    repeat('b', 64)
  )
);
with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_anon_auth_cleanup_jobs
   set status = 'leased',
       lease_token =
         '94500000-0000-4000-8000-000000000012',
       lease_version = 2147483647,
       attempt_count = 2147483647,
       created_at = stamp.now_at - interval '3 minutes',
       armed_at = stamp.now_at - interval '2 minutes',
       next_attempt_at = stamp.now_at - interval '2 minutes',
       lease_expires_at = stamp.now_at - interval '1 minute',
       last_error = 'worker_crashed'
  from stamp
 where flow_id =
   '94000000-0000-4000-8000-000000000012';

insert into oauth_cleanup_results(name, value)
values (
  'claim_after_crashed_final_lease',
  public.claim_oauth_anon_auth_cleanup(
    '94500000-0000-4000-8000-000000000013',
    20
  )
);

select is(
  (
    select value
      from oauth_cleanup_results
     where name = 'claim_after_crashed_final_lease'
  ),
  '{"ok":true,"idle":true,"pendingBacklog":0}'::jsonb,
  'the next claimant terminalizes an expired final lease instead of wrapping or hiding it'
);

select ok(
  (
    select status = 'protected'
       and lease_version = 2147483647
       and attempt_count = 2147483647
       and lease_token is null
       and lease_expires_at is null
       and next_attempt_at is null
       and last_error = 'cleanup_attempt_limit_exhausted'
       and finished_at is not null
      from public.oauth_anon_auth_cleanup_jobs
     where flow_id =
       '94000000-0000-4000-8000-000000000012'
  ),
  'a crashed final lease remains a visible protected failure with no retryable ghost row'
);

insert into oauth_cleanup_results(name, value)
values (
  'privacy_after_attempt_limit',
  public.oauth_anon_privacy_status()
);

select ok(
  (
    select (after_status.value->>'failures')::integer =
             (before_status.value->>'failures')::integer + 2
       and after_status.value->>'capped' = 'false'
       and (
         select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(after_status.value)
       ) = 6
      from oauth_cleanup_results as before_status
      cross join oauth_cleanup_results as after_status
     where before_status.name = 'privacy_before_attempt_limit'
       and after_status.name = 'privacy_after_attempt_limit'
  ),
  'privacy status exposes both attempt-limit terminals in its exact six-key failure ACK'
);

insert into public.anon_data_reassignments(
  source_user_id,
  target_user_id,
  result,
  created_at
)
select
  pg_catalog.md5(
    'oauth-cleanup-cap-source-' || series.value::text
  )::uuid,
  pg_catalog.md5(
    'oauth-cleanup-cap-target-' || series.value::text
  )::uuid,
  pg_catalog.jsonb_build_object(
    'ok', true,
    'scores', 0,
    'badges', 0,
    'telemetry', 0
  ),
  pg_catalog.clock_timestamp() - interval '1 day'
from pg_catalog.generate_series(1, 1001) as series(value);

insert into public.oauth_anon_auth_cleanup_jobs(
  cleanup_id,
  legacy_source_user_id,
  source_user_id,
  source_auth_created_at,
  status,
  lease_version,
  attempt_count,
  last_error,
  created_at,
  armed_at,
  finished_at
)
select
  pg_catalog.md5(
    'oauth-cleanup-cap-job-' || series.value::text
  )::uuid,
  pg_catalog.md5(
    'oauth-cleanup-cap-source-' || series.value::text
  )::uuid,
  pg_catalog.md5(
    'oauth-cleanup-cap-source-' || series.value::text
  )::uuid,
  pg_catalog.clock_timestamp() - interval '2 days',
  'protected',
  2147483647,
  2147483647,
  'cleanup_attempt_limit_exhausted',
  pg_catalog.clock_timestamp() - interval '1 day',
  pg_catalog.clock_timestamp() - interval '12 hours',
  pg_catalog.clock_timestamp()
from pg_catalog.generate_series(1, 1001) as series(value);

select ok(
  (
    select status->>'failures' = '1000'
       and status->>'capped' = 'true'
       and (
         select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(status)
       ) = 6
      from (
        select public.oauth_anon_privacy_status() as status
      ) privacy
  ),
  'privacy status caps an over-limit terminal failure population and marks the truncation explicitly'
);

select * from finish();
rollback;
