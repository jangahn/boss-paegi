-- Durable OAuth callback ledger.
--
-- This rollback-only suite verifies the complete database state machine:
-- schema invariants, exact replay receipts, conflicting retries, two-phase
-- sign-out, flow-scoped anonymous migration, expiry, retention, and ACLs.

begin;
select plan(362);

create temporary table oauth_test_results (
  name text primary key,
  value jsonb not null
) on commit drop;

-- Snapshot the rollout stage before this rollback-only suite inserts any
-- synthetic expand qualification evidence.
create temporary table oauth_test_rollout_stage
on commit drop
as
select
  qualification_count = 1
    and not pg_catalog.has_function_privilege(
      'service_role',
      'public.reassign_anon_data(uuid,uuid)'::regprocedure,
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role',
      'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure,
      'EXECUTE'
    ) as is_contract,
  qualification_count,
  qualification_evidence_sha256
from (
  select pg_catalog.count(*)::integer as qualification_count,
         pg_catalog.min(evidence_sha256)
           as qualification_evidence_sha256
    from public.oauth_rollout_deployment_qualifications
   where contract_version =
     '0094_oauth_flow_migration_contract'
) qualification;

create or replace function pg_temp.oauth_test_check_rejected(
  p_sql text
)
returns boolean
language plpgsql
as $$
begin
  execute p_sql;
  return false;
exception
  when check_violation then
    return true;
end;
$$;

create or replace function pg_temp.oauth_test_unique_rejected(
  p_sql text
)
returns boolean
language plpgsql
as $$
begin
  execute p_sql;
  return false;
exception
  when unique_violation then
    return true;
end;
$$;

create or replace function
  pg_temp.oauth_test_qualification_assertion_outcome()
returns text
language plpgsql
as $$
begin
  perform public.assert_oauth_rollout_deployment_qualification(
    '0094_oauth_flow_migration_contract'
  );
  return 'accepted';
exception
  when sqlstate 'P0001' then
    if sqlerrm =
       'oauth_rollout_deployment_qualification_required' then
      return 'required';
    end if;
    return 'unexpected:' || sqlerrm;
end;
$$;

create or replace function pg_temp.oauth_test_install_auth_authority(
  p_user_id uuid,
  p_session_id uuid
)
returns void
language plpgsql
as $$
begin
  insert into auth.users(
    id,
    email,
    is_anonymous,
    created_at,
    updated_at
  )
  select
    p_user_id,
    'oauth-authority-' || p_user_id::text || '@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  where not exists (
    select 1
      from auth.users
     where id = p_user_id
  );

  insert into auth.sessions(id, user_id, created_at, updated_at)
  values (
    p_session_id,
    p_user_id,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );
end;
$$;

delete from public.oauth_flow_intents
 where flow_id::text like '93000000-%';

delete from auth.users
 where id in (
   '93100000-0000-4000-8000-000000000001',
   '93300000-0000-4000-8000-000000000001',
   '93100000-0000-4000-8000-000000000050',
   '93100000-0000-4000-8000-000000000051',
   '93100000-0000-4000-8000-000000000099',
   '93100000-0000-4000-8000-000000000125',
   '93100000-0000-4000-8000-000000000199'
 );
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93100000-0000-4000-8000-000000000001',
    'oauth-ledger-source@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000001',
    'oauth-ledger-target@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93100000-0000-4000-8000-000000000050',
    'oauth-ledger-source-050@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93100000-0000-4000-8000-000000000051',
    'oauth-ledger-source-051@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93100000-0000-4000-8000-000000000099',
    'oauth-ledger-source-099@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93100000-0000-4000-8000-000000000125',
    'oauth-ledger-source-125@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

select pg_temp.oauth_test_install_auth_authority(
  '93300000-0000-4000-8000-000000000001',
  '93400000-0000-4000-8000-000000000001'
);

-- Catalog, invariants, and Data API boundary.
select has_table(
  'public',
  'oauth_flow_intents',
  'durable OAuth flow intent table exists'
);

select has_trigger(
  'public',
  'anon_data_reassignments',
  'trg_anon_data_reassignment_append_only',
  'permanent reassignment receipts have an enabled append-only guard'
);

select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.oauth_flow_intents'::regclass
  ),
  true,
  'OAuth flow intents have RLS enabled'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_policy
     where polrelid = 'public.oauth_flow_intents'::regclass
  ),
  0,
  'no direct client RLS policy exists'
);

select is(
  (
    select pg_catalog.array_agg(
             attname::text
             order by attnum
           )
      from pg_catalog.pg_attribute
     where attrelid = 'public.oauth_flow_intents'::regclass
       and attnum > 0
       and not attisdropped
  ),
  array[
    'flow_id',
    'source_user_id',
    'source_session_id',
    'source_access_token_sha256',
    'source_refresh_token_sha256',
    'source_is_anonymous',
    'provider',
    'requested_next',
    'state',
    'active',
    'session_fenced',
    'target_user_id',
    'target_session_id',
    'target_auth_created_at',
    'target_auth_instance_id',
    'target_session_created_at',
    'target_access_token_sha256',
    'target_refresh_token_sha256',
    'destination',
    'action',
    'created_at',
    'expires_at',
    'claimed_at',
    'revoke_confirmed_at',
    'finished_at',
    'released_at',
    'migration_consumed_at',
    'migration_result'
  ]::text[],
  'the ledger has exactly the intended secret-free and digest-only columns'
);

select ok(
  (
    select pg_catalog.bool_and(attnotnull)
      from pg_catalog.pg_attribute
     where attrelid = 'public.oauth_flow_intents'::regclass
       and attname in (
         'source_access_token_sha256',
         'source_refresh_token_sha256'
       )
  ),
  'both source-session SHA-256 evidence columns are mandatory'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_attribute
     where attrelid = 'public.oauth_flow_intents'::regclass
       and attnum > 0
       and not attisdropped
       and attname::text = any(array[
         'email',
         'access_token',
         'refresh_token',
         'code',
         'verifier',
         'proof',
         'secret'
       ])
  ),
  0,
  'the durable ledger stores no OAuth code, verifier, token, proof, or email'
);

select is(
  (
    select attgenerated::text
      from pg_catalog.pg_attribute
     where attrelid = 'public.oauth_flow_intents'::regclass
       and attname = 'active'
       and attnum > 0
       and not attisdropped
  ),
  's',
  'active is a stored generated state projection'
);

select is(
  (
    select attgenerated::text
      from pg_catalog.pg_attribute
     where attrelid = 'public.oauth_flow_intents'::regclass
       and attname = 'session_fenced'
       and attnum > 0
       and not attisdropped
  ),
  's',
  'session_fenced is a stored generated recovery projection'
);

select matches(
  (
    select pg_catalog.pg_get_expr(
             d.adbin,
             d.adrelid
           )
      from pg_catalog.pg_attrdef d
      join pg_catalog.pg_attribute a
        on a.attrelid = d.adrelid
       and a.attnum = d.adnum
     where d.adrelid = 'public.oauth_flow_intents'::regclass
       and a.attname = 'active'
  ),
  'pending.*claimed.*signout_required.*signout_revoked',
  'only the four recoverable states project active=true'
);

select matches(
  (
    select pg_catalog.pg_get_expr(
             d.adbin,
             d.adrelid
           )
      from pg_catalog.pg_attrdef d
      join pg_catalog.pg_attribute a
        on a.attrelid = d.adrelid
       and a.attnum = d.adnum
     where d.adrelid = 'public.oauth_flow_intents'::regclass
       and a.attname = 'session_fenced'
  ),
  'pending.*claimed.*signout_required.*signout_revoked.*completed.*continue.*released_at',
  'session fence adds only unreleased completed continue to active states'
);

select ok(
  (
    select pg_catalog.bool_and(
      not has_table_privilege(
        role_name,
        'public.oauth_flow_intents',
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
  'anon, authenticated, and service_role have no direct table privilege'
);

select has_table(
  'public',
  'oauth_rollout_deployment_qualifications',
  'OAuth contract rollout has an intrinsic deployment qualification table'
);

select ok(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid =
       'public.oauth_rollout_deployment_qualifications'::regclass
  )
  and not exists (
    select 1
      from pg_catalog.pg_policy
     where polrelid =
       'public.oauth_rollout_deployment_qualifications'::regclass
  ),
  'deployment qualification evidence is RLS-closed without a client policy'
);

select ok(
  not exists (
    select 1
      from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          c.relacl,
          pg_catalog.acldefault('r'::"char", c.relowner)
        )
      ) acl
     where c.oid =
       'public.oauth_rollout_deployment_qualifications'::regclass
       and acl.grantee <> c.relowner
  ),
  'no non-owner role, including service_role or PUBLIC, can access qualification evidence'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.unnest(array[
        'public.guard_oauth_rollout_deployment_qualification()'::regprocedure,
        'public.assert_oauth_rollout_deployment_qualification(text)'::regprocedure
      ]) function_oid
  ),
  2,
  'append-only and contract assertion guard signatures both exist'
);

select ok(
  (
    select pg_catalog.bool_and(
      coalesce(p.proconfig, '{}'::text[])
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
    )
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.guard_oauth_rollout_deployment_qualification()'::regprocedure,
       'public.assert_oauth_rollout_deployment_qualification(text)'::regprocedure
     )
  ),
  'neither qualification guard is callable by service_role, clients, or PUBLIC'
);

select has_trigger(
  'public',
  'oauth_rollout_deployment_qualifications',
  'trg_oauth_rollout_deployment_qualification_append_only',
  'qualification evidence has an enabled append-only row guard'
);

select ok(
  (
    select pg_catalog.pg_get_constraintdef(c.oid)
             ~ '(1505 seconds|00:25:05)'
      from pg_catalog.pg_constraint c
     where c.conrelid =
       'public.oauth_rollout_deployment_qualifications'::regclass
       and c.conname =
         'oauth_rollout_qualification_timeline_check'
  )
  and (
    select pg_catalog.pg_get_constraintdef(c.oid)
             ~ 'provider_function_timeout_seconds = 300'
      from pg_catalog.pg_constraint c
     where c.conrelid =
       'public.oauth_rollout_deployment_qualifications'::regclass
       and c.conname =
         'oauth_rollout_qualification_provider_check'
  )
  and pg_catalog.pg_get_functiondef(
    'public.assert_oauth_rollout_deployment_qualification(text)'::regprocedure
  ) ~ '1505 seconds'
  and pg_catalog.pg_get_functiondef(
    'public.assert_oauth_rollout_deployment_qualification(text)'::regprocedure
  ) ~ 'provider_function_timeout_seconds = 300',
  'intrinsic guards require 1505-second drain and exact 300-second provider timeout'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_rollout_deployment_qualifications
     where contract_version =
       '0094_oauth_flow_migration_contract'
  ),
  (
    select case when is_contract then 1 else 0 end
      from oauth_test_rollout_stage
  ),
  'qualification evidence count exactly identifies expand versus contract stage'
);

select is(
  pg_temp.oauth_test_qualification_assertion_outcome(),
  (
    select case
      when is_contract then 'accepted'
      else 'required'
    end
      from oauth_test_rollout_stage
  ),
  'intrinsic contract assertion rejects expand and accepts qualified contract'
);

with timing as materialized (
  select pg_catalog.clock_timestamp() as qualified_at
)
insert into public.oauth_rollout_deployment_qualifications (
  contract_version,
  expand_version,
  expand_migration_hash,
  expand_manifest_hash,
  expand_app_commit,
  deployment_app_commit,
  deployment_source_tree,
  provider,
  provider_team_id,
  provider_project_id,
  provider_deployment_id,
  provider_deployment_url,
  production_alias,
  alias_uid,
  provider_function_timeout_seconds,
  deployment_created_at,
  provider_ready_at,
  alias_current_since,
  evidence_sha256,
  qualified_at
)
select
  '0094_oauth_flow_migration_contract',
  '0093_oauth_flow_intents',
  pg_catalog.repeat('1', 64),
  pg_catalog.repeat('2', 64),
  pg_catalog.repeat('3', 40),
  pg_catalog.repeat('4', 40),
  pg_catalog.repeat('5', 40),
  'vercel',
  'team_NmYBq4k4t5BbaQKQNAHRgu8a',
  'prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU',
  'dpl_1234567890abcdef',
  'boss-paegi-qa-123.vercel.app',
  'boss-paegi.vercel.app',
  pg_catalog.repeat('6', 64),
  300,
  qualified_at - interval '1800 seconds',
  qualified_at - interval '1700 seconds',
  qualified_at - interval '1510 seconds',
  pg_catalog.repeat('7', 64),
  qualified_at
from timing
where not (
  select is_contract
    from oauth_test_rollout_stage
);

select lives_ok(
  $$
    select public.assert_oauth_rollout_deployment_qualification(
      '0094_oauth_flow_migration_contract'
    )
  $$,
  'intrinsic contract assertion accepts the exact fully drained provider receipt'
);

select throws_ok(
  $$
    update public.oauth_rollout_deployment_qualifications
       set evidence_sha256 = pg_catalog.repeat('8', 64)
  $$,
  'P0001',
  'oauth_rollout_deployment_qualification_append_only',
  'qualification evidence rejects every UPDATE'
);

select throws_ok(
  $$
    delete from public.oauth_rollout_deployment_qualifications
  $$,
  'P0001',
  'oauth_rollout_deployment_qualification_append_only',
  'qualification evidence rejects every DELETE'
);

select is(
  (
    select evidence_sha256
      from public.oauth_rollout_deployment_qualifications
     where contract_version =
       '0094_oauth_flow_migration_contract'
  ),
  (
    select case
      when is_contract
        then qualification_evidence_sha256
      else pg_catalog.repeat('7', 64)
    end
      from oauth_test_rollout_stage
  ),
  'failed UPDATE and DELETE attempts preserve the original append-only evidence'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_index i
     where i.indrelid = 'public.oauth_flow_intents'::regclass
       and i.indisunique
       and pg_catalog.pg_get_indexdef(i.indexrelid)
         like '%(source_session_id)%'
       and pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
         'session_fenced'
  ),
  1,
  'one partial unique index fences each recoverable source session'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_index i
     where i.indrelid = 'public.oauth_flow_intents'::regclass
       and i.indexrelid =
         'public.oauth_flow_intents_fenced_target_session_idx'::regclass
       and pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
         '(session_fenced AND (target_session_id IS NOT NULL))'
  ),
  1,
  'fenced target-session lookup has an exact partial recovery index'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_index i
     where i.indrelid = 'public.oauth_flow_intents'::regclass
       and i.indexrelid =
         'public.oauth_flow_intents_revoked_target_session_idx'::regclass
       and pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
         '((target_session_id IS NOT NULL) AND (revoke_confirmed_at IS NOT NULL))'
  ),
  1,
  'revoked target-session tombstones have an exact partial lookup index'
);

select has_trigger(
  'auth',
  'sessions',
  'trg_auth_sessions_fence_revoked_oauth_target_id',
  'Auth session creation is fenced by revoked OAuth target tombstones'
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
       'public.fence_revoked_oauth_target_session_id()'::regprocedure
  ),
  'Auth tombstone trigger is an empty-search-path definer with no callable API surface'
);

select ok(
  (
    select pg_catalog.bool_and(
      pg_catalog.strpos(definition, state_name) > 0
    )
      from (
        select pg_catalog.lower(
                 pg_catalog.pg_get_constraintdef(oid)
               ) as definition
          from pg_catalog.pg_constraint
         where conrelid = 'public.oauth_flow_intents'::regclass
           and conname = 'oauth_flow_intents_state_check'
      ) constraint_definition
      cross join pg_catalog.unnest(array[
        'pending',
        'claimed',
        'signout_required',
        'signout_revoked',
        'completed',
        'failed',
        'cancelled',
        'abandoned',
        'expired'
      ]) state_name
  ),
  'the state domain contains every and only recoverable/terminal phase'
);

create temporary table oauth_test_functions (
  function_oid oid primary key
) on commit drop;

insert into oauth_test_functions(function_oid)
select function_oid::oid
  from pg_catalog.unnest(array[
    'public.begin_oauth_flow_intent(uuid,uuid,uuid,boolean,text,text,text,text)'::regprocedure,
    'public.claim_oauth_flow_intent(uuid,uuid,uuid,text,text,text)'::regprocedure,
    'public.bind_oauth_flow_intent_target(uuid,uuid,uuid,text,uuid,uuid,text,text)'::regprocedure,
    'public.read_oauth_flow_intent_status(uuid,uuid,uuid,text)'::regprocedure,
    'public.recover_oauth_flow_intent_authority(uuid,uuid,uuid)'::regprocedure,
    'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'::regprocedure,
    'public.verify_oauth_flow_source_session_evidence(uuid,uuid,uuid,text,text)'::regprocedure,
    'public.verify_oauth_flow_target_session_evidence(uuid,uuid,uuid,text,text)'::regprocedure,
    'public.read_oauth_flow_target_session_evidence(uuid,uuid,uuid)'::regprocedure,
    'public.rotate_oauth_flow_target_session_evidence(uuid,uuid,uuid,text,text,text,text)'::regprocedure,
    'public.release_oauth_flow_intent(uuid,uuid,uuid,text,text)'::regprocedure,
    'public.finalize_oauth_flow_intent(uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)'::regprocedure,
    'public.confirm_oauth_flow_signout_revoke(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure,
    'public.complete_oauth_flow_signout(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure,
    'public.complete_recovered_oauth_flow_signout(uuid)'::regprocedure,
    'public.cancel_oauth_flow_intent(uuid,uuid,uuid,text)'::regprocedure,
    'public.revoke_bound_oauth_flow_target_session(uuid,uuid,uuid,text)'::regprocedure,
    'public.abandon_oauth_flow_intent(uuid,uuid,uuid,text)'::regprocedure,
    'public.expire_oauth_flow_intent(uuid)'::regprocedure,
    'public.consume_oauth_flow_intent_migration(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
    'public.complete_oauth_flow_intent_migration_without_transfer(uuid,uuid,uuid,uuid,text)'::regprocedure,
    'public.claim_oauth_anon_auth_cleanup(uuid,integer)'::regprocedure,
    'public.verify_oauth_anon_auth_cleanup_source(uuid,uuid,integer)'::regprocedure,
    'public.finish_oauth_anon_auth_cleanup(uuid,uuid,integer,text,text)'::regprocedure,
    'public.prune_oauth_flow_intents(integer)'::regprocedure
  ]) function_oid;

select is(
  (select pg_catalog.count(*)::integer from oauth_test_functions),
  25,
  'all twenty-five exact OAuth ledger and Auth-cleanup RPC signatures exist'
);

select ok(
  pg_catalog.to_regprocedure(
    'public.claim_oauth_flow_intent(uuid,uuid,uuid,text)'
  ) is null,
  'proofless four-argument claim RPC is not an executable surface'
);

