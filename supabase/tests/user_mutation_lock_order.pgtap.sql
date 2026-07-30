-- 0084 global user-mutation lock graph: catalog, ACL, call graph, and behavior.

begin;
select plan(35);

create temporary table lock_rpc_manifest(
  signature text primary key,
  lock_mode text not null
) on commit drop;

insert into lock_rpc_manifest(signature, lock_mode) values
  ('public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)', 'object_user'),
  ('public.mark_paid_and_grant(uuid,text,integer,jsonb,timestamptz,text)', 'object_user'),
  ('public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)', 'object_user'),
  ('public.admin_adjust_credits(uuid,uuid,integer,text,uuid)', 'object_user'),
  ('public.create_generation_and_consume(uuid,text)', 'user'),
  ('public.create_generation_row(uuid,text)', 'user'),
  ('public.mark_generation_failed_and_refund(uuid,text,integer)', 'object_user'),
  ('public.expire_generation(uuid,integer)', 'object_user'),
  ('public.reopen_generation_artifact_cleanup(uuid)', 'object_user'),
  ('public.complete_generation_artifact_cleanup(uuid,text)', 'object_user'),
  ('public.admin_refund_begin(uuid,uuid,uuid,uuid,integer,text,timestamptz,text)', 'object_user'),
  ('public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)', 'object_user'),
  ('public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)', 'object_user'),
  ('public.admin_refund_commit(uuid)', 'object_user'),
  ('public.admin_refund_switch_to_manual(uuid,uuid,text,bigint,jsonb,text)', 'object_user'),
  ('public.admin_refund_commit_manual(uuid,uuid,text,text,uuid)', 'object_user'),
  ('public.admin_refund_release(uuid,uuid,text)', 'object_user'),
  ('public.admin_refund_replan_pre_pg(uuid,uuid,text,boolean)', 'object_user'),
  ('public.admin_refund_replan_after_pg(uuid,uuid,text,bigint,jsonb)', 'object_user'),
  ('public.cancel_intent_begin(uuid,uuid,timestamptz,text)', 'object_user'),
  ('public.cancel_intent_resolve(uuid,uuid,integer)', 'object_user'),
  ('public.record_payment_cancellation_observation(uuid,text,text,bigint,timestamptz,timestamptz,jsonb)', 'object_user'),
  ('public.resolve_external_cancellation(text,uuid,text,integer)', 'object_user'),
  ('public.resolve_external_cancellation_auto_full(uuid)', 'object_user'),
  ('public.admin_resolve_reconciliation_issue(uuid,uuid,text,text)', 'object_user'),
  ('public.mark_order_failed(uuid,text,text,jsonb)', 'object_user'),
  ('public.mark_order_canceled_unpaid(uuid,text,text,jsonb)', 'object_user'),
  ('public.admin_cancel_order(uuid,uuid,boolean,text,boolean)', 'object_user'),
  ('public.admin_cancel_order(uuid,uuid,boolean,text)', 'object_user'),
  ('public.sweep_expired(integer)', 'many'),
  ('public.admin_soft_delete_account(uuid)', 'user'),
  ('public.create_or_update_member_consent(uuid,integer,boolean,boolean,integer,boolean,integer)', 'object_user'),
  ('public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)', 'object_user'),
  ('public.sync_active_member_oauth_profile(uuid,text,text,text)', 'user'),
  ('public.admin_reactivate_account(uuid,uuid,text,text)', 'object_user'),
  ('public.admin_ban_member(uuid,uuid,text)', 'user'),
  ('public.admin_unban_member(uuid,uuid,text)', 'user'),
  ('public.request_avatar_clear(uuid)', 'user'),
  ('public.request_avatar_replace(uuid,text,text)', 'user'),
  ('public.reassign_anon_data(uuid,uuid)', 'object_many'),
  ('public.record_reviewer_provision_auth(uuid,uuid,integer,uuid)', 'object'),
  ('public.finalize_reviewer_provision(uuid,uuid,integer)', 'object_user');

