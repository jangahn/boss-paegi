-- 0082 관리자 크레딧 조정 exactly-once/복구 계약.

begin;
select plan(31);

select has_table(
  'public',
  'admin_operation_receipts',
  'admin operation receipt table exists'
);
select has_function(
  'public',
  'admin_adjust_credits',
  array['uuid','uuid','integer','text','uuid'],
  'idempotent admin adjustment RPC exists'
);
select has_function(
  'public',
  'get_admin_credit_adjust_receipt',
  array['uuid','uuid','uuid'],
  'adjustment recovery RPC exists'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)'::regprocedure
  ),
  'adjustment RPC is SECURITY DEFINER'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)'::regprocedure
  ),
  'recovery RPC is SECURITY DEFINER'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'service role can execute both RPCs'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'browser roles cannot execute adjustment/recovery RPCs'
);
select ok(
  pg_catalog.to_regprocedure(
    'public.admin_adjust_credits(uuid,uuid,integer,text)'
  ) is null,
  'legacy adjustment RPC entry point is absent'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.admin_operation_receipts'::regclass
  ),
  'receipt table has RLS enabled'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_policy
     where polrelid = 'public.admin_operation_receipts'::regclass
  ),
  0,
  'receipt table has no client policy'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.admin_operation_receipts',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.admin_operation_receipts',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.admin_operation_receipts',
    'DELETE'
  ),
  'service role cannot bypass receipt RPC writes'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.admin_operation_receipts'::regclass
       and tgname = 'trg_admin_operation_receipts_freeze'
       and tgenabled = 'O'
       and not tgisinternal
  ),
  'receipt rows are append-only'
);

create temporary table admin_adjust_ctx (
  admin_id uuid not null,
  target_id uuid not null,
  request_id uuid not null,
  aborted_id uuid not null
) on commit drop;

insert into admin_adjust_ctx
select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid();

insert into auth.users (id, email)
select admin_id, 'admin-adjust-' || admin_id || '@test.local'
  from admin_adjust_ctx
union all
select target_id, 'target-adjust-' || target_id || '@test.local'
  from admin_adjust_ctx;

insert into public.member_accounts (user_id, gen_credits, is_admin)
select admin_id, 0, true from admin_adjust_ctx
on conflict (user_id) do update
  set is_admin = excluded.is_admin,
      gen_credits = excluded.gen_credits;

insert into public.member_accounts (user_id, gen_credits, is_admin)
select target_id, 2, false from admin_adjust_ctx
on conflict (user_id) do update
  set is_admin = excluded.is_admin,
      gen_credits = excluded.gen_credits;

insert into public.credit_lots (
  user_id,
  source,
  qty,
  granted_at,
  expires_at
)
select target_id, 'legacy_free', 2, now(), now() + interval '1 year'
  from admin_adjust_ctx;

select is(
  (
    select public.admin_adjust_credits(
      admin_id,
      target_id,
      3,
      'exactly once grant',
      request_id
    )->>'after'
      from admin_adjust_ctx
  ),
  '5',
  'first adjustment applies once'
);
select is(
  (
    select public.admin_adjust_credits(
      admin_id,
      target_id,
      3,
      'exactly once grant',
      request_id
    )->>'idempotent'
      from admin_adjust_ctx
  ),
  'true',
  'same request replay returns the stored result'
);
select is(
  (
    select ma.gen_credits
      from public.member_accounts ma
      join admin_adjust_ctx c on c.target_id = ma.user_id
  ),
  5,
  'same request replay does not double grant'
);
select is(
  (
    select count(*)::int
      from public.admin_actions_ledger l
      join admin_adjust_ctx c
        on l.metadata->>'request_id' = c.request_id::text
  ),
  1,
  'same request produces exactly one financial audit row'
);
select is(
  (
    select count(*)::int
      from public.credit_lots l
      join admin_adjust_ctx c on c.target_id = l.user_id
     where l.source = 'cs_grant'
       and l.qty = 3
  ),
  1,
  'same request produces exactly one grant lot'
);
select is(
  (
    select public.get_admin_credit_adjust_receipt(
      admin_id,
      request_id,
      target_id
    )#>>'{result,after}'
      from admin_adjust_ctx
  ),
  '5',
  'recovery returns the committed result'
);
select throws_ok(
  format(
    'select public.get_admin_credit_adjust_receipt(%L::uuid,%L::uuid,%L::uuid)',
    admin_id,
    request_id,
    admin_id
  ),
  'P0001',
  'idempotency_conflict',
  'recovery cannot replay a receipt through a different target context'
)
from admin_adjust_ctx;
select throws_ok(
  format(
    'select public.admin_adjust_credits(%L::uuid,%L::uuid,4,%L,%L::uuid)',
    admin_id,
    target_id,
    'exactly once grant',
    request_id
  ),
  'P0001',
  'idempotency_conflict',
  'same request id with a changed delta is rejected'
)
from admin_adjust_ctx;
select throws_ok(
  format(
    'select public.admin_adjust_credits(%L::uuid,%L::uuid,3,%L,%L::uuid)',
    admin_id,
    target_id,
    'changed reason',
    request_id
  ),
  'P0001',
  'idempotency_conflict',
  'same request id with a changed reason is rejected'
)
from admin_adjust_ctx;
select throws_ok(
  format(
    'select public.get_admin_credit_adjust_receipt(%L::uuid,%L::uuid,%L::uuid)',
    admin_id,
    gen_random_uuid(),
    gen_random_uuid()
  ),
  'P0001',
  'account_not_found',
  'recovery cannot create a tombstone for an unknown target'
)
from admin_adjust_ctx;