select ok(
  (
    select pg_catalog.bool_and(p.prosecdef)
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
  ),
  'every OAuth ledger RPC is SECURITY DEFINER'
);

select ok(
  (
    select pg_catalog.bool_and(
      coalesce(p.proconfig, '{}'::text[])
        @> array['search_path=""']
    )
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
  ),
  'every OAuth ledger RPC pins an empty search_path'
);

select ok(
  (
    select pg_catalog.bool_and(
      has_function_privilege(
        'service_role',
        p.oid,
        'EXECUTE'
      ) = (
        p.proname <>
          'complete_oauth_flow_intent_migration_without_transfer'
      )
    )
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
  ),
  'service_role can execute only the external OAuth ledger RPCs'
);

select ok(
  (
    select pg_catalog.bool_and(
      not has_function_privilege(
        'anon',
        p.oid,
        'EXECUTE'
      )
    )
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
  ),
  'anon cannot execute any OAuth ledger RPC'
);

select ok(
  (
    select pg_catalog.bool_and(
      not has_function_privilege(
        'authenticated',
        p.oid,
        'EXECUTE'
      )
    )
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
  ),
  'authenticated cannot execute any OAuth ledger RPC'
);

select ok(
  not exists (
    select 1
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          p.proacl,
          pg_catalog.acldefault('f'::"char", p.proowner)
        )
      ) acl
     where acl.grantee = 0
       and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute any OAuth ledger RPC'
);

select ok(
  (
    select pg_catalog.bool_and(
      case
        when role_name = 'service_role'
          then has_function_privilege(
            role_name,
            function_oid,
            'EXECUTE'
          ) = not (
            select is_contract
              from oauth_test_rollout_stage
          )
        else not has_function_privilege(
          role_name,
          function_oid,
          'EXECUTE'
        )
      end
    )
      from pg_catalog.unnest(array[
        'anon',
        'authenticated',
        'service_role'
      ]) role_name
      cross join pg_catalog.unnest(array[
        'public.reassign_anon_data(uuid,uuid)'::regprocedure,
        'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure
      ]) function_oid
  )
  and not exists (
    select 1
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          p.proacl,
          pg_catalog.acldefault('f'::"char", p.proowner)
        )
      ) acl
     where p.oid in (
       'public.reassign_anon_data(uuid,uuid)'::regprocedure,
       'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure
     )
       and acl.grantee = 0
       and acl.privilege_type = 'EXECUTE'
  )
  and (
    select case
      when is_contract then
        pg_catalog.obj_description(
          'public.reassign_anon_data(uuid,uuid)'::regprocedure,
          'pg_proc'
        ) =
          'Internal primitive; invoke only through flow-scoped OAuth migration consumption.'
        and pg_catalog.obj_description(
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure,
          'pg_proc'
        ) =
          'Expand-only pre-ledger cookie bridge; execution revoked after the full deployment drain.'
      else
        pg_catalog.obj_description(
          'public.reassign_anon_data(uuid,uuid)'::regprocedure,
          'pg_proc'
        ) is null
        and pg_catalog.obj_description(
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure,
          'pg_proc'
        ) is null
    end
      from oauth_test_rollout_stage
  ),
  'raw and legacy bridge ACLs/comments exactly match expand or contract stage'
);

select ok(
  (
    select pg_catalog.bool_and(
      case
        when p.proname =
          'consume_oauth_flow_intent_migration' then
          pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(p.oid),
            'bp_0093_consume_oauth_flow_intent_migration_impl'
          ) > 0
          and pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(
              'public.bp_0093_consume_oauth_flow_intent_migration_impl(uuid,uuid,uuid,uuid)'::regprocedure
            ),
            'oauth-flow:'
          ) > 0
          and pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(
              'public.bp_0093_consume_oauth_flow_intent_migration_impl(uuid,uuid,uuid,uuid)'::regprocedure
            ),
            'oauth-flow-source-session:'
          ) > 0
        when p.proname =
          'recover_active_oauth_flow_by_observed_session' then
          pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(p.oid),
            'recover_oauth_flow_intent_authority'
          ) > 0
          and pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(
              'public.recover_oauth_flow_intent_authority(uuid,uuid,uuid)'::regprocedure
            ),
            'oauth-flow:'
          ) > 0
          and pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(
              'public.recover_oauth_flow_intent_authority(uuid,uuid,uuid)'::regprocedure
            ),
            'oauth-flow-source-session:'
          ) > 0
        else
          pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(p.oid),
            'oauth-flow:'
          ) > 0
          and pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(p.oid),
            'oauth-flow-source-session:'
          ) > 0
      end
    )
      from pg_catalog.pg_proc p
      join oauth_test_functions f
        on f.function_oid = p.oid
     where p.proname not in (
       'claim_oauth_anon_auth_cleanup',
       'verify_oauth_anon_auth_cleanup_source',
       'finish_oauth_anon_auth_cleanup'
     )
  ),
  'all flow-ledger reads and mutations serialize exact flow and source session'
);

select ok(
  (
    select pg_catalog.bool_and(
      case
        when function_oid =
          'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'::regprocedure
          then
          pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(function_oid::oid),
            'recover_oauth_flow_intent_authority'
          ) > 0
          and pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(
              'public.recover_oauth_flow_intent_authority(uuid,uuid,uuid)'::regprocedure
            ),
            'oauth-flow-observed-session:'
          ) > 0
        else
          pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(function_oid::oid),
            'oauth-flow-observed-session:'
          ) > 0
      end
    )
      from pg_catalog.unnest(array[
        'public.begin_oauth_flow_intent(uuid,uuid,uuid,boolean,text,text,text,text)'::regprocedure,
        'public.claim_oauth_flow_intent(uuid,uuid,uuid,text,text,text)'::regprocedure,
        'public.bind_oauth_flow_intent_target(uuid,uuid,uuid,text,uuid,uuid,text,text)'::regprocedure,
        'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'::regprocedure,
        'public.finalize_oauth_flow_intent(uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)'::regprocedure,
        'public.complete_oauth_flow_signout(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure,
        'public.complete_recovered_oauth_flow_signout(uuid)'::regprocedure,
        'public.cancel_oauth_flow_intent(uuid,uuid,uuid,text)'::regprocedure,
        'public.revoke_bound_oauth_flow_target_session(uuid,uuid,uuid,text)'::regprocedure,
        'public.expire_oauth_flow_intent(uuid)'::regprocedure,
        'public.prune_oauth_flow_intents(integer)'::regprocedure
      ]) function_oid
  ),
  'every direct association writer shares the observed-session recovery lock'
);

select matches(
  pg_catalog.pg_get_functiondef(
    'public.abandon_oauth_flow_intent(uuid,uuid,uuid,text)'::regprocedure
  ),
  'revoke_bound_oauth_flow_target_session',
  'legacy bound abandon delegates to the observed-lock cleanup writer'
);

select matches(
  pg_catalog.pg_get_functiondef(
    'public.prune_oauth_flow_intents(integer)'::regprocedure
  ),
  'pg_try_advisory_xact_lock',
  'maintenance skips a contended candidate instead of blocking its batch'
);

insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values (
  '93100000-0000-4000-8000-000000000199',
  'oauth-null-generation@test.local',
  true,
  null,
  pg_catalog.clock_timestamp()
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000199',
    '93100000-0000-4000-8000-000000000199',
    '93200000-0000-4000-8000-000000000199',
    true,
    'google',
    '/',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_source_authority_unverified"}'::jsonb,
  'anonymous begin rejects a missing Auth generation timestamp without raising'
);

-- Anonymous source, completed/continue, and migration consumption.
insert into oauth_test_results(name, value)
values (
  'begin_continue',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    true,
    'google',
    '/credits?from=oauth',
    repeat('1', 64),
    repeat('2', 64)
  )
);

select is(
  (
    select value - 'expiresAt'
      from oauth_test_results
     where name = 'begin_continue'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001'
  ),
  'begin returns the exact flow-bound receipt'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from oauth_test_results r
      cross join lateral
        pg_catalog.jsonb_object_keys(r.value)
     where r.name = 'begin_continue'
  ),
  3,
  'begin success contains exactly three keys'
);

select ok(
  (
    select expires_at =
           created_at + interval '10 minutes'
       and state = 'pending'
       and active
       and requested_next = '/credits?from=oauth'
       and source_access_token_sha256 = repeat('1', 64)
       and source_refresh_token_sha256 = repeat('2', 64)
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000001'
  ),
  'begin persists an exact ten-minute pending lease and requested destination'
);

insert into oauth_test_results(name, value)
values (
  'begin_continue_replay',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    true,
    'google',
    '/credits?from=oauth',
    repeat('1', 64),
    repeat('2', 64)
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'begin_continue_replay'
  ),
  (
    select value
      from oauth_test_results
     where name = 'begin_continue'
  ),
  'exact begin replay returns the original expiration receipt'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    true,
    'google',
    '/credits?from=oauth',
    repeat('3', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_conflict"}'::jsonb,
  'begin replay cannot substitute source access-token evidence'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    true,
    'google',
    '/credits?from=oauth',
    repeat('1', 64),
    repeat('3', 64)
  ),
  '{"ok":false,"error":"oauth_flow_conflict"}'::jsonb,
  'begin replay cannot substitute source refresh-token evidence'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'google',
    '/',
    null,
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'begin rejects a missing half of source-session evidence'
);

insert into oauth_test_results(name, value)
values (
  'verify_source_pending',
  public.verify_oauth_flow_source_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    repeat('1', 64),
    repeat('2', 64)
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'verify_source_pending'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001',
    'state', 'pending',
    'matched', true
  ),
  'exact source evidence verifies with a digest-free four-key receipt'
);

select is(
  public.verify_oauth_flow_source_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    repeat('1', 64),
    repeat('2', 64)
  ),
  (
    select value
      from oauth_test_results
     where name = 'verify_source_pending'
  ),
  'source evidence verification replay is exactly idempotent'
);

select ok(
  (
    select pg_catalog.bool_and(
      value =
        '{"ok":false,"error":"oauth_flow_source_session_evidence_mismatch"}'::jsonb
    )
      from (
        values
          (
            public.verify_oauth_flow_source_session_evidence(
              '93000000-0000-4000-8000-000000000001',
              '93100000-0000-4000-8000-000000000001',
              '93200000-0000-4000-8000-000000000001',
              repeat('3', 64),
              repeat('2', 64)
            )
          ),
          (
            public.verify_oauth_flow_source_session_evidence(
              '93000000-0000-4000-8000-000000000001',
              '93100000-0000-4000-8000-000000000001',
              '93200000-0000-4000-8000-000000000001',
              repeat('1', 64),
              repeat('3', 64)
            )
          ),
          (
            public.verify_oauth_flow_source_session_evidence(
              '93000000-0000-4000-8000-000000000001',
              '93100000-0000-4000-8000-000000000001',
              '93200000-0000-4000-8000-000000000001',
              repeat('3', 64),
              repeat('4', 64)
            )
          )
      ) mismatches(value)
  ),
  'wrong and one-token-mixed source evidence fail as an indivisible pair'
);

select is(
  public.verify_oauth_flow_source_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    repeat('1', 64),
    null
  ),
  '{"ok":false,"error":"invalid_oauth_flow_source_session_evidence"}'::jsonb,
  'source evidence verification rejects a missing proof half'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    true,
    'google',
    '/different',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_conflict"}'::jsonb,
  'begin replay cannot change requested_next'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'google',
    '/credits?from=oauth',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_conflict"}'::jsonb,
  'a flow ID cannot be rebound to another source identity'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000002',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    true,
    'google',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_source_authority_unverified"}'::jsonb,
  'one retained anonymous source cannot begin a second flow'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    null,
    '/',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'NULL provider is rejected explicitly'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'github',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'unknown provider is rejected'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'google',
    'https://evil.test/',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'absolute requested destination is rejected'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'google',
    '//evil.test/',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'protocol-relative requested destination is rejected'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'google',
    E'/bad\\path',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'backslash requested destination is rejected'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000099',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000099',
    true,
    'google',
    E'/bad\npath',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'control-character requested destination is rejected'
);

insert into oauth_test_results(name, value)
values (
  'status_pending',
  public.read_oauth_flow_intent_status(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google'
  )
);

select is(
  (
    select pg_catalog.count(*)::integer
      from oauth_test_results r
      cross join lateral
        pg_catalog.jsonb_object_keys(r.value)
     where r.name = 'status_pending'
  ),
  19,
  'status success has the exact nineteen-key recovery schema'
);

select ok(
  (
    select value->>'state' = 'pending'
       and (value->>'active')::boolean
       and value->>'provider' = 'google'
       and (value->>'sourceIsAnonymous')::boolean
       and value->>'requestedNext' = '/credits?from=oauth'
       and value->'outcome' = 'null'::jsonb
       and value->'targetUserId' = 'null'::jsonb
       and value->'claimedAt' = 'null'::jsonb
      from oauth_test_results
     where name = 'status_pending'
  ),
  'pending status returns exact source, destination, and null receipt fields'
);

select is(
  public.read_oauth_flow_intent_status(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'kakao'
  ),
  '{"ok":false,"error":"oauth_flow_not_found"}'::jsonb,
  'status requires exact flow, source session, and provider authority'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    null,
    repeat('2', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow"}'::jsonb,
  'claim rejects absent source access-token evidence'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    repeat('3', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'claim rejects forged source access-token evidence'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    repeat('1', 64),
    repeat('3', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'claim rejects a mixed source evidence pair'
);

insert into oauth_test_results(name, value)
values (
  'claim_continue',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'claim_continue'
  ),
  '{"ok":true,"flowId":"93000000-0000-4000-8000-000000000001"}'::jsonb,
  'a pending flow is claimed exactly once'
);

select ok(
  (
    select state = 'claimed'
       and active
       and claimed_at is not null
       and finished_at is null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000001'
  ),
  'claim persists the active claimed state and timestamp'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  ),
  (
    select value
      from oauth_test_results
     where name = 'claim_continue'
  ),
  'exact claim replay is idempotent'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000001',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'claim rejects a mismatched source user'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_access_token_sha256,
  source_refresh_token_sha256,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at,
  claimed_at
)
select
  '93000000-0000-4000-8000-000000000197',
  '93100000-0000-4000-8000-000000000197',
  '93200000-0000-4000-8000-000000000197',
  repeat('1', 64),
  repeat('2', 64),
  false,
  'google',
  '/',
  'claimed',
  stamp.now_at - interval '20 minutes',
  stamp.now_at - interval '10 minutes',
  stamp.now_at - interval '19 minutes'
from stamp;

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000197',
    '93100000-0000-4000-8000-000000000197',
    '93200000-0000-4000-8000-000000000197',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'an unbound claimed flow expires at its exact initial deadline'
);

select is(
  public.expire_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000197'
  ),
  '{"ok":true,"flowId":"93000000-0000-4000-8000-000000000197","outcome":"expired"}'::jsonb,
  'an expired unbound claim replays its terminal expiry receipt'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_target_not_bound"}'::jsonb,
  'completed finalize cannot be the first writer of target authority'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_target_not_bound"}'::jsonb,
  'unbound completed finalize rejects every proposed target identity'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93100000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000099',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_target_not_bound"}'::jsonb,
  'unbound completed finalize cannot authorize anonymous migration-to-self'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/changed',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_finalize_conflict"}'::jsonb,
  'finalize cannot change flow-bound requested_next'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_source_session_unchanged"}'::jsonb,
  'target binding forbids source/target session-ID reuse'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93100000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000099',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_anonymous_user_unchanged"}'::jsonb,
  'anonymous source cannot bind migration-to-self under a new session'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000098',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_authority_unverified"}'::jsonb,
  'target binding rejects a nonexistent Auth session'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_authority_unverified"}'::jsonb,
  'target binding rejects an Auth session owned by a different user'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('A', 42) || '_',
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow_target_binding"}'::jsonb,
  'target binding rejects malformed server-computed token evidence'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000003',
    '93100000-0000-4000-8000-000000000003',
    '93200000-0000-4000-8000-000000000003',
    false,
    'google',
    '/association-guard',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'association uniqueness guard flow begins'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000003',
    '93100000-0000-4000-8000-000000000003',
    '93200000-0000-4000-8000-000000000003',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'association uniqueness guard flow is claimed'
);

select pg_temp.oauth_test_install_auth_authority(
  '93300000-0000-4000-8000-000000000003',
  '93400000-0000-4000-8000-000000000003'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000003',
    '93100000-0000-4000-8000-000000000003',
    '93200000-0000-4000-8000-000000000003',
    'google',
    '93300000-0000-4000-8000-000000000003',
    '93400000-0000-4000-8000-000000000003',
    repeat('a', 64),
    repeat('b', 64)
  )->>'ok',
  'true',
  'association uniqueness guard binds one active target session'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000004',
    '93200000-0000-4000-8000-000000000003',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_session_already_active"}'::jsonb,
  'target binding rejects a session active as another flow source'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000003',
    '93400000-0000-4000-8000-000000000003',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_session_already_active"}'::jsonb,
  'target binding rejects a session active as another flow target'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000004',
    '93300000-0000-4000-8000-000000000003',
    '93400000-0000-4000-8000-000000000003',
    false,
    'kakao',
    '/association-guard',
    repeat('3', 64),
    repeat('4', 64)
  ),
  '{"ok":false,"error":"oauth_flow_already_active"}'::jsonb,
  'begin rejects a source session active as another flow target'
);

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000003',
    '93100000-0000-4000-8000-000000000003',
    '93200000-0000-4000-8000-000000000003',
    'google'
  )->>'outcome',
  'abandoned',
  'terminal transition releases both active observed-session associations'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000004',
    '93300000-0000-4000-8000-000000000003',
    '93400000-0000-4000-8000-000000000003',
    false,
    'kakao',
    '/association-guard',
    repeat('3', 64),
    repeat('4', 64)
  ),
  '{"ok":false,"error":"oauth_flow_already_active"}'::jsonb,
  'revoked target-session tombstone prevents a deleted session from beginning again'
);

with begun as materialized (
  select public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000004',
    '93300000-0000-4000-8000-000000000003',
    '93400000-0000-4000-8000-000000000004',
    false,
    'kakao',
    '/association-guard',
    repeat('3', 64),
    repeat('4', 64)
  ) as value
)
select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000004',
    '93300000-0000-4000-8000-000000000003',
    '93400000-0000-4000-8000-000000000004',
    'kakao'
  )->>'outcome',
  'cancelled',
  'a different live session can begin and release its own association'
)
from begun
where begun.value->>'ok' = 'true';

select is(
  (
    select pg_catalog.count(*)::integer
      from auth.refresh_tokens
     where session_id =
       '93400000-0000-4000-8000-000000000001'
  ),
  0,
  'refresh-rotation-v2 Auth session is valid without a legacy refresh-token row'
);