select has_function(
  'public', 'bp_user_mutation_lock', array['uuid'],
  'canonical user mutation lock exists'
);
select has_function(
  'public', 'bp_user_mutation_lock_many', array['uuid[]'],
  'sorted multi-user mutation lock exists'
);
select has_function(
  'public', 'bp_mutation_object_lock', array['text','text'],
  'immutable object mutation lock exists'
);
select is(
  (
    select count(*)::integer
      from lock_rpc_manifest m
     where pg_catalog.to_regprocedure(m.signature) is not null
  ),
  42,
  'all 42 external mutation signatures remain present'
);
select ok(
  not exists (
    select 1
      from lock_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where not p.prosecdef
  ),
  'all external mutation wrappers remain SECURITY DEFINER'
);
select ok(
  not exists (
    select 1
      from lock_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where (
       m.signature in (
         'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
         'public.admin_reactivate_account(uuid,uuid,text,text)',
         'public.admin_ban_member(uuid,uuid,text)',
         'public.admin_unban_member(uuid,uuid,text)'
       )
       and pg_catalog.has_function_privilege(
         'service_role', p.oid, 'EXECUTE'
       )
     ) or (
       m.signature not in (
         'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
         'public.admin_reactivate_account(uuid,uuid,text,text)',
         'public.admin_ban_member(uuid,uuid,text)',
         'public.admin_unban_member(uuid,uuid,text)'
       )
       and not pg_catalog.has_function_privilege(
         'service_role', p.oid, 'EXECUTE'
       )
     )
  ),
  'service_role uses permanent receipt-bearing replacements for superseded mutations'
);
select ok(
  not exists (
    select 1
      from lock_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege(
             'authenticated', p.oid, 'EXECUTE'
           )
  ),
  'browser roles cannot execute any external mutation wrapper'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.admin_cancel_order(uuid,uuid,boolean,text,boolean)'::regprocedure
    ),
    'portone_cancellation_requires_provider_observation'
  ) > 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.admin_cancel_order(uuid,uuid,boolean,text)'::regprocedure
    ),
    'portone_cancellation_requires_provider_observation'
  ) > 0,
  'both administrative cancellation overloads reject PortOne local terminalization'
);
select ok(
  not exists (
    select 1
      from lock_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where p.proconfig is distinct from array['search_path=""']::text[]
  ),
  'every external mutation wrapper has an empty search_path'
);
select is(
  (
    select count(*)::integer
      from lock_rpc_manifest m
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(m.signature)
     where p.pronargdefaults > 0
  ),
  9,
  'the exact default-bearing external overload set is preserved'
);
select ok(
  (
    select pg_catalog.pg_get_expr(p.proargdefaults, 0::oid)
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_refund_begin(uuid,uuid,uuid,uuid,integer,text,timestamptz,text)'::regprocedure
  ) = '''portone_cancel''::text'
  and (
    select pg_catalog.pg_get_expr(p.proargdefaults, 0::oid)
      from pg_catalog.pg_proc p
     where p.oid = 'public.sweep_expired(integer)'::regprocedure
  ) = '500',
  'refund rail and sweep defaults are unchanged'
);
select ok(
  not exists (
    select 1
      from (
        select
          m.signature,
          m.lock_mode,
          pg_catalog.pg_get_functiondef(p.oid) as def
        from lock_rpc_manifest m
        join pg_catalog.pg_proc p
          on p.oid = pg_catalog.to_regprocedure(m.signature)
      ) wrapped
      cross join lateral (
        select
          greatest(
            pg_catalog.strpos(
              wrapped.def, 'public.bp_mutation_object_lock'
            ),
            pg_catalog.strpos(
              wrapped.def,
              'public.bp_0084_credit_adjust_request_lock'
            ),
            pg_catalog.strpos(
              wrapped.def, 'public.bp_0084_legal_consent_locks'
            ),
            pg_catalog.strpos(
              wrapped.def, 'public.bp_0084_anon_reassign_locks'
            )
          ) as object_pos,
          case
            when wrapped.lock_mode in ('many', 'object_many') then
              pg_catalog.strpos(
                wrapped.def, 'public.bp_user_mutation_lock_many'
              )
            else
              pg_catalog.strpos(
                wrapped.def, 'public.bp_user_mutation_lock'
              )
          end as user_pos,
          pg_catalog.strpos(wrapped.def, '_impl(') as impl_pos
      ) positions
     where (
       wrapped.lock_mode in ('object_user', 'object_many')
       and not (
         positions.object_pos > 0
         and positions.user_pos > positions.object_pos
         and positions.impl_pos > positions.user_pos
       )
     ) or (
       wrapped.lock_mode in ('user', 'many')
       and not (
         positions.user_pos > 0
         and positions.impl_pos > positions.user_pos
       )
     ) or (
       wrapped.lock_mode = 'object'
       and not (
         positions.object_pos > 0
         and positions.impl_pos > positions.object_pos
         and positions.user_pos = 0
       )
     )
  ),
  'every wrapper follows object(s) -> sorted user(s) -> isolated impl'
);
select ok(
  not exists (
    select 1
      from (
        select
          m.signature,
          m.lock_mode,
          pg_catalog.lower(
            pg_catalog.pg_get_functiondef(
              pg_catalog.to_regprocedure(m.signature)
            )
          ) as def
        from lock_rpc_manifest m
      ) wrapped
      cross join lateral (
        select
          greatest(
            pg_catalog.strpos(
              wrapped.def, 'public.bp_mutation_object_lock'
            ),
            pg_catalog.strpos(
              wrapped.def,
              'public.bp_0084_credit_adjust_request_lock'
            ),
            pg_catalog.strpos(
              wrapped.def, 'public.bp_0084_legal_consent_locks'
            ),
            pg_catalog.strpos(
              wrapped.def, 'public.bp_0084_anon_reassign_locks'
            )
          ) as object_pos,
          case
            when wrapped.lock_mode in ('many', 'object_many') then
              pg_catalog.strpos(
                wrapped.def, 'public.bp_user_mutation_lock_many'
              )
            else
              pg_catalog.strpos(
                wrapped.def, 'public.bp_user_mutation_lock'
              )
          end as user_pos,
          coalesce(
            least(
              nullif(
                pg_catalog.strpos(wrapped.def, 'for update'),
                0
              ),
              nullif(
                pg_catalog.strpos(wrapped.def, 'for key share'),
                0
              ),
              nullif(
                pg_catalog.strpos(wrapped.def, 'for no key update'),
                0
              ),
              nullif(
                pg_catalog.strpos(wrapped.def, 'for share'),
                0
              )
            ),
            0
          ) as first_row_lock_pos
      ) positions
      cross join lateral (
        select case
          when wrapped.lock_mode = 'object' then positions.object_pos
          else positions.user_pos
        end as advisory_boundary_pos
      ) boundary
     where positions.first_row_lock_pos > 0
       and (
         boundary.advisory_boundary_pos = 0
         or positions.first_row_lock_pos <=
              boundary.advisory_boundary_pos
       )
  ),
  'no wrapper takes a row lock before the advisory boundary'
);
select ok(
  not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (
         p.proname like 'bp\_0084\_%\_impl' escape '\'
         or p.proname in (
           'bp_user_mutation_lock',
           'bp_user_mutation_lock_many',
           'bp_mutation_object_lock',
           'bp_0084_credit_adjust_request_lock',
           'bp_0084_legal_consent_locks',
           'bp_0084_anon_reassign_locks'
         )
       )
       and (
         pg_catalog.has_function_privilege(
           'service_role', p.oid, 'EXECUTE'
         )
         or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
         or pg_catalog.has_function_privilege(
           'authenticated', p.oid, 'EXECUTE'
         )
       )
  ),
  'isolated implementations and lock helpers have no client execute path'
);
select is(
  pg_catalog.to_regprocedure(
    'public.admin_adjust_credits(uuid,uuid,integer,text)'
  ),
  null::regprocedure,
  'legacy four-argument credit adjustment bypass is absent'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.bp_user_mutation_lock(uuid)'::regprocedure
    ),
    'member:'
  ) > 0,
  'finance and lifecycle wrappers share the 0074 member lock namespace'
);
select is(
  (
    with internal_functions as (
      select p.oid, p.proname
        from pg_catalog.pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname like 'bp\_0084\_%\_impl' escape '\'
    )
    select count(*)::integer
      from internal_functions caller
      cross join internal_functions callee
     where caller.oid <> callee.oid
       and pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(caller.oid),
         'public.' || callee.proname || '('
       ) > 0
  ),
  3,
  'isolated implementation call graph has exactly three reviewed edges'
);
select ok(
  not exists (
    with wrappers as (
      select distinct p.proname
        from lock_rpc_manifest m
        join pg_catalog.pg_proc p
          on p.oid = pg_catalog.to_regprocedure(m.signature)
    )
    select 1
      from pg_catalog.pg_proc implementation
      cross join wrappers wrapper
     where implementation.pronamespace = 'public'::regnamespace
       and implementation.proname like
             'bp\_0084\_%\_impl' escape '\'
       and pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(implementation.oid),
         'public.' || wrapper.proname || '('
       ) > 0
  ),
  'no isolated implementation resolves a public mutation wrapper'
);
select ok(
  not exists (
    select 1
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal
       and p.proname like 'bp\_0084\_%\_impl' escape '\'
  ),
  'no trigger OID points at a renamed implementation'
);
select is(
  (
    select p.proconfig
      from pg_catalog.pg_proc p
     where p.oid = 'public.handle_new_user()'::regprocedure
  ),
  array['search_path=""']::text[],
  'auth profile trigger helper has an empty search_path'
);
select ok(
  (
    select
      pg_catalog.strpos(def, 'order by c.expires_at, c.id') > 0
      and pg_catalog.strpos(
            def, 'array_agg(distinct c.user_id order by c.user_id)'
          ) > 0
      and pg_catalog.strpos(
            def, 'public.bp_user_mutation_lock_many'
          ) > 0
    from (
      select pg_catalog.pg_get_functiondef(
        'public.sweep_expired(integer)'::regprocedure
      ) as def
    ) source
  ),
  'sweep freezes lot IDs and locks distinct users in a total order'
);
select ok(
  (
    select
      pg_catalog.strpos(def, 'foreach v_lot_id') > 0
      and pg_catalog.strpos(def, 'for update') > 0
      and pg_catalog.strpos(def, 'v_lot.expired_at is not null') > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'public.bp_0084_sweep_expired_ids_impl(uuid[])'::regprocedure
      )) as def
    ) source
  ),
  'sweep core revalidates and row-locks only the frozen ID set'
);
select ok(
  (
    select pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(p.oid),
      'public.bp_0084_mark_paid_and_grant_impl'
    ) > 0
      from pg_catalog.pg_proc p
     where p.oid =
       'public.bp_0084_admin_settle_stuck_order_impl(uuid,uuid,text)'::regprocedure
  ),
  'stuck-order settlement delegates to the hardened paid core'
);
select ok(
  (
    select pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(p.oid),
      'insert into public.credit_lots'
    ) = 0
      from pg_catalog.pg_proc p
     where p.oid =
       'public.bp_0084_admin_settle_stuck_order_impl(uuid,uuid,text)'::regprocedure
  ),
  'settlement no longer has a duplicate direct live-lot grant path'
);
select ok(
  (
    select
      pg_catalog.strpos(def, 'from public.profiles') > 0
      and pg_catalog.strpos(def, 'for update') >
            pg_catalog.strpos(def, 'from public.profiles')
      and pg_catalog.strpos(def, 'from auth.users') >
            pg_catalog.strpos(def, 'for update')
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'public.bp_0084_admin_reactivate_account_impl(uuid,uuid,text,text)'::regprocedure
      )) as def
    ) source
  ),
  'reactivation locks profile on its first lifecycle read'
);
select ok(
  (
    select
      pg_catalog.strpos(def, 'reactivation-email-namespace') > 0
      and pg_catalog.strpos(def, 'bp_mutation_object_lock') <
            pg_catalog.strpos(def, 'bp_user_mutation_lock')
    from (
      select pg_catalog.pg_get_functiondef(
        'public.admin_reactivate_account(uuid,uuid,text,text)'::regprocedure
      ) as def
    ) source
  ),
  'reactivation serializes the email namespace before the user'
);
select ok(
  (
    select
      pg_catalog.strpos(def, 'bp_0084_credit_adjust_request_lock') <
        pg_catalog.strpos(def, 'bp_user_mutation_lock')
    from (
      select pg_catalog.pg_get_functiondef(
        'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)'::regprocedure
      ) as def
    ) source
  )
  and (
    select
      pg_catalog.strpos(def, 'bp_0084_anon_reassign_locks') <
        pg_catalog.strpos(def, 'bp_user_mutation_lock_many')
    from (
      select pg_catalog.pg_get_functiondef(
        'public.reassign_anon_data(uuid,uuid)'::regprocedure
      ) as def
    ) source
  ),
  'legacy request/anonymous advisory families are pre-owned before users'
);

create temporary table lock_behavior_ctx(
  admin_id uuid not null,
  deleted_user uuid not null,
  deleted_order uuid not null,
  sweep_user_a uuid not null,
  sweep_user_b uuid not null
) on commit drop;

insert into lock_behavior_ctx
select
  pg_catalog.gen_random_uuid(),
  pg_catalog.gen_random_uuid(),
  pg_catalog.gen_random_uuid(),
  pg_catalog.gen_random_uuid(),
  pg_catalog.gen_random_uuid();

insert into public.app_settings(key, value)
values (
  'growth_levers',
  pg_catalog.jsonb_build_object(
    'products',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'productId', 'qa_lock_3',
        'goodname', 'lock QA credits',
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

insert into auth.users(id, email)
select admin_id, 'lock-admin-' || admin_id || '@test.local'
  from lock_behavior_ctx
union all
select deleted_user, 'lock-deleted-' || deleted_user || '@test.local'
  from lock_behavior_ctx
union all
select sweep_user_a, 'lock-sweep-a-' || sweep_user_a || '@test.local'
  from lock_behavior_ctx
union all
select sweep_user_b, 'lock-sweep-b-' || sweep_user_b || '@test.local'
  from lock_behavior_ctx;

insert into public.member_accounts(user_id, gen_credits, is_admin)
select admin_id, 0, true from lock_behavior_ctx
union all
select deleted_user, 0, false from lock_behavior_ctx
union all
select sweep_user_a, 1, false from lock_behavior_ctx
union all
select sweep_user_b, 1, false from lock_behavior_ctx;

select lives_ok(
  (
    select format(
      $sql$
        select public.bp_008905_create_or_reuse_pending_order_impl(
          %L::uuid, %L::uuid, 'qa_lock_3', 1000, 3,
          replace(%L, '-', ''), 'portone', 'card', false,
          'store-qa', 'KRW', 'channel-card-live'
        );
        select public.mark_order_failed(
          %L::uuid, 'FAILED', 'QA stale order', '{}'::jsonb
        );
        select public.admin_soft_delete_account(%L::uuid);
        select public.admin_settle_stuck_order_verified(
          %L::uuid,
          %L::uuid,
          'QA verified payment recovery',
          pg_catalog.gen_random_uuid(),
          evidence.paid_at,
          'qa-quarantine-transaction',
          null,
          pg_catalog.jsonb_build_object(
            'id', replace(%L, '-', ''),
            'status', 'PAID',
            'transactionId', 'qa-quarantine-transaction',
            'paidAt', evidence.paid_at,
            'amount', pg_catalog.jsonb_build_object('total', 1000),
            'storeId', 'store-qa',
            'currency', 'KRW',
            'channel', pg_catalog.jsonb_build_object(
              'type', 'LIVE',
              'key', 'channel-card-live'
            )
          )
        )
        from (select pg_catalog.clock_timestamp() as paid_at) evidence;
      $sql$,
      deleted_user::text,
      deleted_order::text,
      deleted_order::text,
      deleted_order::text,
      deleted_user::text,
      admin_id::text,
      deleted_order::text,
      deleted_order::text
    )
    from lock_behavior_ctx
  ),
  'deleted-account settlement completes through quarantine'
);
select is(
  (
    select m.gen_credits
      from public.member_accounts m
      join lock_behavior_ctx c on c.deleted_user = m.user_id
  ),
  0,
  'settlement cannot resurrect deleted-account credits'
);
select is(
  (
    select count(*)::integer
      from public.credit_lots l
      join lock_behavior_ctx c on c.deleted_order = l.order_uuid
     where l.source = 'purchase'
       and l.expired_at is not null
       and l.expiration_reason = 'account_deleted'
  ),
  1,
  'deleted-account settlement creates one quarantined purchase lot'
);
select is(
  (
    select a.credit_delta
      from public.admin_actions_ledger a
      join lock_behavior_ctx c on c.deleted_order = a.order_uuid
     where a.action_type = 'settle_stuck'
  ),
  0,
  'settlement audit records zero granted credits for quarantine'
);

insert into public.credit_lots(
  user_id, source, qty, granted_at, expires_at
)
select sweep_user_a, 'legacy_free', 1,
       '-infinity'::timestamptz,
       '0001-01-01 00:00:00+00'::timestamptz
  from lock_behavior_ctx
union all
select sweep_user_b, 'legacy_free', 1,
       '-infinity'::timestamptz,
       '0001-01-01 00:00:00+00'::timestamptz
  from lock_behavior_ctx;

create temporary table lock_sweep_result on commit drop as
select public.sweep_expired(2) as result;

select is(
  (select (result->>'expired')::integer from lock_sweep_result),
  2,
  'sweep expires the exact two-row frozen batch'
);
select is(
  (
    select sum(m.gen_credits)::integer
      from public.member_accounts m
      join lock_behavior_ctx c
        on m.user_id in (c.sweep_user_a, c.sweep_user_b)
  ),
  0,
  'multi-user sweep updates both cached balances exactly once'
);
select is(
  (
    select count(*)::integer
      from public.credit_ledger l
     join lock_behavior_ctx c
        on l.user_id in (c.sweep_user_a, c.sweep_user_b)
     where l.event_type = 'expire'
       and l.note = 'natural'
  ),
  2,
  'multi-user sweep writes one natural-expiry ledger row per lot'
);
select is(
  (
    select count(*)::integer
      from public.member_accounts m
      left join (
        select
          l.user_id,
          sum(
            l.qty - l.consumed - l.refunded - l.refund_reserved
          )::integer as remaining
        from public.credit_lots l
        where l.expired_at is null
        group by l.user_id
      ) envelope on envelope.user_id = m.user_id
     where m.gen_credits <> coalesce(envelope.remaining, 0)
  ),
  0,
  'credit cache equals every live lot envelope after lock-order behaviors'
);

select * from finish();
rollback;
