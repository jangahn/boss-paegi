-- 0095 post-contract closure for independently inventoried service RPCs.

begin;
select plan(16);

create temporary table qa_rpc_surface (
  signature text primary key,
  classification text not null check (
    classification in ('active', 'internal_dependency', 'operational', 'closed')
  )
);

insert into qa_rpc_surface(signature, classification)
values
  ('public.admin_dismiss_report(uuid,uuid,text)', 'closed'),
  (
    'public.admin_find_withdrawn_by_email(text)',
    'active'
  ),
  (
    'public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)',
    'closed'
  ),
  (
    'public.admin_unreconciled_canceled_orders(integer)',
    'active'
  ),
  (
    'public.claim_generation_pick_materialization(uuid,uuid,uuid)',
    'active'
  ),
  (
    'public.claim_storage_object_cleanup(uuid,integer)',
    'active'
  ),
  (
    'public.claim_storage_upload_cleanup(integer)',
    'active'
  ),
  (
    'public.finish_storage_object_cleanup(uuid,uuid,integer,boolean,text)',
    'active'
  ),
  (
    'public.finish_storage_upload_cleanup(uuid,uuid,integer,boolean,text)',
    'active'
  ),
  ('public.get_user_generations(uuid,integer,integer)', 'active'),
  ('public.legal_sections_valid(jsonb)', 'closed'),
  ('public.like_escape(text)', 'internal_dependency'),
  (
    'public.list_generation_cost_reconciliation_issues(integer)',
    'operational'
  ),
  ('public.privacy_retention_status()', 'operational'),
  (
    'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)',
    'closed'
  ),
  (
    'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)',
    'closed'
  ),
  (
    'public.release_generation_artifact_write(uuid,uuid)',
    'active'
  ),
  (
    'public.release_generation_preflight(uuid,uuid,uuid,text)',
    'closed'
  ),
  (
    'public.resolve_generation_cost_reconciliation_issue(uuid,text)',
    'operational'
  ),
  (
    'public.scrub_generation_submit_provider_outputs(uuid,uuid)',
    'active'
  ),
  ('public.search_members(text,integer)', 'active'),
  ('public.search_orders(text,text,integer,integer)', 'active');

select is(
  (
    select count(*)::integer
      from qa_rpc_surface
     where pg_catalog.to_regprocedure(signature) is not null
  ),
  22,
  'the independently reconstructed unreferenced-RPC inventory is exact'
);

select is(
  (
    select count(*)::integer
      from qa_rpc_surface
     where has_function_privilege('anon', signature, 'EXECUTE')
  ),
  0,
  'none of the audited service surfaces is anon-callable'
);

select is(
  (
    select count(*)::integer
      from qa_rpc_surface
     where has_function_privilege('authenticated', signature, 'EXECUTE')
  ),
  0,
  'none of the audited service surfaces is authenticated-callable'
);

select is(
  (
    select pg_catalog.array_agg(signature order by signature)
      from qa_rpc_surface
     where has_function_privilege('service_role', signature, 'EXECUTE')
  ),
  (
    select pg_catalog.array_agg(signature order by signature)
      from qa_rpc_surface
     where classification <> 'closed'
  ),
  'service_role retains only active, operational, and required helper surfaces'
);

select is(
  (
    select count(*)::integer
      from qa_rpc_surface
     where classification = 'closed'
       and has_function_privilege('service_role', signature, 'EXECUTE')
  ),
  0,
  'all six dead direct RPC surfaces are closed'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        p.proacl,
        pg_catalog.acldefault('f', p.proowner)
      )
    ) acl
    where p.oid = any(
      array(
        select pg_catalog.to_regprocedure(signature)
        from qa_rpc_surface
        where classification = 'closed'
      )
    )
      and acl.privilege_type = 'EXECUTE'
      and acl.grantee <> p.proowner
  ),
  0,
  'closed RPCs have no unexpected non-owner EXECUTE ACL'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.admin_moderation_action_idempotent(text,uuid,uuid,text,text,bigint,uuid)',
    'EXECUTE'
  ),
  'the strict moderation replacement remains callable'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  ),
  'the provider-evidence settlement replacement remains callable'
);

insert into auth.users(id, email)
values (
  '96000000-0000-4000-8000-000000000001',
  'qa-closed-rpc-admin@example.test'
);
insert into public.member_accounts(user_id, gen_credits, is_admin)
values ('96000000-0000-4000-8000-000000000001', 0, true)
on conflict (user_id) do update set is_admin = true;

set local role service_role;

select throws_ok(
  $$ select public.legal_sections_valid('[]'::jsonb) $$,
  '42501',
  'permission denied for function legal_sections_valid',
  'the internal legal validator is no longer a direct service RPC'
);

select throws_ok(
  $$
    select public.admin_save_legal_draft(
      'privacy',
      'QA invalid draft',
      '{}'::jsonb,
      null,
      null,
      '96000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000002',
      null
    )
  $$,
  'P0001',
  'invalid_sections',
  'strict SECURITY DEFINER legal mutations still invoke the validator'
);

select lives_ok(
  $$ select * from public.search_members('literal_%', 1) $$,
  'member search retains its SECURITY INVOKER escape dependency'
);

select lives_ok(
  $$ select * from public.search_orders('literal_%', null, 1, 0) $$,
  'order search retains its SECURITY INVOKER escape dependency'
);

select ok(
  (
    select status is not null
       and pg_catalog.jsonb_typeof(status) = 'object'
      from (
        select public.privacy_retention_status() as status
      ) q
  ),
  'the operational privacy status wrapper returns a JSON object'
);

select throws_ok(
  $$ select * from public.list_generation_cost_reconciliation_issues(0) $$,
  '22023',
  'invalid_generation_cost_reconciliation_limit',
  'the operational reconciliation list rejects an unbounded limit'
);

select lives_ok(
  $$ select * from public.list_generation_cost_reconciliation_issues(1) $$,
  'the bounded operational reconciliation list remains callable'
);

select throws_ok(
  $$
    select public.admin_dismiss_report(
      '96000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000003',
      'closed legacy path'
    )
  $$,
  '42501',
  'permission denied for function admin_dismiss_report',
  'the legacy non-idempotent moderation mutation cannot be called'
);

select * from finish();
rollback;