insert into oauth_test_results(name, value)
values (
  'bind_continue',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'bind_continue'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001',
    'targetUserId', '93300000-0000-4000-8000-000000000001',
    'targetSessionId', '93400000-0000-4000-8000-000000000001'
  ),
  'target binding returns the exact four-key target authority ACK'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  ),
  (
    select value
      from oauth_test_results
     where name = 'bind_continue'
  ),
  'exact target binding replay returns the same ACK'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('e', 64),
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_binding_conflict"}'::jsonb,
  'a binding replay cannot substitute its access-token evidence'
);

select is(
  public.read_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001',
    'state', 'claimed',
    'targetUserId', '93300000-0000-4000-8000-000000000001',
    'targetSessionId', '93400000-0000-4000-8000-000000000001',
    'accessTokenSha256', pg_catalog.repeat('a', 64),
    'refreshTokenSha256', pg_catalog.repeat('b', 64),
    'releasedAt', null
  ),
  'service evidence read returns the exact eight-key bound pair'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001'
  )->>'state',
  'claimed',
  'prebound exact target recovers claimed authority after process loss'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000099'
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'unrelated coherent identity cannot recover a prebound claimed flow'
);

insert into oauth_test_results(name, value)
values (
  'rotate_claimed',
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'rotate_claimed'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001',
    'state', 'claimed',
    'targetUserId', '93300000-0000-4000-8000-000000000001',
    'targetSessionId', '93400000-0000-4000-8000-000000000001'
  ),
  'claimed evidence rotation atomically returns an exact five-key ACK'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  ),
  (
    select value
      from oauth_test_results
     where name = 'rotate_claimed'
  ),
  'response-loss replay of an exact old-to-new rotation converges'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('e', 64),
    pg_catalog.repeat('f', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_rotation_conflict"}'::jsonb,
  'a hybrid old digest pair cannot rotate either component'
);

select is(
  public.read_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001'
  )->>'accessTokenSha256',
  pg_catalog.repeat('c', 64),
  'evidence read observes the atomically rotated pair'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/consent',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_finalize_conflict"}'::jsonb,
  'finalize requires the exact latest prebound digest pair'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    null,
    null,
    null,
    null,
    null,
    '/',
    'continue'
  ),
  '{"ok":false,"error":"invalid_oauth_flow_finalize"}'::jsonb,
  'NULL finalize outcome is rejected explicitly'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    'https://evil.test/',
    'continue'
  ),
  '{"ok":false,"error":"invalid_oauth_flow_finalize"}'::jsonb,
  'finalize rejects an external destination'
);

insert into oauth_test_results(name, value)
values (
  'finalize_continue',
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64),
    '/consent',
    'continue'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'finalize_continue'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001',
    'outcome', 'completed',
    'targetUserId', '93300000-0000-4000-8000-000000000001',
    'targetSessionId', '93400000-0000-4000-8000-000000000001',
    'destination', '/consent',
    'action', 'continue'
  ),
  'continue finalize returns the exact durable decision receipt'
);

select ok(
  (
    select state = 'completed'
       and not active
       and action = 'continue'
       and finished_at is not null
       and revoke_confirmed_at is null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000001'
  ),
  'continue finalize reaches the terminal completed shape'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64),
    '/consent',
    'continue'
  ),
  (
    select value
      from oauth_test_results
     where name = 'finalize_continue'
  ),
  'exact terminal finalize replay returns the stored receipt'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'completed',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64),
    '/different',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_finalize_conflict"}'::jsonb,
  'terminal replay cannot alter destination'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google',
    '/credits?from=oauth',
    'failed',
    null,
    null,
    null,
    null,
    '/login?error=oauth',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_finalize_conflict"}'::jsonb,
  'terminal replay cannot alter outcome or target identity'
);

insert into oauth_test_results(name, value)
values (
  'status_completed',
  public.read_oauth_flow_intent_status(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google'
  )
);

select ok(
  (
    select value->>'state' = 'completed'
       and not (value->>'active')::boolean
       and value->>'outcome' = 'completed'
       and value->>'targetUserId' =
         '93300000-0000-4000-8000-000000000001'
       and value->>'targetSessionId' =
         '93400000-0000-4000-8000-000000000001'
       and value->>'destination' = '/consent'
       and value->>'action' = 'continue'
       and value->'finishedAt' <> 'null'::jsonb
      from oauth_test_results
     where name = 'status_completed'
  ),
  'terminal status is the authoritative completed decision receipt'
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 19
       and not (
         value ?| array[
           'accessTokenSha256',
           'refreshTokenSha256'
         ]
       )
       and value->'releasedAt' = 'null'::jsonb
      from oauth_test_results
     where name = 'status_completed'
  ),
  'normal status is exact nineteen keys and exposes release but no digest evidence'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000001',
    'state', 'completed',
    'matched', true,
    'releasedAt', null
  ),
  'exact target session evidence verifies with a five-key receipt'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('e', 64),
    pg_catalog.repeat('d', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_mismatch"}'::jsonb,
  'access digest mismatch rejects the entire evidence pair'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('e', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_mismatch"}'::jsonb,
  'refresh digest mismatch rejects the entire evidence pair'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_mismatch"}'::jsonb,
  'target identity mismatch cannot verify otherwise exact digests'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('A', 42) || '_',
    pg_catalog.repeat('d', 64)
  ),
  '{"ok":false,"error":"invalid_oauth_flow_session_evidence"}'::jsonb,
  'base64url evidence is invalid rather than silently mismatched'
);

select is(
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('e', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_releasable"}'::jsonb,
  'release requires the exact bound target digest pair'
);

insert into oauth_test_results(name, value)
values (
  'release_continue',
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  )
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 4
       and value->>'ok' = 'true'
       and value->>'flowId' =
         '93000000-0000-4000-8000-000000000001'
       and value->>'state' = 'completed'
       and value->'releasedAt' <> 'null'::jsonb
      from oauth_test_results
     where name = 'release_continue'
  ),
  'release stores and returns the exact four-key durable boundary receipt'
);

select is(
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  ),
  (
    select value
      from oauth_test_results
     where name = 'release_continue'
  ),
  'release response-loss replay returns the identical stored timestamp'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  )->>'releasedAt',
  (
    select value->>'releasedAt'
      from oauth_test_results
     where name = 'release_continue'
  ),
  'verify evidence exposes the same durable release boundary'
);

select is(
  public.read_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001'
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_not_readable"}'::jsonb,
  'raw stored digests are not readable after browser release'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64),
    pg_catalog.repeat('e', 64),
    pg_catalog.repeat('f', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_not_rotatable"}'::jsonb,
  'target evidence becomes immutable at the durable release boundary'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'atomic migration consumption requires exact target CAS'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000099',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'atomic migration consumption requires exact anonymous source user'
);

insert into oauth_test_results(name, value)
values (
  'consume_migration',
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    repeat('a', 64),
    repeat('b', 64)
  )
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 5
       and value->>'ok' = 'true'
       and value->>'flowId' =
         '93000000-0000-4000-8000-000000000001'
       and value->>'alreadyConsumed' = 'false'
       and value->'migrationConsumedAt' <> 'null'::jsonb
       and value->'migrationResult'->>'ok' = 'true'
      from oauth_test_results
     where name = 'consume_migration'
  ),
  'atomic migration returns an exact five-key reassignment receipt'
);

select ok(
  (
    select migration_consumed_at >= finished_at
       and migration_result->>'ok' = 'true'
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000001'
  ),
  'reassignment result and consumption timestamp commit in the ledger together'
);

select is(
  (
    select migration_result
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000001'
  ),
  (
    select result
      from public.anon_data_reassignments
     where source_user_id =
       '93100000-0000-4000-8000-000000000001'
       and target_user_id =
         '93300000-0000-4000-8000-000000000001'
  ),
  'flow receipt exactly equals the source-keyed reassignment ledger result'
);

select throws_ok(
  $$
    update public.anon_data_reassignments
       set result =
         '{"ok":true,"scores":9,"badges":9,"telemetry":9}'::jsonb
     where source_user_id =
       '93100000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'anon_data_reassignment_append_only',
  'permanent reassignment receipt rejects UPDATE'
);

select throws_ok(
  $$
    delete from public.anon_data_reassignments
     where source_user_id =
       '93100000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'anon_data_reassignment_append_only',
  'permanent reassignment receipt rejects DELETE'
);

select is(
  (
    select result
      from public.anon_data_reassignments
     where source_user_id =
       '93100000-0000-4000-8000-000000000001'
  ),
  (
    select value->'migrationResult'
      from oauth_test_results
     where name = 'consume_migration'
  ),
  'failed reassignment receipt mutations preserve the exact committed result'
);

select ok(
  (
    select replay.value->>'ok' = 'true'
       and replay.value->>'alreadyConsumed' = 'true'
      and replay.value->>'migrationConsumedAt' =
         original.value->>'migrationConsumedAt'
       and replay.value->'migrationResult' =
         original.value->'migrationResult'
      from (
        select public.consume_oauth_flow_intent_migration(
          '93000000-0000-4000-8000-000000000001',
          '93300000-0000-4000-8000-000000000001',
          '93400000-0000-4000-8000-000000000001',
          '93100000-0000-4000-8000-000000000001',
          repeat('a', 64),
          repeat('b', 64)
        ) as value
      ) replay
      cross join (
        select value
          from oauth_test_results
         where name = 'consume_migration'
      ) original
  ),
  'atomic migration replay preserves both result and first consumption time'
);

-- A target that loses its exact bound session before consent can no longer
-- authorize transfer. Maintenance proves that permanent loss, writes an
-- exact no-transfer receipt, and protects the anonymous source without any
-- browser retry.
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93100000-0000-4000-8000-000000000181',
    'oauth-target-loss-source@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000181',
    'oauth-target-loss-target@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values
  (
    '93200000-0000-4000-8000-000000000181',
    '93100000-0000-4000-8000-000000000181',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000181',
    '93300000-0000-4000-8000-000000000181',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into oauth_test_results(name, value)
values
  (
    'target_loss_begin',
    public.begin_oauth_flow_intent(
      '93000000-0000-4000-8000-000000000181',
      '93100000-0000-4000-8000-000000000181',
      '93200000-0000-4000-8000-000000000181',
      true,
      'google',
      '/consent',
      repeat('1', 64),
      repeat('2', 64)
    )
  ),
  (
    'target_loss_claim',
    public.claim_oauth_flow_intent(
      '93000000-0000-4000-8000-000000000181',
      '93100000-0000-4000-8000-000000000181',
      '93200000-0000-4000-8000-000000000181',
      'google',
      repeat('1', 64),
      repeat('2', 64)
    )
  ),
  (
    'target_loss_bind',
    public.bind_oauth_flow_intent_target(
      '93000000-0000-4000-8000-000000000181',
      '93100000-0000-4000-8000-000000000181',
      '93200000-0000-4000-8000-000000000181',
      'google',
      '93300000-0000-4000-8000-000000000181',
      '93400000-0000-4000-8000-000000000181',
      repeat('a', 64),
      repeat('b', 64)
    )
  ),
  (
    'target_loss_finalize',
    public.finalize_oauth_flow_intent(
      '93000000-0000-4000-8000-000000000181',
      '93100000-0000-4000-8000-000000000181',
      '93200000-0000-4000-8000-000000000181',
      'google',
      '/consent',
      'completed',
      '93300000-0000-4000-8000-000000000181',
      '93400000-0000-4000-8000-000000000181',
      repeat('a', 64),
      repeat('b', 64),
      '/consent',
      'continue'
    )
  ),
  (
    'target_loss_release',
    public.release_oauth_flow_intent(
      '93000000-0000-4000-8000-000000000181',
      '93300000-0000-4000-8000-000000000181',
      '93400000-0000-4000-8000-000000000181',
      repeat('a', 64),
      repeat('b', 64)
    )
  );

select ok(
  (
    select pg_catalog.bool_and(value->>'ok' = 'true')
      from oauth_test_results
     where name like 'target_loss_%'
  ),
  'target-loss fixture reaches a normally released anonymous continue'
);

insert into public.user_badges(owner_id, badge_id)
values (
  '93100000-0000-4000-8000-000000000181',
  'qa-target-loss'
);

delete from auth.sessions
 where id = '93400000-0000-4000-8000-000000000181';

select ok(
  to_regprocedure(
    'public.rebind_released_oauth_flow_target_session(uuid,uuid,uuid,text,text)'
  ) is null,
  'released flow authority has no proof-only public rebind surface'
);

with timing as materialized (
  select pg_catalog.clock_timestamp() - interval '26 hours'
    as created_at
)
update public.oauth_flow_intents
   set created_at = timing.created_at,
       expires_at = timing.created_at + interval '10 minutes',
       claimed_at = timing.created_at + interval '1 minute',
       finished_at = timing.created_at + interval '2 minutes',
       released_at = timing.created_at + interval '3 minutes'
  from timing
 where flow_id =
   '93000000-0000-4000-8000-000000000181';

insert into oauth_test_results(name, value)
values (
  'target_loss_prune',
  public.prune_oauth_flow_intents(100)
);

select ok(
  (
    select value->>'targetAuthorityLossConverged' = '0'
       and value->>'targetAuthorityLossBacklog' = '0'
      from oauth_test_results
     where name = 'target_loss_prune'
  ),
  'maintenance quarantines the missing target session without a hidden due backlog'
);

select ok(
  (
    select flow.migration_result is null
       and flow.migration_consumed_at is null
       and cleanup.status = 'quarantined'
       and cleanup.quarantine_reason = 'target_session_missing'
       and cleanup.access_revoked_at is not null
       and cleanup.recover_until >
         cleanup.quarantined_at
       and cleanup.last_error is null
       and profile.deleted_at is not null
       and profile.display_name = '탈퇴한 사용자'
       and profile.avatar_url is null
       and exists (
         select 1
           from public.user_badges as badge
          where badge.owner_id = flow.source_user_id
       )
       and not exists (
         select 1
           from auth.sessions as source_session
          where source_session.user_id = flow.source_user_id
       )
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        on cleanup.flow_id = flow.flow_id
       and cleanup.source_user_id = flow.source_user_id
      join public.profiles as profile
        on profile.id = flow.source_user_id
     where flow.flow_id =
       '93000000-0000-4000-8000-000000000181'
  ),
  'target-session loss reversibly hides source identity and revokes access without terminalizing data'
);

insert into auth.sessions(id, user_id, created_at, updated_at)
values (
  '93400000-0000-4000-8000-000000000183',
  '93300000-0000-4000-8000-000000000181',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

insert into oauth_test_results(name, value)
values (
  'target_loss_recovery',
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000181',
    '93300000-0000-4000-8000-000000000181',
    '93400000-0000-4000-8000-000000000183'
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'targetSessionId' =
         '93400000-0000-4000-8000-000000000183'
       and value->'migrationConsumedAt' = 'null'::jsonb
      from oauth_test_results
     where name = 'target_loss_recovery'
  ),
  'a live current session of the same target principal recovers unconsumed authority before the deadline'
);

insert into oauth_test_results(name, value)
values (
  'target_loss_consume',
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000181',
    '93300000-0000-4000-8000-000000000181',
    '93400000-0000-4000-8000-000000000183',
    '93100000-0000-4000-8000-000000000181',
    repeat('c', 64),
    repeat('d', 64)
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'alreadyConsumed' = 'false'
       and value->'migrationResult'->>'badges' = '1'
       and cleanup.status = 'pending'
       and cleanup.consumed_target_session_id =
         '93400000-0000-4000-8000-000000000183'
       and cleanup.consumed_access_token_sha256 =
         repeat('c', 64)
       and cleanup.consumed_refresh_token_sha256 =
         repeat('d', 64)
      from oauth_test_results
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        on cleanup.flow_id =
          '93000000-0000-4000-8000-000000000181'
     where name = 'target_loss_consume'
  ),
  'current target authority consumes quarantined data and binds exact token generations'
);

select ok(
  to_regprocedure(
    'public.authorize_oauth_flow_migration(uuid,uuid,uuid,uuid)'
  ) is null
  and to_regprocedure(
    'public.complete_oauth_flow_migration(uuid,uuid,uuid,uuid)'
  ) is null,
  'split authorize/complete migration RPCs are not executable surfaces'
);

-- Failed callback decision.
select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    '93200000-0000-4000-8000-000000000010',
    false,
    'kakao',
    '/account',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'independent source session begins a failed-decision scenario'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    '93200000-0000-4000-8000-000000000010',
    'kakao',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":true,"flowId":"93000000-0000-4000-8000-000000000010"}'::jsonb,
  'failed-decision scenario is durably claimed first'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    '93200000-0000-4000-8000-000000000010',
    'kakao',
    '/account',
    'failed',
    '93300000-0000-4000-8000-000000000010',
    '93400000-0000-4000-8000-000000000010',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/login?error=oauth',
    'continue'
  ),
  '{"ok":false,"error":"invalid_oauth_flow_finalize"}'::jsonb,
  'failed decision cannot retain a target auth identity'
);

insert into oauth_test_results(name, value)
values (
  'finalize_failed',
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    '93200000-0000-4000-8000-000000000010',
    'kakao',
    '/account',
    'failed',
    null,
    null,
    null,
    null,
    '/login?error=oauth',
    'continue'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'finalize_failed'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000010',
    'outcome', 'failed',
    'targetUserId', null,
    'targetSessionId', null,
    'destination', '/login?error=oauth',
    'action', 'continue'
  ),
  'failed finalize records an exact target-free terminal receipt'
);

select ok(
  (
    select state = 'failed'
       and not active
       and target_user_id is null
       and target_session_id is null
       and destination = '/login?error=oauth'
       and action = 'continue'
       and finished_at is not null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000010'
  ),
  'failed state has the strict target-free terminal shape'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    '93200000-0000-4000-8000-000000000010',
    'kakao',
    '/account',
    'failed',
    null,
    null,
    null,
    null,
    '/login?error=oauth',
    'continue'
  ),
  (
    select value
      from oauth_test_results
     where name = 'finalize_failed'
  ),
  'failed finalize exact replay is idempotent'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    '93200000-0000-4000-8000-000000000010',
    'kakao',
    '/account',
    'failed',
    null,
    null,
    null,
    null,
    '/different',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_finalize_conflict"}'::jsonb,
  'failed replay cannot change its destination'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000010',
    '93300000-0000-4000-8000-000000000010',
    '93400000-0000-4000-8000-000000000010',
    '93100000-0000-4000-8000-000000000010',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'failed receipts never consume anonymous migration'
);

select ok(
  (
    select status->>'state' = 'failed'
       and status->>'outcome' = 'failed'
       and status->'targetUserId' = 'null'::jsonb
       and status->>'destination' = '/login?error=oauth'
      from (
        select public.read_oauth_flow_intent_status(
          '93000000-0000-4000-8000-000000000010',
          '93100000-0000-4000-8000-000000000010',
          '93200000-0000-4000-8000-000000000010',
          'kakao'
        ) as status
      ) result
  ),
  'status replays the exact failed receipt without recomputation'
);