select is(
  (
    select public.get_admin_credit_adjust_receipt(
      admin_id,
      aborted_id,
      target_id
    )->>'aborted'
      from admin_adjust_ctx
  ),
  'true',
  'recovery-before-POST creates an aborted tombstone'
);
select throws_ok(
  format(
    'select public.admin_adjust_credits(%L::uuid,%L::uuid,3,%L,%L::uuid)',
    admin_id,
    target_id,
    'late reordered request',
    aborted_id
  ),
  'P0001',
  'request_aborted',
  'late POST cannot apply after recovery declared it absent'
)
from admin_adjust_ctx;
select is(
  (
    select ma.gen_credits
      from public.member_accounts ma
      join admin_adjust_ctx c on c.target_id = ma.user_id
  ),
  5,
  'aborted late POST leaves credits unchanged'
);
select is(
  (
    select count(*)::int
      from public.admin_operation_receipts r
      join admin_adjust_ctx c on c.aborted_id = r.request_id
     where r.state = 'aborted'
       and r.target_user_id = c.target_id
       and r.request_payload is null
       and r.result is null
  ),
  1,
  'aborted recovery marker has the strict empty shape'
);

select throws_ok(
  format(
    'select public.admin_adjust_credits(%L::uuid,%L::uuid,1.0::int,%L,null::uuid)',
    admin_id,
    target_id,
    'missing request id'
  ),
  'P0001',
  'request_id_invalid',
  'null request id is rejected'
)
from admin_adjust_ctx;
select throws_ok(
  format(
    'select public.admin_adjust_credits(%L::uuid,%L::uuid,1,%L,%L::uuid)',
    target_id,
    target_id,
    'non admin caller',
    gen_random_uuid()
  ),
  'P0001',
  'not_admin',
  'RPC independently verifies admin authority'
)
from admin_adjust_ctx;
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.bp_0084_admin_adjust_credits_impl(uuid,uuid,integer,text,uuid)'::regprocedure
    )
  ),
  'from public\.profiles[\s\S]*for key share[\s\S]*from public\.member_accounts[\s\S]*for update',
  'adjustment follows profile-before-member account deletion lock order'
);
update public.profiles p
   set deleted_at = now()
  from admin_adjust_ctx c
 where p.id = c.target_id;
select throws_ok(
  format(
    'select public.admin_adjust_credits(%L::uuid,%L::uuid,1,%L,%L::uuid)',
    admin_id,
    target_id,
    'deleted target grant',
    gen_random_uuid()
  ),
  'P0001',
  'account_deleted',
  'new adjustment cannot resurrect credits after account deletion'
)
from admin_adjust_ctx;
select throws_ok(
  format(
    'update public.admin_operation_receipts set state = %L where request_id = %L::uuid',
    'aborted',
    request_id
  ),
  'P0001',
  'admin_operation_receipts_append_only_violation',
  'completed receipt cannot be mutated'
)
from admin_adjust_ctx;

select * from finish();
rollback;