select pg_temp.oauth_test_install_auth_authority(
  '93100000-0000-4000-8000-000000000012',
  '93200000-0000-4000-8000-000000000012'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000012',
    '93100000-0000-4000-8000-000000000012',
    '93200000-0000-4000-8000-000000000012',
    false,
    'google',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'non-anonymous same-user session-rotation scenario begins'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000012',
    '93100000-0000-4000-8000-000000000012',
    '93200000-0000-4000-8000-000000000012',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'non-anonymous same-user session-rotation scenario is claimed'
);

select pg_temp.oauth_test_install_auth_authority(
  '93100000-0000-4000-8000-000000000012',
  '93400000-0000-4000-8000-000000000012'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000012',
    '93100000-0000-4000-8000-000000000012',
    '93200000-0000-4000-8000-000000000012',
    'google',
    '93100000-0000-4000-8000-000000000012',
    '93400000-0000-4000-8000-000000000012',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  )->>'ok',
  'true',
  'non-anonymous source may bind the same user under a new session'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000012',
    '93100000-0000-4000-8000-000000000012',
    '93200000-0000-4000-8000-000000000012',
    'google',
    '/',
    'completed',
    '93100000-0000-4000-8000-000000000012',
    '93400000-0000-4000-8000-000000000012',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/',
    'continue'
  )->>'outcome',
  'completed',
  'non-anonymous same user with a genuinely new session remains valid'
);

-- Completed/signout requires durable remote revoke before local completion.
select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    false,
    'google',
    '/admin',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'independent source session begins a sign-out scenario'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'sign-out scenario is claimed before target exchange handling'
);

select pg_temp.oauth_test_install_auth_authority(
  '93300000-0000-4000-8000-000000000020',
  '93400000-0000-4000-8000-000000000020'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  )->>'ok',
  'true',
  'sign-out target evidence is prebound before finalization'
);

insert into oauth_test_results(name, value)
values (
  'finalize_signout',
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '/admin',
    'completed',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/login?error=account_deleted',
    'signout'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'finalize_signout'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000020',
    'outcome', 'completed',
    'targetUserId', '93300000-0000-4000-8000-000000000020',
    'targetSessionId', '93400000-0000-4000-8000-000000000020',
    'destination', '/login?error=account_deleted',
    'action', 'signout'
  ),
  'sign-out finalize returns the exact durable decision'
);

select ok(
  (
    select state = 'signout_required'
       and active
       and revoke_confirmed_at is null
       and finished_at is null
       and target_user_id =
         '93300000-0000-4000-8000-000000000020'
       and target_session_id =
         '93400000-0000-4000-8000-000000000020'
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000020'
  ),
  'signout_required remains an active recovery fence'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '/admin',
    'completed',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    '/login?error=account_deleted',
    'signout'
  ),
  (
    select value
      from oauth_test_results
     where name = 'finalize_signout'
  ),
  'signout_required finalize replay is exact and idempotent'
);

select is(
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000020',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_releasable"}'::jsonb,
  'sign-out decisions cannot cross the continue-session release boundary'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000020',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  )->>'state',
  'signout_required',
  'unreleased signout-required evidence may rotate before remote revoke'
);

select is(
  public.verify_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000020',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  )->>'matched',
  'true',
  'signout-required verification observes the entire rotated pair'
);

select is(
  public.complete_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  ),
  '{"ok":false,"error":"oauth_flow_signout_not_completable"}'::jsonb,
  'local sign-out completion is impossible before remote revoke receipt'
);

select is(
  public.confirm_oauth_flow_signout_revoke(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000020'
  ),
  '{"ok":false,"error":"oauth_flow_signout_revoke_conflict"}'::jsonb,
  'remote revoke confirmation requires exact target user/session CAS'
);

insert into oauth_test_results(name, value)
values (
  'confirm_revoke',
  public.confirm_oauth_flow_signout_revoke(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  )
);

select ok(
  (
    select value->>'ok' = 'true'
       and value->>'state' = 'signout_revoked'
       and value->>'targetUserId' =
         '93300000-0000-4000-8000-000000000020'
       and value->>'targetSessionId' =
         '93400000-0000-4000-8000-000000000020'
       and value->'revokeConfirmedAt' <> 'null'::jsonb
      from oauth_test_results
     where name = 'confirm_revoke'
  ),
  'remote revoke confirmation persists exact target and timestamp'
);

select ok(
  (
    select state = 'signout_revoked'
       and active
       and revoke_confirmed_at is not null
       and finished_at is null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000020'
  ),
  'signout_revoked remains active until browser-local absence is proven'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000020',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64),
    pg_catalog.repeat('e', 64),
    pg_catalog.repeat('f', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_not_rotatable"}'::jsonb,
  'remote revoke permanently closes target evidence rotation'
);

select is(
  public.read_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000020',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_not_readable"}'::jsonb,
  'remote revoke also closes raw digest recovery reads'
);

select is(
  public.confirm_oauth_flow_signout_revoke(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  ),
  (
    select value
      from oauth_test_results
     where name = 'confirm_revoke'
  ),
  'remote revoke confirmation replay preserves its first timestamp'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '/admin',
    'completed',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64),
    '/login?error=account_deleted',
    'signout'
  ),
  (
    select value
      from oauth_test_results
     where name = 'finalize_signout'
  ),
  'finalize replay after remote revoke still returns its original decision'
);

select is(
  public.complete_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000099'
  ),
  '{"ok":false,"error":"oauth_flow_signout_complete_conflict"}'::jsonb,
  'local sign-out completion also requires exact target CAS'
);

insert into oauth_test_results(name, value)
values (
  'complete_signout',
  public.complete_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'complete_signout'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000020',
    'destination', '/login?error=account_deleted'
  ),
  'local absence completes sign-out with the stored destination'
);

select ok(
  (
    select state = 'completed'
       and not active
       and action = 'signout'
       and revoke_confirmed_at is not null
       and finished_at >= revoke_confirmed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000020'
  ),
  'completed sign-out is terminal and ordered after remote revoke'
);

select is(
  public.complete_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  ),
  (
    select value
      from oauth_test_results
     where name = 'complete_signout'
  ),
  'completed sign-out exact replay is idempotent'
);

select is(
  public.confirm_oauth_flow_signout_revoke(
    '93000000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    '93200000-0000-4000-8000-000000000020',
    'google',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020'
  )->>'state',
  'completed',
  'revoke replay after completion reports the actual terminal state'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000020',
    '93300000-0000-4000-8000-000000000020',
    '93400000-0000-4000-8000-000000000020',
    '93100000-0000-4000-8000-000000000020',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'sign-out completion never consumes anonymous-data migration'
);

select ok(
  (
    select status->>'state' = 'completed'
       and status->>'outcome' = 'completed'
       and status->>'action' = 'signout'
       and status->'revokeConfirmedAt' <> 'null'::jsonb
       and status->'finishedAt' <> 'null'::jsonb
      from (
        select public.read_oauth_flow_intent_status(
          '93000000-0000-4000-8000-000000000020',
          '93100000-0000-4000-8000-000000000020',
          '93200000-0000-4000-8000-000000000020',
          'google'
        ) as status
      ) result
  ),
  'status returns the exact completed sign-out receipt'
);

-- Cancellation is restricted to unexpired pending flows.
select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000030',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    false,
    'kakao',
    '/play',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'cancellation scenario begins pending'
);

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000030',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_not_cancellable"}'::jsonb,
  'cancel requires exact provider authority'
);

insert into oauth_test_results(name, value)
values (
  'cancel_pending',
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000030',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    'kakao'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'cancel_pending'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000030',
    'outcome', 'cancelled'
  ),
  'pending cancellation returns an exact terminal receipt'
);

select ok(
  (
    select state = 'cancelled'
       and not active
       and claimed_at is null
       and target_user_id is null
       and destination is null
       and finished_at is not null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000030'
  ),
  'cancelled state has the strict unclaimed terminal shape'
);

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000030',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    'kakao'
  ),
  (
    select value
      from oauth_test_results
     where name = 'cancel_pending'
  ),
  'cancel exact replay is idempotent'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000030',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    'kakao',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'cancelled flow cannot subsequently be claimed'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000030',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    'kakao',
    '/play',
    'failed',
    null,
    null,
    null,
    null,
    '/login?error=cancelled',
    'continue'
  ),
  '{"ok":false,"error":"oauth_flow_not_finalizable"}'::jsonb,
  'cancelled flow cannot subsequently be finalized'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000031',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    false,
    'kakao',
    '/play',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'cancellation releases the unique active source-session fence'
);

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000031',
    '93100000-0000-4000-8000-000000000030',
    '93200000-0000-4000-8000-000000000030',
    'kakao'
  )->>'outcome',
  'cancelled',
  'replacement pending flow can be cancelled independently'
);

-- Unbound claimed is an explicit impossibility boundary: an Auth exchange may
-- have committed without returning the exact target session ID.
select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    true,
    'google',
    '/gallery',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'abandonment scenario begins pending'
);

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_not_abandonable"}'::jsonb,
  'pending flow cannot be abandoned before exchange claim'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'abandonment scenario first enters claimed'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_flow_intents
   set created_at = stamp.now_at - interval '30 minutes',
       expires_at = stamp.now_at - interval '20 minutes',
       claimed_at = stamp.now_at - interval '29 minutes'
  from stamp
 where flow_id = '93000000-0000-4000-8000-000000000050';

insert into oauth_test_results(name, value)
values (
  'abandon_claimed',
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    'google'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'abandon_claimed'
  ),
  '{"ok":false,"error":"oauth_flow_not_abandonable"}'::jsonb,
  'unbound claimed flow cannot be abandoned even after initial expiry'
);

select ok(
  (
    select state = 'claimed'
       and active
       and session_fenced
       and claimed_at is not null
       and finished_at is null
       and target_user_id is null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000050'
  ),
  'unbound claim remains fail-closed until maintenance expiry'
);

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    'google'
  ),
  (
    select value
      from oauth_test_results
     where name = 'abandon_claimed'
  ),
  'unbound abandon rejection is exactly idempotent'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000052',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    true,
    'google',
    '/gallery',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_source_authority_unverified"}'::jsonb,
  'retained anonymous authority prevents a second source-session flow'
);

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_not_cancellable"}'::jsonb,
  'unbound claimed flow cannot be downgraded through pending cancellation'
);

select ok(
  (
    select status->>'state' = 'claimed'
       and status->'outcome' = 'null'::jsonb
       and (status->>'active')::boolean
      from (
        select public.read_oauth_flow_intent_status(
          '93000000-0000-4000-8000-000000000050',
          '93100000-0000-4000-8000-000000000050',
          '93200000-0000-4000-8000-000000000050',
          'google'
        ) as status
      ) result
  ),
  'status exposes the unbound claimed flow as still active for manual review'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000051',
    '93100000-0000-4000-8000-000000000051',
    '93200000-0000-4000-8000-000000000051',
    true,
    'google',
    '/gallery',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'prebound-abandon recovery scenario begins'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000051',
    '93100000-0000-4000-8000-000000000051',
    '93200000-0000-4000-8000-000000000051',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'prebound-abandon recovery scenario is claimed'
);

select pg_temp.oauth_test_install_auth_authority(
  '93300000-0000-4000-8000-000000000051',
  '93400000-0000-4000-8000-000000000051'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000051',
    '93100000-0000-4000-8000-000000000051',
    '93200000-0000-4000-8000-000000000051',
    'google',
    '93300000-0000-4000-8000-000000000051',
    '93400000-0000-4000-8000-000000000051',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  )->>'ok',
  'true',
  'target evidence can commit before a storage-write crash'
);

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000051',
    '93100000-0000-4000-8000-000000000099',
    '93200000-0000-4000-8000-000000000051',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_not_abandonable"}'::jsonb,
  'prebound abandonment still requires exact source authority'
);

insert into oauth_test_results(name, value)
values (
  'abandon_prebound',
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000051',
    '93100000-0000-4000-8000-000000000051',
    '93200000-0000-4000-8000-000000000051',
    'google'
  )
);

select ok(
  (
    select state = 'abandoned'
       and not active
       and target_user_id =
         '93300000-0000-4000-8000-000000000051'
       and target_session_id =
         '93400000-0000-4000-8000-000000000051'
       and target_access_token_sha256 =
         pg_catalog.repeat('a', 64)
       and target_refresh_token_sha256 =
         pg_catalog.repeat('b', 64)
       and finished_at >= claimed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000051'
  ),
  'prebound abandonment preserves complete target forensic evidence'
);

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000051',
    '93100000-0000-4000-8000-000000000051',
    '93200000-0000-4000-8000-000000000051',
    'google'
  ),
  (
    select value
      from oauth_test_results
     where name = 'abandon_prebound'
  ),
  'prebound abandonment exact replay is idempotent'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000051',
    '93300000-0000-4000-8000-000000000051',
    '93400000-0000-4000-8000-000000000051',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    pg_catalog.repeat('d', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_not_rotatable"}'::jsonb,
  'abandonment freezes preserved target evidence'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000051',
    '93300000-0000-4000-8000-000000000051',
    '93400000-0000-4000-8000-000000000051'
  ),
  '{"ok":false,"error":"oauth_flow_target_generation_changed"}'::jsonb,
  'revoked target session cannot recover abandoned forensic evidence as live authority'
);

-- Expiry applies only to an actually expired pending flow.
select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    false,
    'google',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'expiry scenario begins pending'
);

select is(
  public.expire_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060'
  ),
  '{"ok":false,"error":"oauth_flow_not_expirable"}'::jsonb,
  'fresh pending flow cannot be expired early'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_flow_intents
   set created_at = stamp.now_at - interval '10 minutes',
       expires_at = stamp.now_at
  from stamp
 where flow_id = '93000000-0000-4000-8000-000000000060';

insert into oauth_test_results(name, value)
values (
  'cancel_at_expiry',
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    'google'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'cancel_at_expiry'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000060',
    'outcome', 'expired'
  ),
  'cancel at the exact lease deadline atomically classifies expiry'
);

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    'google'
  ),
  (
    select value
      from oauth_test_results
     where name = 'cancel_at_expiry'
  ),
  'expired cancel response-loss replay is exactly idempotent'
);

insert into oauth_test_results(name, value)
values (
  'expire_pending',
  public.expire_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'expire_pending'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000060',
    'outcome', 'expired'
  ),
  'expired pending flow reaches the exact expired receipt'
);

select ok(
  (
    select state = 'expired'
       and not active
       and claimed_at is null
       and finished_at >= expires_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000060'
  ),
  'expired state has the strict unclaimed terminal shape'
);

select is(
  public.expire_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060'
  ),
  (
    select value
      from oauth_test_results
     where name = 'expire_pending'
  ),
  'expiry exact replay is idempotent'
);

select is(
  public.verify_oauth_flow_source_session_evidence(
    '93000000-0000-4000-8000-000000000060',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    repeat('1', 64),
    repeat('2', 64)
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000060',
    'state', 'expired',
    'matched', true
  ),
  'exact source proof remains verifiable after delayed pending expiry'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000060',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'expired terminal flow cannot be claimed'
);

select is(
  public.expire_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000069'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000069',
    'outcome', 'absent'
  ),
  'missing flow expiry is an explicit idempotent absence receipt'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000061',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    false,
    'google',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  )->>'ok',
  'true',
  'expiry releases the unique active source-session fence'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_flow_intents
   set created_at = stamp.now_at - interval '20 minutes',
       expires_at = stamp.now_at - interval '10 minutes'
  from stamp
 where flow_id = '93000000-0000-4000-8000-000000000061';

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000061',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    'google'
  )->>'outcome',
  'expired',
  'cancel after the lease deadline transitions pending to expired'
);

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000061',
    '93100000-0000-4000-8000-000000000060',
    '93200000-0000-4000-8000-000000000060',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_claimable"}'::jsonb,
  'initial claim refuses an expired pending lease'
);

select is(
  (
    select state
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000061'
  ),
  'expired',
  'failed initial claim atomically records pending expiry'
);

-- Direct invariant fixtures below use deterministic valid source evidence.
-- Production has no defaults; this transaction rolls the fixture defaults back.
alter table public.oauth_flow_intents
  alter column source_access_token_sha256
    set default repeat('0', 64),
  alter column source_refresh_token_sha256
    set default repeat('9', 64);

-- Direct fixture rows intentionally bypass the binding RPC. Fill both target
-- generations together from Auth when available, or with a deterministic
-- fixture generation when the row tests only retention/state constraints.
-- A partially supplied generation remains untouched so the table CHECK can
-- still reject it below.
create or replace function pg_temp.oauth_test_fill_target_generation()
returns trigger
language plpgsql
as $$
begin
  if new.target_user_id is not null
     and new.target_session_id is not null
     and new.target_auth_created_at is null
     and new.target_session_created_at is null then
    select target_user.created_at,
           target_user.instance_id
      into new.target_auth_created_at,
           new.target_auth_instance_id
      from auth.users as target_user
     where target_user.id = new.target_user_id;
    if not found then
      new.target_auth_created_at :=
        coalesce(new.claimed_at, new.created_at);
      new.target_auth_instance_id := null;
    end if;

    select target_session.created_at
      into new.target_session_created_at
      from auth.sessions as target_session
     where target_session.id = new.target_session_id
       and target_session.user_id = new.target_user_id;
    if not found then
      new.target_session_created_at :=
        coalesce(new.claimed_at, new.created_at);
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_oauth_test_fill_target_generation
before insert on public.oauth_flow_intents
for each row
execute function pg_temp.oauth_test_fill_target_generation();

-- Bounded maintenance expires pending/unbound claims, converges abandoned
-- exchange/sign-out crashes after grace, and prunes old terminal rows.
with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at
)
values
  (
    '93000000-0000-4000-8000-000000000070',
    '93100000-0000-4000-8000-000000000070',
    '93200000-0000-4000-8000-000000000070',
    true,
    'google',
    '/',
    'pending',
    '1900-01-01 00:00:00+00',
    '1900-01-01 00:10:00+00'
  ),
  (
    '93000000-0000-4000-8000-000000000071',
    '93100000-0000-4000-8000-000000000071',
    '93200000-0000-4000-8000-000000000071',
    false,
    'kakao',
    '/play',
    'pending',
    '1900-01-01 00:00:00+00',
    '1900-01-01 00:10:00+00'
  );

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at
)
select
  '93000000-0000-4000-8000-000000000072',
  '93100000-0000-4000-8000-000000000072',
  '93200000-0000-4000-8000-000000000072',
  false,
  'google',
  '/',
  'pending',
  stamp.now_at,
  stamp.now_at + interval '10 minutes'
from stamp;

insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at,
  claimed_at
)
values (
  '93000000-0000-4000-8000-000000000073',
  '93100000-0000-4000-8000-000000000073',
  '93200000-0000-4000-8000-000000000073',
  true,
  'google',
  '/',
  'claimed',
  '1900-01-01 00:00:00+00',
  '1900-01-01 00:10:00+00',
  '1900-01-01 00:01:00+00'
);

insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at
)
values (
  '93000000-0000-4000-8000-000000000074',
  '93100000-0000-4000-8000-000000000074',
  '93200000-0000-4000-8000-000000000074',
  false,
  'kakao',
  '/admin',
  'signout_required',
  '93300000-0000-4000-8000-000000000074',
  '93400000-0000-4000-8000-000000000074',
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  '/login?error=account_deleted',
  'signout',
  '1900-01-01 00:00:00+00',
  '1900-01-01 00:10:00+00',
  '1900-01-01 00:01:00+00'
);

insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  revoke_confirmed_at
)
values (
  '93000000-0000-4000-8000-000000000075',
  '93100000-0000-4000-8000-000000000075',
  '93200000-0000-4000-8000-000000000075',
  false,
  'google',
  '/admin',
  'signout_revoked',
  '93300000-0000-4000-8000-000000000075',
  '93400000-0000-4000-8000-000000000075',
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  '/login?error=account_deleted',
  'signout',
  '1900-01-01 00:00:00+00',
  '1900-01-01 00:10:00+00',
  '1900-01-01 00:01:00+00',
  '1900-01-01 00:02:00+00'
);

insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at,
  finished_at
)
values (
  '93000000-0000-4000-8000-000000000076',
  '93100000-0000-4000-8000-000000000076',
  '93200000-0000-4000-8000-000000000076',
  false,
  'google',
  '/',
  'cancelled',
  '1900-01-01 00:00:00+00',
  '1900-01-01 00:10:00+00',
  '1900-01-01 00:02:00+00'
);

-- Install the exact generations before the direct retained-flow fixture.
-- Auth generation fences intentionally reject UUID creation after a flow
-- starts retaining either principal.
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93100000-0000-4000-8000-000000000077',
    'oauth-retained-source@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000077',
    'oauth-retained-target@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values (
  '93400000-0000-4000-8000-000000000077',
  '93300000-0000-4000-8000-000000000077',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  finished_at
)
select
  '93000000-0000-4000-8000-000000000077',
  '93100000-0000-4000-8000-000000000077',
  '93200000-0000-4000-8000-000000000077',
  true,
  'kakao',
  '/gallery',
  'completed',
  '93300000-0000-4000-8000-000000000077',
  '93400000-0000-4000-8000-000000000077',
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  '/consent',
  'continue',
  stamp.now_at - interval '35 days 1 hour 2 minutes',
  stamp.now_at - interval '35 days 52 minutes',
  stamp.now_at - interval '35 days 1 hour 1 minute',
  stamp.now_at - interval '35 days 1 hour'
from stamp;

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  finished_at
)
select
  '93000000-0000-4000-8000-000000000078',
  '93100000-0000-4000-8000-000000000078',
  '93200000-0000-4000-8000-000000000078',
  false,
  'google',
  '/',
  'failed',
  '/login?error=oauth',
  'continue',
  stamp.now_at - interval '1 day',
  stamp.now_at - interval '23 hours 50 minutes',
  stamp.now_at - interval '23 hours 59 minutes',
  stamp.now_at - interval '23 hours'
from stamp;

insert into oauth_test_results(name, value)
values (
  'prune_one',
  public.prune_oauth_flow_intents(1)
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'prune_one'
  ),
  pg_catalog.jsonb_build_object(
    'expiredPending', 1,
    'boundRecoveryConverged', 1,
    'prunedTerminal', 1,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 1,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 1,
    'unreleasedContinueBacklog', 1,
    'unboundClaimBacklog', 2,
    'boundRecoveryBacklog', 1
  ),
  'bounded prune processes at most one expiry and one old terminal'
);

select is(
  (
    select state
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000070'
  ),
  'expired',
  'first oldest pending row is expired'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000076'
  ),
  0,
  'first oldest terminal row is physically pruned'
);

insert into oauth_test_results(name, value)
values (
  'prune_rest',
  public.prune_oauth_flow_intents(500)
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'prune_rest'
  ),
  pg_catalog.jsonb_build_object(
    'expiredPending', 3,
    'boundRecoveryConverged', 1,
    'prunedTerminal', 0,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 1,
    'unreleasedContinueBacklog', 1,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'second prune converges remaining due recovery without deleting migration authority'
);

select is(
  (
    select pg_catalog.array_agg(
             state
             order by flow_id
           )
      from public.oauth_flow_intents
     where flow_id in (
       '93000000-0000-4000-8000-000000000073',
       '93000000-0000-4000-8000-000000000074',
       '93000000-0000-4000-8000-000000000075'
     )
  ),
  array[
    'expired',
    'completed',
    'completed'
  ]::text[],
  'due unbound claim and both bound sign-out crashes converge'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id in (
       '93000000-0000-4000-8000-000000000072',
       '93000000-0000-4000-8000-000000000078'
     )
  ),
  2,
  'fresh pending and recent terminal rows survive maintenance'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000077'
  ),
  1,
  'old unconsumed anonymous completion remains durable migration authority'
);

select is(
  public.prune_oauth_flow_intents(500),
  pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 0,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 1,
    'unreleasedContinueBacklog', 1,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'maintenance replay is empty and idempotent'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  finished_at
)
select
  '93000000-0000-4000-8000-000000000079',
  '93100000-0000-4000-8000-000000000079',
  '93200000-0000-4000-8000-000000000079',
  true,
  'google',
  '/younger-migration',
  'completed',
  '93300000-0000-4000-8000-000000000079',
  '93400000-0000-4000-8000-000000000079',
  pg_catalog.repeat('c', 64),
  pg_catalog.repeat('d', 64),
  '/consent',
  'continue',
  stamp.now_at - interval '34 days 23 hours 2 minutes',
  stamp.now_at - interval '34 days 22 hours 52 minutes',
  stamp.now_at - interval '34 days 23 hours 1 minute',
  stamp.now_at - interval '34 days 23 hours'
from stamp;

select is(
  public.prune_oauth_flow_intents(500),
  pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 0,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 1,
    'unreleasedContinueBacklog', 1,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'thirty-five-day minus one-hour authority survives below backlog boundary'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id in (
       '93000000-0000-4000-8000-000000000077',
       '93000000-0000-4000-8000-000000000079'
     )
  ),
  2,
  'unconsumed migration authority survives on both sides of retention boundary'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000077',
    '93300000-0000-4000-8000-000000000077',
    '93400000-0000-4000-8000-000000000077',
    '93100000-0000-4000-8000-000000000077',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'unreleased completed continue cannot consume anonymous migration'
);

insert into public.oauth_anon_auth_cleanup_jobs (
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
  '93000000-0000-4000-8000-000000000077',
  '93000000-0000-4000-8000-000000000077',
  source_user.id,
  source_user.created_at,
  source_user.instance_id,
  'dormant',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp() + interval '30 days'
from auth.users as source_user
where source_user.id =
  '93100000-0000-4000-8000-000000000077';

select is(
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000077',
    '93300000-0000-4000-8000-000000000077',
    '93400000-0000-4000-8000-000000000077',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64)
  )->>'ok',
  'true',
  'explicit release first clears an old completed continue session fence'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000077',
    '93300000-0000-4000-8000-000000000077',
    '93400000-0000-4000-8000-000000000077',
    '93100000-0000-4000-8000-000000000077',
    repeat('a', 64),
    repeat('b', 64)
  )->>'ok',
  'true',
  'released old authority remains consumable after thirty-five days'
);

select is(
  public.prune_oauth_flow_intents(500),
  pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 0,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 0,
    'unreleasedContinueBacklog', 0,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'consumption clears backlog while preserving its response-loss receipt'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000077'
  ),
  1,
  'fresh migration consumption receipt resets terminal retention age'
);

update public.oauth_flow_intents
   set migration_consumed_at =
         pg_catalog.clock_timestamp() - interval '35 days 1 hour',
       released_at =
         pg_catalog.clock_timestamp() - interval '35 days 1 hour'
 where flow_id =
   '93000000-0000-4000-8000-000000000077';

delete from auth.users
 where id = '93100000-0000-4000-8000-000000000077';

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_anon_auth_cleanup_jobs
   set source_auth_created_at =
         stamp.now_at - interval '40 days',
       created_at = stamp.now_at - interval '39 days',
       armed_at = stamp.now_at - interval '36 days',
       status = 'completed',
       next_attempt_at = null,
       finished_at =
         stamp.now_at - interval '35 days 1 hour'
  from stamp
 where flow_id =
   '93000000-0000-4000-8000-000000000077';

select is(
  public.prune_oauth_flow_intents(500),
  pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 1,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 0,
    'unreleasedContinueBacklog', 0,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'consumed authority becomes pruneable after receipt retention elapses'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000077'
  ),
  0,
  'prune removes old authority only after consumption receipt retention'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000079'
  ),
  1,
  'younger unconsumed authority remains durable after old receipt pruning'
);

select throws_ok(
  'select public.prune_oauth_flow_intents(0)',
  'P0001',
  'invalid_oauth_flow_prune_limit',
  'maintenance limit is bounded fail-closed'
);

-- Migration rejects a structurally valid non-anonymous continue receipt.
with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  finished_at
)
select
  '93000000-0000-4000-8000-000000000085',
  '93100000-0000-4000-8000-000000000085',
  '93200000-0000-4000-8000-000000000085',
  false,
  'google',
  '/',
  'completed',
  '93300000-0000-4000-8000-000000000085',
  '93400000-0000-4000-8000-000000000085',
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  '/',
  'continue',
  stamp.now_at - interval '2 minutes',
  stamp.now_at + interval '8 minutes',
  stamp.now_at - interval '1 minute',
  stamp.now_at
from stamp;

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000085',
    '93300000-0000-4000-8000-000000000085',
    '93400000-0000-4000-8000-000000000085',
    '93100000-0000-4000-8000-000000000085',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'non-anonymous completed flow cannot consume migration'
);

select is(
  (
    select migration_consumed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000085'
  ),
  null,
  'rejected non-anonymous migration leaves no consumption receipt'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'consumed migration replay still requires exact target CAS'
);

-- Every text-domain NOT IN guard rejects NULL explicitly rather than falling
-- through SQL three-valued logic.
select ok(
  (
    select pg_catalog.bool_and(
      value->>'ok' = 'false'
      and value->>'error' like 'invalid_oauth_flow%'
    )
      from (
        values
          (
            public.claim_oauth_flow_intent(
              '93000000-0000-4000-8000-000000000001',
              '93100000-0000-4000-8000-000000000001',
              '93200000-0000-4000-8000-000000000001',
              null,
    repeat('1', 64),
    repeat('2', 64)
            )
          ),
          (
            public.read_oauth_flow_intent_status(
              '93000000-0000-4000-8000-000000000001',
              '93100000-0000-4000-8000-000000000001',
              '93200000-0000-4000-8000-000000000001',
              null
            )
          ),
          (
            public.finalize_oauth_flow_intent(
              '93000000-0000-4000-8000-000000000001',
              '93100000-0000-4000-8000-000000000001',
              '93200000-0000-4000-8000-000000000001',
              'google',
              '/credits?from=oauth',
              'completed',
              '93300000-0000-4000-8000-000000000001',
              '93400000-0000-4000-8000-000000000001',
              pg_catalog.repeat('a', 64),
              pg_catalog.repeat('b', 64),
              '/consent',
              null
            )
          ),
          (
            public.confirm_oauth_flow_signout_revoke(
              '93000000-0000-4000-8000-000000000020',
              '93100000-0000-4000-8000-000000000020',
              '93200000-0000-4000-8000-000000000020',
              null,
              '93300000-0000-4000-8000-000000000020',
              '93400000-0000-4000-8000-000000000020'
            )
          ),
          (
            public.complete_oauth_flow_signout(
              '93000000-0000-4000-8000-000000000020',
              '93100000-0000-4000-8000-000000000020',
              '93200000-0000-4000-8000-000000000020',
              null,
              '93300000-0000-4000-8000-000000000020',
              '93400000-0000-4000-8000-000000000020'
            )
          ),
          (
            public.cancel_oauth_flow_intent(
              '93000000-0000-4000-8000-000000000030',
              '93100000-0000-4000-8000-000000000030',
              '93200000-0000-4000-8000-000000000030',
              null
            )
          ),
          (
            public.abandon_oauth_flow_intent(
              '93000000-0000-4000-8000-000000000050',
              '93100000-0000-4000-8000-000000000050',
              '93200000-0000-4000-8000-000000000050',
              null
            )
          )
      ) invalid_calls(value)
  ),
  'all provider/action NOT IN guards explicitly reject NULL'
);

-- Proof/marker loss can recover authority only from an exact observed source,
-- exact stored target, or a state where durable absence is authoritative.
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93300000-0000-4000-8000-000000000174',
    'oauth-recovery-target-174@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000175',
    'oauth-recovery-target-175@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values
  (
    '93400000-0000-4000-8000-000000000174',
    '93300000-0000-4000-8000-000000000174',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000175',
    '93300000-0000-4000-8000-000000000175',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  revoke_confirmed_at
)
select
  '93000000-0000-4000-8000-000000000174'::uuid,
  '93100000-0000-4000-8000-000000000174'::uuid,
  '93200000-0000-4000-8000-000000000174'::uuid,
  false,
  'google',
  '/admin',
  'signout_required',
  '93300000-0000-4000-8000-000000000174'::uuid,
  '93400000-0000-4000-8000-000000000174'::uuid,
  repeat('a', 64),
  repeat('b', 64),
  '/login?error=account_deleted',
  'signout',
  stamp.now_at,
  stamp.now_at + interval '10 minutes',
  stamp.now_at,
  null
from stamp
union all
select
  '93000000-0000-4000-8000-000000000175',
  '93100000-0000-4000-8000-000000000175',
  '93200000-0000-4000-8000-000000000175',
  false,
  'kakao',
  '/admin',
  'signout_revoked',
  '93300000-0000-4000-8000-000000000175',
  '93400000-0000-4000-8000-000000000175',
  repeat('c', 64),
  repeat('d', 64),
  '/login?error=account_deleted',
  'signout',
  stamp.now_at,
  stamp.now_at + interval '10 minutes',
  stamp.now_at,
  stamp.now_at
from stamp;

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at,
  claimed_at
)
select
  '93000000-0000-4000-8000-000000000176',
  '93100000-0000-4000-8000-000000000176',
  '93200000-0000-4000-8000-000000000176',
  false,
  'google',
  '/',
  'claimed',
  stamp.now_at,
  stamp.now_at + interval '10 minutes',
  stamp.now_at
from stamp;

select is(
  public.recover_active_oauth_flow_by_observed_session(
    '93100000-0000-4000-8000-000000000072',
    '93200000-0000-4000-8000-000000000072'
  ),
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000072',
    '93100000-0000-4000-8000-000000000072',
    '93200000-0000-4000-8000-000000000072'
  ),
  'lost flow ID recovers the exact active source authority receipt'
);

select is(
  public.recover_active_oauth_flow_by_observed_session(
    '93300000-0000-4000-8000-000000000174',
    '93400000-0000-4000-8000-000000000174'
  ),
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000174',
    '93300000-0000-4000-8000-000000000174',
    '93400000-0000-4000-8000-000000000174'
  ),
  'lost flow ID recovers the exact active bound-target authority receipt'
);

select is(
  public.recover_active_oauth_flow_by_observed_session(
    '93100000-0000-4000-8000-000000000089',
    '93200000-0000-4000-8000-000000000089'
  ),
  '{"ok":true,"state":"absent","active":false}'::jsonb,
  'lost flow ID absence returns exactly three privacy-minimal keys'
);

select is(
  public.recover_active_oauth_flow_by_observed_session(
    null,
    '93200000-0000-4000-8000-000000000089'
  ),
  '{"ok":false,"error":"invalid_oauth_flow_observed_session_recovery"}'::jsonb,
  'lost-flow recovery rejects a missing observed identity half'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
),
ambiguous_rows(
  flow_id,
  source_user_id,
  source_session_id
) as (
  values
    (
      '93000000-0000-4000-8000-000000000118'::uuid,
      '93100000-0000-4000-8000-000000000118'::uuid,
      '93200000-0000-4000-8000-000000000118'::uuid
    ),
    (
      '93000000-0000-4000-8000-000000000119'::uuid,
      '93100000-0000-4000-8000-000000000119'::uuid,
      '93200000-0000-4000-8000-000000000119'::uuid
    )
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next, state,
  target_user_id, target_session_id,
  target_access_token_sha256, target_refresh_token_sha256,
  created_at, expires_at, claimed_at
)
select
  a.flow_id,
  a.source_user_id,
  a.source_session_id,
  false,
  'google',
  '/',
  'claimed',
  '93300000-0000-4000-8000-000000000118',
  '93400000-0000-4000-8000-000000000118',
  repeat('a', 64),
  repeat('b', 64),
  stamp.now_at,
  stamp.now_at + interval '10 minutes',
  stamp.now_at
from ambiguous_rows a
cross join stamp;

select is(
  public.recover_active_oauth_flow_by_observed_session(
    '93300000-0000-4000-8000-000000000118',
    '93400000-0000-4000-8000-000000000118'
  ),
  '{"ok":false,"error":"oauth_flow_observed_session_ambiguous"}'::jsonb,
  'ambiguous active target observation fails closed without guessing a flow'
);

insert into oauth_test_results(name, value)
values (
  'recover_source_pending',
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000072',
    '93100000-0000-4000-8000-000000000072',
    '93200000-0000-4000-8000-000000000072'
  )
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 21
       and value->>'ok' = 'true'
       and value->>'state' = 'pending'
       and value->>'sourceUserId' =
         '93100000-0000-4000-8000-000000000072'
       and value->>'sourceSessionId' =
         '93200000-0000-4000-8000-000000000072'
      from oauth_test_results
     where name = 'recover_source_pending'
  ),
  'exact observed source recovers all states with a twenty-one-key proof receipt'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000174',
    '93300000-0000-4000-8000-000000000174',
    '93400000-0000-4000-8000-000000000174'
  )->>'state',
  'signout_required',
  'exact observed target recovers an active sign-out decision'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000001',
    '93300000-0000-4000-8000-000000000001',
    '93400000-0000-4000-8000-000000000001'
  ) - array['sourceUserId', 'sourceSessionId'],
  public.read_oauth_flow_intent_status(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google'
  ),
  'target recovery otherwise equals the authoritative nineteen-key status'
);

select ok(
  (
    select pg_catalog.bool_and(
      value = pg_catalog.jsonb_build_object(
        'ok', true,
        'flowId', expected_flow_id,
        'state', expected_state,
        'active', expected_active
      )
    )
      from (
        values
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000175',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000175',
            'signout_revoked',
            true
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000001',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000001',
            'completed',
            false
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000020',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000020',
            'completed',
            false
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000010',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000010',
            'failed',
            false
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000030',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000030',
            'cancelled',
            false
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000051',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000051',
            'abandoned',
            false
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000060',
              null,
              null
            ),
            '93000000-0000-4000-8000-000000000060',
            'expired',
            false
          )
      ) recoverable_absence(
        value,
        expected_flow_id,
        expected_state,
        expected_active
      )
  ),
  'absence returns only an exact four-key cleanup receipt'
);

/*
 * The following shape is intentionally absent from the assertion above:
 * source/target IDs, provider, requestedNext, destination, action, and all
 * timestamps. Absence is cleanup authority, never identity authority.
 */

select ok(
  (
    select pg_catalog.bool_and(
      value = pg_catalog.jsonb_build_object(
        'ok', true,
        'flowId', expected_flow_id,
        'state', expected_state,
        'active', false
      )
    )
      from (
        values
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000001',
              '93300000-0000-4000-8000-000000000099',
              '93400000-0000-4000-8000-000000000099'
            ),
            '93000000-0000-4000-8000-000000000001',
            'completed'
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000010',
              '93300000-0000-4000-8000-000000000099',
              '93400000-0000-4000-8000-000000000099'
            ),
            '93000000-0000-4000-8000-000000000010',
            'failed'
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000030',
              '93300000-0000-4000-8000-000000000099',
              '93400000-0000-4000-8000-000000000099'
            ),
            '93000000-0000-4000-8000-000000000030',
            'cancelled'
          ),
          (
            public.recover_oauth_flow_intent_authority(
              '93000000-0000-4000-8000-000000000060',
              '93300000-0000-4000-8000-000000000099',
              '93400000-0000-4000-8000-000000000099'
            ),
            '93000000-0000-4000-8000-000000000060',
            'expired'
          )
      ) unrelated_terminal(value, expected_flow_id, expected_state)
  ),
  'unrelated coherent identity gets only minimal non-fenced terminal cleanup authority'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000072',
    null,
    null
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'absence cannot authorize a pending flow'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000176',
    null,
    null
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'absence cannot authorize a claimed flow'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000176',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000099'
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'unrelated identity cannot exploit a NULL unbound target on a fenced claim'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000174',
    null,
    null
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'absence cannot skip required remote sign-out revoke'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000174',
    '93300000-0000-4000-8000-000000000099',
    '93400000-0000-4000-8000-000000000099'
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'a different coherent observed session never gains flow authority'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000174',
    '93300000-0000-4000-8000-000000000174',
    null
  ),
  '{"ok":false,"error":"invalid_oauth_flow_authority_recovery"}'::jsonb,
  'half-present observed identity is rejected as invalid'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000089',
    null,
    null
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000089',
    'state', 'absent',
    'active', false
  ),
  'truly absent flow returns only a privacy-minimal cleanup receipt'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000089',
    '93100000-0000-4000-8000-000000000089',
    '93200000-0000-4000-8000-000000000089'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000089',
    'state', 'absent',
    'active', false
  ),
  'coherent current-session observation gets the same exact absent receipt'
);

select is(
  public.complete_recovered_oauth_flow_signout(null),
  '{"ok":false,"error":"invalid_oauth_flow_recovered_signout"}'::jsonb,
  'proofless recovered sign-out completion rejects a NULL flow ID'
);

select is(
  public.complete_recovered_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000001'
  ),
  '{"ok":false,"error":"oauth_flow_recovered_signout_not_completable"}'::jsonb,
  'proofless completion cannot advance completed/continue authority'
);

insert into oauth_test_results(name, value)
values (
  'complete_recovered_signout',
  public.complete_recovered_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000075'
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'complete_recovered_signout'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000075',
    'state', 'completed',
    'destination', '/login?error=account_deleted'
  ),
  'durable revoke plus raw absence completes with an exact four-key receipt'
);

select ok(
  (
    select state = 'completed'
       and action = 'signout'
       and finished_at >= revoke_confirmed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000075'
  ),
  'proofless completion preserves ordered revoke evidence'
);

select is(
  public.complete_recovered_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000075'
  ),
  (
    select value
      from oauth_test_results
     where name = 'complete_recovered_signout'
  ),
  'proofless completion response-loss replay is exactly idempotent'
);

-- Direct-write checks prove the state/time/destination constraints are not
-- merely conventions inside the SECURITY DEFINER functions.
select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_access_token_sha256, source_refresh_token_sha256,
      source_is_anonymous, provider, requested_next, state,
      created_at, expires_at
    ) values (
      '93000000-0000-4000-8000-000000000117',
      '93100000-0000-4000-8000-000000000117',
      '93200000-0000-4000-8000-000000000117',
      'abc', repeat('2', 64),
      false, 'google', '/', 'pending',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00'
    )
  $sql$),
  'source session evidence rejects a malformed digest'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next,
      state, created_at, expires_at
    ) values (
      '93000000-0000-4000-8000-000000000090',
      '93100000-0000-4000-8000-000000000090',
      '93200000-0000-4000-8000-000000000090',
      false, 'google', '/', 'invented',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00'
    )
  $sql$),
  'unknown state violates the closed state domain'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next,
      state, created_at, expires_at
    ) values (
      '93000000-0000-4000-8000-000000000091',
      '93100000-0000-4000-8000-000000000091',
      '93200000-0000-4000-8000-000000000091',
      false, 'google', '//evil.test', 'pending',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00'
    )
  $sql$),
  'unsafe requested_next violates the internal-destination constraint'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next,
      state, created_at, expires_at
    ) values (
      '93000000-0000-4000-8000-000000000092',
      '93100000-0000-4000-8000-000000000092',
      '93200000-0000-4000-8000-000000000092',
      false, 'google', '/', 'pending',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:09:59+00'
    )
  $sql$),
  'lease duration must be exactly ten minutes'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next,
      state, created_at, expires_at, claimed_at
    ) values (
      '93000000-0000-4000-8000-000000000093',
      '93100000-0000-4000-8000-000000000093',
      '93200000-0000-4000-8000-000000000093',
      false, 'google', '/', 'pending',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00'
    )
  $sql$),
  'pending state cannot carry a claim timestamp'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, destination, action,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000094',
      '93100000-0000-4000-8000-000000000094',
      '93200000-0000-4000-8000-000000000094',
      true, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000094',
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'target user and session must be present together'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_auth_created_at,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000180',
      '93100000-0000-4000-8000-000000000180',
      '93200000-0000-4000-8000-000000000180',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000180',
      '93400000-0000-4000-8000-000000000180',
      '2020-01-01 00:00:30+00',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'a bound target rejects a partial Auth/session generation'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000104',
      '93100000-0000-4000-8000-000000000104',
      '93200000-0000-4000-8000-000000000104',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000104',
      '93200000-0000-4000-8000-000000000104',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'table invariant forbids target/source session-ID collision'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000105',
      '93100000-0000-4000-8000-000000000105',
      '93200000-0000-4000-8000-000000000105',
      true, 'google', '/', 'completed',
      '93100000-0000-4000-8000-000000000105',
      '93400000-0000-4000-8000-000000000105',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'table invariant forbids anonymous migration-to-self'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at
    ) values (
      '93000000-0000-4000-8000-000000000095',
      '93100000-0000-4000-8000-000000000095',
      '93200000-0000-4000-8000-000000000095',
      false, 'google', '/', 'signout_revoked',
      '93300000-0000-4000-8000-000000000095',
      '93400000-0000-4000-8000-000000000095',
      repeat('a', 64), repeat('b', 64),
      '/', 'signout',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00'
    )
  $sql$),
  'signout_revoked requires a durable revoke timestamp'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at,
      revoke_confirmed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000096',
      '93100000-0000-4000-8000-000000000096',
      '93200000-0000-4000-8000-000000000096',
      true, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000096',
      '93400000-0000-4000-8000-000000000096',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00',
      '2020-01-01 00:03:00+00'
    )
  $sql$),
  'continue completion cannot carry a sign-out revoke timestamp'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at,
      migration_consumed_at, migration_result
    ) values (
      '93000000-0000-4000-8000-000000000097',
      '93100000-0000-4000-8000-000000000097',
      '93200000-0000-4000-8000-000000000097',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000097',
      '93400000-0000-4000-8000-000000000097',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00',
      '2020-01-01 00:03:00+00',
      '{"ok":true,"scores":0,"badges":0,"telemetry":0}'::jsonb
    )
  $sql$),
  'non-anonymous flow cannot carry migration consumption'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at,
      migration_consumed_at, migration_result
    ) values (
      '93000000-0000-4000-8000-000000000098',
      '93100000-0000-4000-8000-000000000098',
      '93200000-0000-4000-8000-000000000098',
      true, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000098',
      '93400000-0000-4000-8000-000000000098',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:03:00+00',
      '2020-01-01 00:02:00+00',
      '{"ok":true,"scores":0,"badges":0,"telemetry":0}'::jsonb
    )
  $sql$),
  'migration consumption cannot precede terminal completion'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000106',
      '93100000-0000-4000-8000-000000000106',
      '93200000-0000-4000-8000-000000000106',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000106',
      '93400000-0000-4000-8000-000000000106',
      'abc', repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'target evidence rejects a malformed digest'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000107',
      '93100000-0000-4000-8000-000000000107',
      '93200000-0000-4000-8000-000000000107',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000107',
      '93400000-0000-4000-8000-000000000107',
      repeat('a', 64), null,
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'target evidence digests must be present as an indivisible pair'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      created_at, expires_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000108',
      '93100000-0000-4000-8000-000000000108',
      '93200000-0000-4000-8000-000000000108',
      false, 'google', '/', 'expired',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'expired state cannot finish before its exact lease deadline'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at, finished_at, released_at
    ) values (
      '93000000-0000-4000-8000-000000000109',
      '93100000-0000-4000-8000-000000000109',
      '93200000-0000-4000-8000-000000000109',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000109',
      '93400000-0000-4000-8000-000000000109',
      repeat('a', 64), repeat('b', 64),
      '/', 'continue',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:03:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'release boundary cannot precede completed finalization'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      target_user_id, target_session_id,
      target_access_token_sha256, target_refresh_token_sha256,
      destination, action,
      created_at, expires_at, claimed_at,
      revoke_confirmed_at, finished_at, released_at
    ) values (
      '93000000-0000-4000-8000-000000000110',
      '93100000-0000-4000-8000-000000000110',
      '93200000-0000-4000-8000-000000000110',
      false, 'google', '/', 'completed',
      '93300000-0000-4000-8000-000000000110',
      '93400000-0000-4000-8000-000000000110',
      repeat('a', 64), repeat('b', 64),
      '/', 'signout',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00',
      '2020-01-01 00:03:00+00',
      '2020-01-01 00:04:00+00'
    )
  $sql$),
  'completed sign-out can never carry a continue-session release boundary'
);

select ok(
  (
    select pg_catalog.bool_and(
      pg_temp.oauth_test_check_rejected(
        pg_catalog.format(
          $fmt$
            insert into public.oauth_flow_intents (
              flow_id, source_user_id, source_session_id,
              source_is_anonymous, provider, requested_next, state,
              target_user_id, target_session_id,
              target_access_token_sha256,
              target_refresh_token_sha256,
              destination, action,
              created_at, expires_at, claimed_at, finished_at,
              migration_consumed_at, migration_result
            ) values (
              '93000000-0000-4000-8000-000000000111',
              '93100000-0000-4000-8000-000000000111',
              '93200000-0000-4000-8000-000000000111',
              true, 'google', '/', 'completed',
              '93300000-0000-4000-8000-000000000111',
              '93400000-0000-4000-8000-000000000111',
              repeat('a', 64), repeat('b', 64),
              '/', 'continue',
              '2020-01-01 00:00:00+00',
              '2020-01-01 00:10:00+00',
              '2020-01-01 00:01:00+00',
              '2020-01-01 00:02:00+00',
              '2020-01-01 00:03:00+00',
              %L::jsonb
            )
          $fmt$,
          invalid_result
        )
      )
    )
      from (
        values
          ('{}'),
          ('{"ok":true}'),
          ('null'),
          ('false'),
          ('[]'),
          ('"scalar"'),
          ('{"ok":true,"skipped":"wrong"}'),
          ('{"ok":true,"skipped":"target_already_member","extra":true}'),
          ('{"ok":false,"scores":0,"badges":0,"telemetry":0}'),
          ('{"ok":true,"scores":0,"badges":0,"telemetry":0,"extra":0}'),
          ('{"ok":true,"scores":"0","badges":0,"telemetry":0}'),
          ('{"ok":true,"scores":-1,"badges":0,"telemetry":0}'),
          ('{"ok":true,"scores":2147483648,"badges":0,"telemetry":0}'),
          ('{"ok":true,"scores":1.5,"badges":0,"telemetry":0}')
      ) invalid_receipts(invalid_result)
  ),
  'migration receipt rejects missing, null, false, scalar, non-canonical skip, extra, malformed, negative, fractional, and out-of-range shapes'
);

select ok(
  pg_temp.oauth_test_check_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next, state,
      created_at, expires_at, claimed_at, finished_at
    ) values (
      '93000000-0000-4000-8000-000000000099',
      '93100000-0000-4000-8000-000000000099',
      '93200000-0000-4000-8000-000000000099',
      true, 'google', '/', 'claimed',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00',
      '2020-01-01 00:01:00+00',
      '2020-01-01 00:02:00+00'
    )
  $sql$),
  'claimed recovery fence cannot be marked finished'
);

select ok(
  pg_temp.oauth_test_unique_rejected($sql$
    insert into public.oauth_flow_intents (
      flow_id, source_user_id, source_session_id,
      source_is_anonymous, provider, requested_next,
      state, created_at, expires_at
    ) values (
      '93000000-0000-4000-8000-000000000100',
      '93100000-0000-4000-8000-000000000100',
      '93200000-0000-4000-8000-000000000176',
      false, 'google', '/', 'pending',
      '2020-01-01 00:00:00+00',
      '2020-01-01 00:10:00+00'
    )
  $sql$),
  'generated active projection enforces one active flow per source session'
);

select ok(
  (
    select pg_catalog.bool_and(
      active = (
        state in (
          'pending',
          'claimed',
          'signout_required',
          'signout_revoked'
        )
      )
    )
      from public.oauth_flow_intents
     where flow_id::text like '93000000-%'
  ),
  'active is exactly equivalent to the four recoverable states'
);

-- Wall-clock rollback and lock-wait timestamp hardening.
with bounds as (
  select pg_catalog.clock_timestamp() + interval '5 minutes'
    as created_at
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next,
  state, created_at, expires_at
)
select
  '93000000-0000-4000-8000-000000000112',
  '93100000-0000-4000-8000-000000000112',
  '93200000-0000-4000-8000-000000000112',
  false, 'google', '/clock', 'pending',
  created_at, created_at + interval '10 minutes'
from bounds;

select is(
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000112',
    '93100000-0000-4000-8000-000000000112',
    '93200000-0000-4000-8000-000000000112',
    'google',
    repeat('0', 64),
    repeat('9', 64)
  )->>'ok',
  'true',
  'claim remains valid after a backward wall-clock step'
);

select ok(
  (
    select claimed_at >= created_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000112'
  ),
  'claim timestamp never precedes creation'
);

select pg_temp.oauth_test_install_auth_authority(
  '93300000-0000-4000-8000-000000000112',
  '93400000-0000-4000-8000-000000000112'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000112',
    '93100000-0000-4000-8000-000000000112',
    '93200000-0000-4000-8000-000000000112',
    'google',
    '93300000-0000-4000-8000-000000000112',
    '93400000-0000-4000-8000-000000000112',
    repeat('a', 64),
    repeat('b', 64)
  )->>'ok',
  'true',
  'future-dated claim can bind its exact target evidence'
);

select is(
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000112',
    '93100000-0000-4000-8000-000000000112',
    '93200000-0000-4000-8000-000000000112',
    'google',
    '/clock',
    'completed',
    '93300000-0000-4000-8000-000000000112',
    '93400000-0000-4000-8000-000000000112',
    repeat('a', 64),
    repeat('b', 64),
    '/clock',
    'continue'
  )->>'ok',
  'true',
  'finalize remains valid after a backward wall-clock step'
);

select ok(
  (
    select finished_at >= claimed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000112'
  ),
  'finalize timestamp never precedes claim'
);

select is(
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000112',
    '93300000-0000-4000-8000-000000000112',
    '93400000-0000-4000-8000-000000000112',
    repeat('a', 64),
    repeat('b', 64)
  )->>'ok',
  'true',
  'release remains valid after a backward wall-clock step'
);

select ok(
  (
    select released_at >= finished_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000112'
  ),
  'release timestamp never precedes finalize'
);

with bounds as (
  select pg_catalog.clock_timestamp() + interval '5 minutes'
    as created_at
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next, state,
  target_user_id, target_session_id,
  target_access_token_sha256, target_refresh_token_sha256,
  destination, action,
  created_at, expires_at, claimed_at
)
select
  '93000000-0000-4000-8000-000000000113',
  '93100000-0000-4000-8000-000000000113',
  '93200000-0000-4000-8000-000000000113',
  false, 'kakao', '/clock-signout', 'signout_required',
  '93300000-0000-4000-8000-000000000113',
  '93400000-0000-4000-8000-000000000113',
  repeat('c', 64), repeat('d', 64),
  '/clock-signout', 'signout',
  created_at, created_at + interval '10 minutes', created_at
from bounds;

select is(
  public.confirm_oauth_flow_signout_revoke(
    '93000000-0000-4000-8000-000000000113',
    '93100000-0000-4000-8000-000000000113',
    '93200000-0000-4000-8000-000000000113',
    'kakao',
    '93300000-0000-4000-8000-000000000113',
    '93400000-0000-4000-8000-000000000113'
  )->>'ok',
  'true',
  'revoke confirmation remains valid after a backward wall-clock step'
);

select ok(
  (
    select revoke_confirmed_at >= claimed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000113'
  ),
  'revoke confirmation timestamp never precedes claim'
);

select is(
  public.complete_recovered_oauth_flow_signout(
    '93000000-0000-4000-8000-000000000113'
  )->>'ok',
  'true',
  'recovered sign-out completion survives a backward wall-clock step'
);

select ok(
  (
    select finished_at >= revoke_confirmed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000113'
  ),
  'sign-out completion timestamp never precedes revoke confirmation'
);

with bounds as (
  select pg_catalog.clock_timestamp() + interval '5 minutes'
    as created_at
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next,
  state, created_at, expires_at
)
select
  '93000000-0000-4000-8000-000000000114',
  '93100000-0000-4000-8000-000000000114',
  '93200000-0000-4000-8000-000000000114',
  false, 'google', '/clock-cancel', 'pending',
  created_at, created_at + interval '10 minutes'
from bounds;

select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000114',
    '93100000-0000-4000-8000-000000000114',
    '93200000-0000-4000-8000-000000000114',
    'google'
  )->>'ok',
  'true',
  'cancel remains valid after a backward wall-clock step'
);

select ok(
  (
    select finished_at >= created_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000114'
  ),
  'cancel timestamp never precedes creation'
);

with bounds as (
  select pg_catalog.clock_timestamp() + interval '5 minutes'
    as created_at
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next,
  state, target_user_id, target_session_id,
  target_access_token_sha256, target_refresh_token_sha256,
  created_at, expires_at, claimed_at
)
select
  '93000000-0000-4000-8000-000000000115',
  '93100000-0000-4000-8000-000000000115',
  '93200000-0000-4000-8000-000000000115',
  false, 'kakao', '/clock-abandon', 'claimed',
  '93300000-0000-4000-8000-000000000115',
  '93400000-0000-4000-8000-000000000115',
  repeat('a', 64), repeat('b', 64),
  created_at, created_at + interval '10 minutes', created_at
from bounds;

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000115',
    '93100000-0000-4000-8000-000000000115',
    '93200000-0000-4000-8000-000000000115',
    'kakao'
  )->>'ok',
  'true',
  'bound abandon remains valid after a backward wall-clock step'
);

select ok(
  (
    select revoke_confirmed_at >= claimed_at
       and finished_at >= revoke_confirmed_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000115'
  ),
  'bound abandon revoke/finish timestamp never precedes claim'
);

insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93100000-0000-4000-8000-000000000116',
    'oauth-clock-source@test.local',
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000116',
    'oauth-clock-target@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values (
  '93400000-0000-4000-8000-000000000116',
  '93300000-0000-4000-8000-000000000116',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

with bounds as (
  select pg_catalog.clock_timestamp() + interval '5 minutes'
    as created_at
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next, state,
  target_user_id, target_session_id,
  target_access_token_sha256, target_refresh_token_sha256,
  destination, action,
  created_at, expires_at, claimed_at, finished_at, released_at
)
select
  '93000000-0000-4000-8000-000000000116',
  '93100000-0000-4000-8000-000000000116',
  '93200000-0000-4000-8000-000000000116',
  true, 'google', '/clock-migrate', 'completed',
  '93300000-0000-4000-8000-000000000116',
  '93400000-0000-4000-8000-000000000116',
  repeat('e', 64), repeat('f', 64),
  '/clock-migrate', 'continue',
  created_at, created_at + interval '10 minutes',
  created_at, created_at, created_at
from bounds;

insert into public.oauth_anon_auth_cleanup_jobs (
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
  '93000000-0000-4000-8000-000000000116',
  '93000000-0000-4000-8000-000000000116',
  source_user.id,
  source_user.created_at,
  source_user.instance_id,
  'dormant',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp() + interval '30 days'
from auth.users as source_user
where source_user.id =
  '93100000-0000-4000-8000-000000000116';

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000116',
    '93300000-0000-4000-8000-000000000116',
    '93400000-0000-4000-8000-000000000116',
    '93100000-0000-4000-8000-000000000116',
    repeat('a', 64),
    repeat('b', 64)
  )->>'ok',
  'true',
  'migration consumption remains valid after a backward wall-clock step'
);

select ok(
  (
    select migration_consumed_at >= finished_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000116'
  ),
  'migration consumption timestamp never precedes finalize'
);

-- Bound-target ghost-session recovery deletes exactly one Auth session and
-- commits the terminal ledger receipt in the same transaction.
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93300000-0000-4000-8000-000000000120',
    'oauth-cleanup-target@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000121',
    'oauth-cleanup-other@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000122',
    'oauth-cleanup-signout@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000123',
    'oauth-cleanup-continue@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000125',
    'oauth-cleanup-anon-target@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93300000-0000-4000-8000-000000000126',
    'oauth-cleanup-wrapper@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values
  (
    '93400000-0000-4000-8000-000000000120',
    '93300000-0000-4000-8000-000000000120',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000121',
    '93300000-0000-4000-8000-000000000121',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000122',
    '93300000-0000-4000-8000-000000000122',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000123',
    '93300000-0000-4000-8000-000000000123',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000125',
    '93300000-0000-4000-8000-000000000125',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93400000-0000-4000-8000-000000000126',
    '93300000-0000-4000-8000-000000000126',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.refresh_tokens(
  token, user_id, revoked, created_at, updated_at, session_id
)
values
  (
    'oauth-cleanup-refresh-120',
    '93300000-0000-4000-8000-000000000120',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    '93400000-0000-4000-8000-000000000120'
  ),
  (
    'oauth-cleanup-refresh-122',
    '93300000-0000-4000-8000-000000000122',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    '93400000-0000-4000-8000-000000000122'
  ),
  (
    'oauth-cleanup-refresh-123',
    '93300000-0000-4000-8000-000000000123',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    '93400000-0000-4000-8000-000000000123'
  );

insert into auth.mfa_amr_claims(
  session_id, created_at, updated_at, authentication_method, id
)
values (
  '93400000-0000-4000-8000-000000000120',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),
  'password',
  '93500000-0000-4000-8000-000000000120'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_120',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000120',
    '93100000-0000-4000-8000-000000000120',
    '93200000-0000-4000-8000-000000000120',
    false,
    'google',
    '/cleanup',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_120',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000120',
    '93100000-0000-4000-8000-000000000120',
    '93200000-0000-4000-8000-000000000120',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_bind_120',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000120',
    '93100000-0000-4000-8000-000000000120',
    '93200000-0000-4000-8000-000000000120',
    'google',
    '93300000-0000-4000-8000-000000000120',
    '93400000-0000-4000-8000-000000000120',
    repeat('a', 64),
    repeat('b', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claimed_120',
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000120',
    '93100000-0000-4000-8000-000000000120',
    '93200000-0000-4000-8000-000000000120',
    'google'
  )
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 6
       and value - 'revokeConfirmedAt' =
         pg_catalog.jsonb_build_object(
           'ok', true,
           'flowId', '93000000-0000-4000-8000-000000000120',
           'state', 'abandoned',
           'outcome', 'abandoned',
           'destination', '/'
         )
       and pg_catalog.jsonb_typeof(
         value->'revokeConfirmedAt'
       ) = 'string'
      from oauth_test_results
     where name = 'cleanup_claimed_120'
  ),
  'claimed ghost cleanup returns the exact six-key terminal receipt'
);

select is(
  (
    select (
      (select pg_catalog.count(*) from auth.sessions
        where id = '93400000-0000-4000-8000-000000000120')
      +
      (select pg_catalog.count(*) from auth.refresh_tokens
        where session_id = '93400000-0000-4000-8000-000000000120')
      +
      (select pg_catalog.count(*) from auth.mfa_amr_claims
        where session_id = '93400000-0000-4000-8000-000000000120')
    )::integer
  ),
  0,
  'exact Auth session deletion cascades refresh tokens and MFA claims'
);

select ok(
  (
    select state = 'abandoned'
       and not active
       and not session_fenced
       and target_user_id =
         '93300000-0000-4000-8000-000000000120'
       and target_session_id =
         '93400000-0000-4000-8000-000000000120'
       and revoke_confirmed_at is not null
       and finished_at = revoke_confirmed_at
       and released_at is null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000120'
  ),
  'claimed cleanup preserves exact target evidence and records an ordered tombstone'
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000120',
    '93100000-0000-4000-8000-000000000120',
    '93200000-0000-4000-8000-000000000120',
    'google'
  ),
  (
    select value
      from oauth_test_results
     where name = 'cleanup_claimed_120'
  ),
  'claimed cleanup response-loss replay preserves its exact timestamp'
);

select throws_ok(
  $$
    insert into auth.sessions (id, user_id, created_at, updated_at)
    values (
      '93400000-0000-4000-8000-000000000120',
      '93300000-0000-4000-8000-000000000120',
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    )
  $$,
  '23514',
  'migration_target_session_id_tombstoned',
  'Auth session UUID reuse is rejected by the durable revoke tombstone'
);

-- Simulate an out-of-band tombstone/session divergence without requiring
-- ownership of the Auth schema in the disposable least-privilege harness.
update public.oauth_flow_intents
   set target_session_id =
     '93400000-0000-4000-8000-000000000119'
 where flow_id =
   '93000000-0000-4000-8000-000000000120';
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '93400000-0000-4000-8000-000000000120',
  '93300000-0000-4000-8000-000000000120',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);
update public.oauth_flow_intents
   set target_session_id =
     '93400000-0000-4000-8000-000000000120'
 where flow_id =
   '93000000-0000-4000-8000-000000000120';

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000120',
    '93100000-0000-4000-8000-000000000120',
    '93200000-0000-4000-8000-000000000120',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_bound_target_session_reappeared"}'::jsonb,
  'terminal cleanup replay fails closed if its deleted Auth session ID reappears'
);

select ok(
  exists (
    select 1
      from auth.sessions
     where id = '93400000-0000-4000-8000-000000000120'
       and user_id = '93300000-0000-4000-8000-000000000120'
  ),
  'terminal cleanup replay never deletes a reappeared Auth session'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000127',
    '93300000-0000-4000-8000-000000000120',
    '93400000-0000-4000-8000-000000000120',
    false,
    'google',
    '/',
    repeat('3', 64),
    repeat('4', 64)
  ),
  '{"ok":false,"error":"oauth_flow_already_active"}'::jsonb,
  'deleted target-session tombstone rejects a later begin'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_121',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000121',
    '93100000-0000-4000-8000-000000000121',
    '93200000-0000-4000-8000-000000000121',
    false,
    'kakao',
    '/',
    repeat('3', 64),
    repeat('4', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_121',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000121',
    '93100000-0000-4000-8000-000000000121',
    '93200000-0000-4000-8000-000000000121',
    'kakao',
    repeat('3', 64),
    repeat('4', 64)
  )
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000121',
    '93100000-0000-4000-8000-000000000121',
    '93200000-0000-4000-8000-000000000121',
    'kakao',
    '93300000-0000-4000-8000-000000000120',
    '93400000-0000-4000-8000-000000000120',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_session_already_active"}'::jsonb,
  'deleted target-session tombstone rejects a later bind'
);

select ok(
  (
    select target_session_id is not null
       and revoke_confirmed_at is not null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000003'
       and state = 'abandoned'
  ),
  'legacy bound-abandon entry point also records a revoked-session tombstone'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_122',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000122',
    '93100000-0000-4000-8000-000000000122',
    '93200000-0000-4000-8000-000000000122',
    false,
    'google',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_122',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000122',
    '93100000-0000-4000-8000-000000000122',
    '93200000-0000-4000-8000-000000000122',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_bind_122',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000122',
    '93100000-0000-4000-8000-000000000122',
    '93200000-0000-4000-8000-000000000122',
    'google',
    '93300000-0000-4000-8000-000000000120',
    '93400000-0000-4000-8000-000000000121',
    repeat('a', 64),
    repeat('b', 64)
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'cleanup_bind_122'
  ),
  '{"ok":false,"error":"oauth_flow_target_authority_unverified"}'::jsonb,
  'bind rejects a target session owned by another Auth user'
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000122',
    '93100000-0000-4000-8000-000000000122',
    '93200000-0000-4000-8000-000000000122',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_bound_target_not_revocable"}'::jsonb,
  'rejected target authority never becomes cleanup deletion authority'
);

select ok(
  (
    select exists (
      select 1
        from auth.sessions
       where id = '93400000-0000-4000-8000-000000000121'
         and user_id =
           '93300000-0000-4000-8000-000000000121'
    )
    and exists (
      select 1
        from public.oauth_flow_intents
       where flow_id =
         '93000000-0000-4000-8000-000000000122'
         and state = 'claimed'
         and target_session_id is null
         and revoke_confirmed_at is null
         and session_fenced
    )
  ),
  'bind identity conflict deletes nothing and leaves the source ledger recoverable'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_123',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000123',
    '93100000-0000-4000-8000-000000000123',
    '93200000-0000-4000-8000-000000000123',
    false,
    'google',
    '/signed-out',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_123',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000123',
    '93100000-0000-4000-8000-000000000123',
    '93200000-0000-4000-8000-000000000123',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_bind_123',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000123',
    '93100000-0000-4000-8000-000000000123',
    '93200000-0000-4000-8000-000000000123',
    'google',
    '93300000-0000-4000-8000-000000000122',
    '93400000-0000-4000-8000-000000000122',
    repeat('a', 64),
    repeat('b', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_finalize_123',
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000123',
    '93100000-0000-4000-8000-000000000123',
    '93200000-0000-4000-8000-000000000123',
    'google',
    '/signed-out',
    'completed',
    '93300000-0000-4000-8000-000000000122',
    '93400000-0000-4000-8000-000000000122',
    repeat('a', 64),
    repeat('b', 64),
    '/signed-out',
    'signout'
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_signout_123',
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000123',
    '93100000-0000-4000-8000-000000000123',
    '93200000-0000-4000-8000-000000000123',
    'google'
  )
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 6
       and value - 'revokeConfirmedAt' =
         pg_catalog.jsonb_build_object(
           'ok', true,
           'flowId', '93000000-0000-4000-8000-000000000123',
           'state', 'completed',
           'outcome', 'completed',
           'destination', '/'
         )
       and pg_catalog.jsonb_typeof(
         value->'revokeConfirmedAt'
       ) = 'string'
      from oauth_test_results
     where name = 'cleanup_signout_123'
  ),
  'signout-required cleanup returns the exact six-key completed receipt'
);

select ok(
  (
    select not exists (
             select 1
               from auth.sessions
              where id =
                '93400000-0000-4000-8000-000000000122'
           )
       and not exists (
             select 1
               from auth.refresh_tokens
              where session_id =
                '93400000-0000-4000-8000-000000000122'
           )
       and exists (
             select 1
               from public.oauth_flow_intents
              where flow_id =
                '93000000-0000-4000-8000-000000000123'
                and state = 'completed'
                and action = 'signout'
                and revoke_confirmed_at is not null
                and finished_at >= revoke_confirmed_at
                and not session_fenced
           )
  ),
  'signout-required cleanup atomically deletes Auth authority and completes'
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000123',
    '93100000-0000-4000-8000-000000000123',
    '93200000-0000-4000-8000-000000000123',
    'google'
  ),
  (
    select value
      from oauth_test_results
     where name = 'cleanup_signout_123'
  ),
  'signout cleanup response-loss replay is exactly idempotent'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_124',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    false,
    'kakao',
    '/continue',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_124',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    'kakao',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_bind_124',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    'kakao',
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123',
    repeat('a', 64),
    repeat('b', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_finalize_124',
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    'kakao',
    '/continue',
    'completed',
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123',
    repeat('a', 64),
    repeat('b', 64),
    '/continue',
    'continue'
  )
);

select ok(
  (
    select state = 'completed'
       and not active
       and session_fenced
       and released_at is null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000124'
  )
  and (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(recovered)
           ) = 21
       and recovered->>'state' = 'completed'
       and recovered->>'action' = 'continue'
       and recovered->>'outcome' = 'completed'
       and recovered->>'active' = 'false'
       and recovered->'releasedAt' = 'null'::jsonb
      from (
        select public.recover_active_oauth_flow_by_observed_session(
          '93300000-0000-4000-8000-000000000123',
          '93400000-0000-4000-8000-000000000123'
        ) as recovered
      ) recovery
  ),
  'unreleased completed continue remains discoverable without active misclassification'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000124',
    null,
    null
  ),
  '{"ok":false,"error":"oauth_flow_authority_not_recoverable"}'::jsonb,
  'durable flow ID alone cannot release an unreleased completed continue fence'
);

select is(
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000128',
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123',
    false,
    'google',
    '/',
    repeat('3', 64),
    repeat('4', 64)
  ),
  '{"ok":false,"error":"oauth_flow_already_active"}'::jsonb,
  'unreleased completed continue target rejects a new begin'
);

select is(
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000121',
    '93100000-0000-4000-8000-000000000121',
    '93200000-0000-4000-8000-000000000121',
    'kakao',
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_target_session_already_active"}'::jsonb,
  'unreleased completed continue target rejects a new bind'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() - interval '40 days 3 minutes'
    as created_at
)
update public.oauth_flow_intents
   set created_at = stamp.created_at,
       expires_at = stamp.created_at + interval '10 minutes',
       claimed_at = stamp.created_at + interval '1 minute',
       finished_at = stamp.created_at + interval '2 minutes'
  from stamp
 where flow_id = '93000000-0000-4000-8000-000000000124';

select is(
  public.prune_oauth_flow_intents(500),
  pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 0,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 0,
    'unreleasedContinueBacklog', 1,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'maintenance retains every old non-anonymous unreleased continue fence'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_continue_124',
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    'kakao'
  )
);

select ok(
  (
    select value - 'revokeConfirmedAt' =
         pg_catalog.jsonb_build_object(
           'ok', true,
           'flowId', '93000000-0000-4000-8000-000000000124',
           'state', 'completed',
           'outcome', 'completed',
           'destination', '/'
         )
       and (
         select pg_catalog.count(*)::integer
           from pg_catalog.jsonb_object_keys(value)
       ) = 6
      from oauth_test_results
     where name = 'cleanup_continue_124'
  ),
  'unreleased continue cleanup returns the exact six-key completed receipt'
);

select ok(
  (
    select not exists (
             select 1
               from auth.sessions
              where id =
                '93400000-0000-4000-8000-000000000123'
           )
       and not exists (
             select 1
               from auth.refresh_tokens
              where session_id =
                '93400000-0000-4000-8000-000000000123'
           )
       and exists (
             select 1
               from public.oauth_flow_intents
              where flow_id =
                '93000000-0000-4000-8000-000000000124'
                and state = 'completed'
                and action = 'continue'
                and not active
                and not session_fenced
                and revoke_confirmed_at > finished_at
                and released_at >= revoke_confirmed_at
           )
  ),
  'continue cleanup preserves finalize time and atomically closes the release fence'
);

select is(
  public.recover_active_oauth_flow_by_observed_session(
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123'
  ),
  '{"ok":true,"state":"absent","active":false}'::jsonb,
  'completed cleanup removes the flow from observed-session discovery'
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    'kakao'
  ),
  (
    select value
      from oauth_test_results
     where name = 'cleanup_continue_124'
  ),
  'continue cleanup response-loss replay preserves its exact timestamp'
);

select is(
  public.release_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000124',
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_not_releasable"}'::jsonb,
  'cleanup-revoked continue can never replay as a normal release'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_status_124',
  public.read_oauth_flow_intent_status(
    '93000000-0000-4000-8000-000000000124',
    '93100000-0000-4000-8000-000000000124',
    '93200000-0000-4000-8000-000000000124',
    'kakao'
  )
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 19
       and value->'releasedAt' = (
         select pg_catalog.to_jsonb(released_at)
           from public.oauth_flow_intents
          where flow_id =
            '93000000-0000-4000-8000-000000000124'
       )
       and value->'revokeConfirmedAt' = (
         select pg_catalog.to_jsonb(revoke_confirmed_at)
           from public.oauth_flow_intents
          where flow_id =
            '93000000-0000-4000-8000-000000000124'
       )
      from oauth_test_results
     where name = 'cleanup_status_124'
  ),
  'proof-bound status survives target-cookie loss with both cleanup timestamps'
);

select is(
  public.rotate_oauth_flow_target_session_evidence(
    '93000000-0000-4000-8000-000000000124',
    '93300000-0000-4000-8000-000000000123',
    '93400000-0000-4000-8000-000000000123',
    repeat('a', 64),
    repeat('b', 64),
    repeat('c', 64),
    repeat('d', 64)
  ),
  '{"ok":false,"error":"oauth_flow_session_evidence_not_rotatable"}'::jsonb,
  'cleanup receipt remains authoritative after target token rotation is impossible'
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000001',
    '93200000-0000-4000-8000-000000000001',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_bound_target_not_revocable"}'::jsonb,
  'a normally released continue session can never be revoked by cleanup'
);

select ok(
  (
    select status->>'releasedAt' = released->>'releasedAt'
       and status->'revokeConfirmedAt' = 'null'::jsonb
      from (
        select public.read_oauth_flow_intent_status(
          '93000000-0000-4000-8000-000000000001',
          '93100000-0000-4000-8000-000000000001',
          '93200000-0000-4000-8000-000000000001',
          'google'
        ) as status
      ) s
      cross join (
        select value as released
          from oauth_test_results
         where name = 'release_continue'
      ) r
  ),
  'release commit ACK loss remains recoverable from status after cookie/token loss'
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(recovered)
           ) = 21
       and recovered->>'releasedAt' = released->>'releasedAt'
      from (
        select public.recover_oauth_flow_intent_authority(
          '93000000-0000-4000-8000-000000000001',
          '93300000-0000-4000-8000-000000000001',
          '93400000-0000-4000-8000-000000000001'
        ) as recovered
      ) recovery
      cross join (
        select value as released
          from oauth_test_results
         where name = 'release_continue'
      ) receipt
  ),
  'full recovered authority carries the same durable release ACK'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_125',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000125',
    '93100000-0000-4000-8000-000000000125',
    '93200000-0000-4000-8000-000000000125',
    true,
    'google',
    '/anonymous-cleanup',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_125',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000125',
    '93100000-0000-4000-8000-000000000125',
    '93200000-0000-4000-8000-000000000125',
    'google',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_bind_125',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000125',
    '93100000-0000-4000-8000-000000000125',
    '93200000-0000-4000-8000-000000000125',
    'google',
    '93300000-0000-4000-8000-000000000125',
    '93400000-0000-4000-8000-000000000125',
    repeat('a', 64),
    repeat('b', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_finalize_125',
  public.finalize_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000125',
    '93100000-0000-4000-8000-000000000125',
    '93200000-0000-4000-8000-000000000125',
    'google',
    '/anonymous-cleanup',
    'completed',
    '93300000-0000-4000-8000-000000000125',
    '93400000-0000-4000-8000-000000000125',
    repeat('a', 64),
    repeat('b', 64),
    '/anonymous-cleanup',
    'continue'
  )
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000125',
    '93100000-0000-4000-8000-000000000125',
    '93200000-0000-4000-8000-000000000125',
    'google'
  )->>'ok',
  'true',
  'anonymous unreleased continue can revoke its exact ghost target'
);

select is(
  public.consume_oauth_flow_intent_migration(
    '93000000-0000-4000-8000-000000000125',
    '93300000-0000-4000-8000-000000000125',
    '93400000-0000-4000-8000-000000000125',
    '93100000-0000-4000-8000-000000000125',
    repeat('a', 64),
    repeat('b', 64)
  ),
  '{"ok":false,"error":"oauth_flow_migration_not_consumable"}'::jsonb,
  'cleanup-winning revoke cannot subsequently consume migration'
);

select ok(
  (
    select migration_consumed_at is null
       and migration_result is null
       and revoke_confirmed_at is not null
       and released_at is not null
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000125'
  ),
  'cleanup-before-consume ordering preserves a non-consumable audit receipt'
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() - interval '40 days 3 minutes'
    as created_at
)
update public.oauth_flow_intents
   set created_at = stamp.created_at,
       expires_at = stamp.created_at + interval '10 minutes',
       claimed_at = stamp.created_at + interval '1 minute',
       finished_at = stamp.created_at + interval '2 minutes',
       revoke_confirmed_at =
         stamp.created_at + interval '3 minutes',
       released_at = stamp.created_at + interval '3 minutes'
  from stamp
 where flow_id = '93000000-0000-4000-8000-000000000125';

with stamp as materialized (
  select pg_catalog.clock_timestamp() as now_at
)
update public.oauth_anon_auth_cleanup_jobs
   set source_auth_created_at =
         stamp.now_at - interval '40 days',
       created_at = stamp.now_at - interval '39 days',
       armed_at = stamp.now_at - interval '36 days',
       status = 'completed',
       next_attempt_at = null,
       finished_at =
         stamp.now_at - interval '35 days 1 hour'
  from stamp
 where flow_id =
   '93000000-0000-4000-8000-000000000125';

select is(
  public.prune_oauth_flow_intents(500),
  pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 1,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 0,
    'unreleasedContinueBacklog', 0,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ),
  'released cleanup prunes consumed-impossible anonymous migration state'
);

select ok(
  not exists (
    select 1
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000125'
  ),
  'anonymous cleanup retains its audit row for 35 days and then prunes it'
);

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000050',
    '93100000-0000-4000-8000-000000000050',
    '93200000-0000-4000-8000-000000000050',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_bound_target_not_revocable"}'::jsonb,
  'unbound abandoned flow cannot authorize any Auth-session deletion'
);

insert into oauth_test_results(name, value)
values (
  'cleanup_begin_126',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000126',
    '93100000-0000-4000-8000-000000000126',
    '93200000-0000-4000-8000-000000000126',
    false,
    'kakao',
    '/',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_claim_126',
  public.claim_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000126',
    '93100000-0000-4000-8000-000000000126',
    '93200000-0000-4000-8000-000000000126',
    'kakao',
    repeat('1', 64),
    repeat('2', 64)
  )
);
insert into oauth_test_results(name, value)
values (
  'cleanup_bind_126',
  public.bind_oauth_flow_intent_target(
    '93000000-0000-4000-8000-000000000126',
    '93100000-0000-4000-8000-000000000126',
    '93200000-0000-4000-8000-000000000126',
    'kakao',
    '93300000-0000-4000-8000-000000000126',
    '93400000-0000-4000-8000-000000000126',
    repeat('a', 64),
    repeat('b', 64)
  )
);

select is(
  public.abandon_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000126',
    '93100000-0000-4000-8000-000000000126',
    '93200000-0000-4000-8000-000000000126',
    'kakao'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000126',
    'outcome', 'abandoned'
  ),
  'legacy abandon wrapper preserves its exact three-key response'
);

select ok(
  not exists (
    select 1
      from auth.sessions
     where id = '93400000-0000-4000-8000-000000000126'
  )
  and exists (
    select 1
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000126'
       and state = 'abandoned'
       and revoke_confirmed_at is not null
  ),
  'legacy bound abandon routes through exact Auth-session revocation'
);

select ok(
  pg_temp.oauth_test_check_rejected(
    $sql$
      update public.oauth_flow_intents
         set released_at = finished_at
       where flow_id =
         '93000000-0000-4000-8000-000000000124'
    $sql$
  ),
  'cleanup release boundary can never precede its post-finalize revoke'
);

select is(
  (
    select pg_catalog.count(*)::integer
      from public.oauth_flow_intents
     where flow_id in (
       '93000000-0000-4000-8000-000000000050',
       '93000000-0000-4000-8000-000000000073'
     )
       and state = 'claimed'
       and target_session_id is null
       and session_fenced
       and expires_at <= pg_catalog.clock_timestamp()
  ),
  0,
  'maintenance leaves no overdue unbound claimed recovery fence'
);

select ok(
  pg_temp.oauth_test_check_rejected(
    $sql$
      insert into public.oauth_flow_intents (
        flow_id, source_user_id, source_session_id,
        source_is_anonymous, provider, requested_next,
        state, created_at, expires_at, claimed_at, finished_at
      )
      values (
        '93000000-0000-4000-8000-000000000131',
        '93100000-0000-4000-8000-000000000131',
        '93200000-0000-4000-8000-000000000131',
        false, 'google', '/', 'abandoned',
        '2026-01-01 00:00:00+00',
        '2026-01-01 00:10:00+00',
        '2026-01-01 00:01:00+00',
        '2026-01-01 00:02:00+00'
      )
    $sql$
  ),
  'table invariant forbids an unbound claimed flow from being forged abandoned'
);

insert into oauth_test_results(name, value)
values (
  'recover_expiry_begin_129',
  public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000129',
    '93100000-0000-4000-8000-000000000129',
    '93200000-0000-4000-8000-000000000129',
    false,
    'google',
    '/expired-recovery',
    repeat('1', 64),
    repeat('2', 64)
  )
);

with stamp as materialized (
  select pg_catalog.clock_timestamp() - interval '20 minutes'
    as created_at
)
update public.oauth_flow_intents
   set created_at = stamp.created_at,
       expires_at = stamp.created_at + interval '10 minutes'
  from stamp
 where flow_id = '93000000-0000-4000-8000-000000000129';

insert into oauth_test_results(name, value)
values (
  'recover_expiry_129',
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000129',
    null,
    null
  )
);

select is(
  (
    select value
      from oauth_test_results
     where name = 'recover_expiry_129'
  ),
  pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', '93000000-0000-4000-8000-000000000129',
    'state', 'expired',
    'active', false
  ),
  'only-flow-ID recovery atomically expires an overdue pending lease'
);

select ok(
  (
    select state = 'expired'
       and not active
       and not session_fenced
       and claimed_at is null
       and finished_at >= expires_at
      from public.oauth_flow_intents
     where flow_id =
       '93000000-0000-4000-8000-000000000129'
  ),
  'only-ID expiry persists the strict ordered terminal shape'
);

select is(
  public.recover_oauth_flow_intent_authority(
    '93000000-0000-4000-8000-000000000129',
    null,
    null
  ),
  (
    select value
      from oauth_test_results
     where name = 'recover_expiry_129'
  ),
  'only-ID expiry response-loss replay is exactly idempotent'
);

select ok(
  (
    select (
             select pg_catalog.count(*)::integer
               from pg_catalog.jsonb_object_keys(value)
           ) = 21
       and value->>'state' = 'expired'
       and value->>'outcome' = 'expired'
       and value->>'active' = 'false'
      from (
        select public.recover_oauth_flow_intent_authority(
          '93000000-0000-4000-8000-000000000129',
          '93100000-0000-4000-8000-000000000129',
          '93200000-0000-4000-8000-000000000129'
        ) as value
      ) recovered
  ),
  'exact observed source gets the full expired receipt after only-ID convergence'
);

with begun as materialized (
  select public.begin_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000130',
    '93100000-0000-4000-8000-000000000129',
    '93200000-0000-4000-8000-000000000129',
    false,
    'kakao',
    '/',
    repeat('3', 64),
    repeat('4', 64)
  ) as value
)
select is(
  public.cancel_oauth_flow_intent(
    '93000000-0000-4000-8000-000000000130',
    '93100000-0000-4000-8000-000000000129',
    '93200000-0000-4000-8000-000000000129',
    'kakao'
  )->>'outcome',
  'cancelled',
  'only-ID expiry releases the source fence for a new flow'
)
from begun
where begun.value->>'ok' = 'true';

insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values (
  '93300000-0000-4000-8000-000000000132',
  'oauth-shared-fence-target@test.local',
  false,
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);
insert into auth.sessions(id, user_id, created_at, updated_at)
values (
  '93400000-0000-4000-8000-000000000132',
  '93300000-0000-4000-8000-000000000132',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

with rows(flow_id, source_user_id, source_session_id) as (
  values
    (
      '93000000-0000-4000-8000-000000000132'::uuid,
      '93100000-0000-4000-8000-000000000132'::uuid,
      '93200000-0000-4000-8000-000000000132'::uuid
    ),
    (
      '93000000-0000-4000-8000-000000000133'::uuid,
      '93100000-0000-4000-8000-000000000133'::uuid,
      '93200000-0000-4000-8000-000000000133'::uuid
    )
),
stamp as (
  select pg_catalog.clock_timestamp() as now_at
)
insert into public.oauth_flow_intents (
  flow_id, source_user_id, source_session_id,
  source_is_anonymous, provider, requested_next,
  state, target_user_id, target_session_id,
  target_access_token_sha256, target_refresh_token_sha256,
  destination, action, created_at, expires_at,
  claimed_at, finished_at
)
select
  rows.flow_id, rows.source_user_id, rows.source_session_id,
  false, 'google', '/', 'completed',
  '93300000-0000-4000-8000-000000000132',
  '93400000-0000-4000-8000-000000000132',
  repeat('a', 64), repeat('b', 64),
  '/', 'continue', stamp.now_at,
  stamp.now_at + interval '10 minutes',
  stamp.now_at, stamp.now_at
from rows
cross join stamp;

select is(
  public.revoke_bound_oauth_flow_target_session(
    '93000000-0000-4000-8000-000000000132',
    '93100000-0000-4000-8000-000000000132',
    '93200000-0000-4000-8000-000000000132',
    'google'
  ),
  '{"ok":false,"error":"oauth_flow_bound_target_session_in_use"}'::jsonb,
  'cleanup fails closed when another unreleased row fences the same target'
);

select ok(
  exists (
    select 1
      from auth.sessions
     where id = '93400000-0000-4000-8000-000000000132'
       and user_id = '93300000-0000-4000-8000-000000000132'
  )
  and (
    select pg_catalog.count(*) = 2
      from public.oauth_flow_intents
     where flow_id in (
       '93000000-0000-4000-8000-000000000132',
       '93000000-0000-4000-8000-000000000133'
     )
       and session_fenced
       and revoke_confirmed_at is null
  ),
  'shared-fence conflict deletes no Auth or ledger authority'
);

-- A deleted auth.sessions row does not invalidate a signed access JWT until
-- exp. The common client-policy helper must make row existence an immediate,
-- indexed authorization condition and reject every malformed/reused variant.
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '93100000-0000-4000-8000-000000000190',
    'oauth-live-session-owner@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93100000-0000-4000-8000-000000000191',
    'oauth-live-session-other@test.local',
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values
  (
    '93200000-0000-4000-8000-000000000190',
    '93100000-0000-4000-8000-000000000190',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '93200000-0000-4000-8000-000000000191',
    '93100000-0000-4000-8000-000000000191',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

insert into public.member_accounts(user_id, gen_credits)
values (
  '93100000-0000-4000-8000-000000000190',
  0
);
insert into public.dolls(id, owner_id, image_url)
values (
  '93500000-0000-4000-8000-000000000190',
  '93100000-0000-4000-8000-000000000190',
  'https://example.test/oauth-live-session.png'
);
insert into public.user_badges(owner_id, badge_id)
values (
  '93100000-0000-4000-8000-000000000190',
  'qa-oauth-live-session'
);

select set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '93100000-0000-4000-8000-000000000190',
    'role', 'authenticated',
    'session_id', '93200000-0000-4000-8000-000000000190'
  )::text,
  true
);
set local role authenticated;
with updated as (
  update public.profiles
     set display_name = 'live-session-owner'
   where id = auth.uid()
  returning 1
)
select ok(
  public.oauth_current_auth_session_live()
  and (select pg_catalog.count(*) from updated) = 1
  and (
    select pg_catalog.count(*)
      from public.dolls
  ) = 1
  and (
    select pg_catalog.count(*)
      from public.member_accounts
  ) = 1
  and (
    select pg_catalog.count(*)
      from public.user_badges
  ) = 1,
  'an exact live JWT session can read and mutate every private self surface'
);
reset role;

delete from auth.sessions
 where id = '93200000-0000-4000-8000-000000000190';
set local role authenticated;
with updated as (
  update public.profiles
     set display_name = 'revoked-session-owner'
   where id = auth.uid()
  returning 1
)
select ok(
  not public.oauth_current_auth_session_live()
  and (select pg_catalog.count(*) from updated) = 0
  and (
    select pg_catalog.count(*)
      from public.dolls
  ) = 0
  and (
    select pg_catalog.count(*)
      from public.member_accounts
  ) = 0
  and (
    select pg_catalog.count(*)
      from public.user_badges
  ) = 0,
  'the same unexpired JWT loses every private self surface immediately after session deletion'
);
reset role;

select set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '93100000-0000-4000-8000-000000000190',
    'role', 'authenticated',
    'session_id', '93200000-0000-4000-8000-000000000191'
  )::text,
  true
);
set local role authenticated;
select ok(
  not public.oauth_current_auth_session_live(),
  'a live session belonging to a different JWT subject is rejected'
);
reset role;

select set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '93100000-0000-4000-8000-000000000190',
    'role', 'authenticated',
    'session_id', 'not-a-uuid'
  )::text,
  true
);
set local role authenticated;
select ok(
  not public.oauth_current_auth_session_live(),
  'a malformed JWT session_id returns false without a cast exception'
);
reset role;

select set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '93100000-0000-4000-8000-000000000190',
    'role', 'authenticated'
  )::text,
  true
);
set local role authenticated;
select ok(
  not public.oauth_current_auth_session_live(),
  'an absent JWT session_id returns false'
);
reset role;

insert into auth.sessions(id, user_id, created_at, updated_at)
values (
  '93200000-0000-4000-8000-000000000192',
  '93100000-0000-4000-8000-000000000190',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);
insert into public.oauth_auth_session_id_tombstones(
  session_id,
  tombstoned_at,
  reason
)
values (
  '93200000-0000-4000-8000-000000000192',
  pg_catalog.clock_timestamp(),
  'flow_target'
);
select set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '93100000-0000-4000-8000-000000000190',
    'role', 'authenticated',
    'session_id', '93200000-0000-4000-8000-000000000192'
  )::text,
  true
);
set local role authenticated;
select ok(
  not public.oauth_current_auth_session_live(),
  'a historical session tombstone overrides a concurrently retained Auth row'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{}'::jsonb::text,
  true
);
set local role anon;
select is(
  (
    select
      (select pg_catalog.count(*) from public.dolls)
      + (select pg_catalog.count(*) from public.member_accounts)
      + (select pg_catalog.count(*) from public.user_badges)
  )::integer,
  0,
  'anon receives empty private tables without helper permission errors'
);
reset role;

delete from auth.sessions
 where id = '93200000-0000-4000-8000-000000000192';
select throws_ok(
  $$
    insert into auth.sessions(id, user_id, created_at, updated_at)
    values (
      '93200000-0000-4000-8000-000000000192',
      '93100000-0000-4000-8000-000000000190',
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    )
  $$,
  '23514',
  'migration_target_session_id_tombstoned',
  'a tombstoned Auth session UUID can never be recreated'
);

select * from finish();
rollback;
