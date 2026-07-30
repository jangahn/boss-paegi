-- 008902_financial_projection_bounds.sql
--
-- Bound the immutable cancellation batch projection before constructing it.
-- A mathematically valid full cancellation can contain enough provider events
-- to exceed cancellation_resolution_batches.crb_projection_size_check. The
-- former implementation built the complete jsonb aggregate and then failed
-- the INSERT, rolling back without a durable manual-review result.
--
-- This expand migration keeps the rolling public wrapper installed by 0084.
-- Only its private implementation is replaced. The 0092 contract migration
-- may run after this receipt and the corresponding application smoke gate.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_0084_resolve_external_cancellation_auto_full_impl(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
          'public.resolve_external_cancellation_auto_full(uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_apply_external_resolution(text,uuid,integer,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_versioned_hash(jsonb,integer)'
        ) is null
     or pg_catalog.to_regclass(
          'public.cancellation_resolution_batches'
        ) is null
     or pg_catalog.to_regclass(
          'public.payment_cancellation_events'
        ) is null then
    raise exception '008902 preflight: refund authority missing';
  end if;
end;
$$;

create or replace function
  public.bp_0084_resolve_external_cancellation_auto_full_impl(
    p_order_uuid uuid
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  v_total_numeric numeric;
  v_total_stored bigint;
  v_count bigint;
  v_committed_count bigint;
  v_committed_stored integer;
  v_all_resolvable boolean;
  v_projected_bytes numeric;
  v_projection jsonb;
  v_ineligible_reason text;
  v_batch uuid;
  v_remaining integer;
  v_alloc integer;
  v_assigned integer := 0;
  ev record;
  v_hash text;
begin
  select *
    into o
    from public.orders
   where order_uuid = p_order_uuid
   for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  -- jsonb arrays render as '[' + each jsonb element joined by ', ' + ']'.
  -- Sum the exact encoded byte cost without ever materializing an unbounded
  -- array. Each cancellation id is already bounded to 256 characters by the
  -- observation RPC.
  select
    coalesce(pg_catalog.sum(e.amount::numeric), 0),
    pg_catalog.count(*),
    coalesce(
      pg_catalog.bool_and(
        e.status = 'SUCCEEDED'
        and e.resolution_state = 'unmatched'
      ),
      false
    ),
    case
      when pg_catalog.count(*) = 0 then 2::numeric
      else
        2::numeric
        + coalesce(
            pg_catalog.sum(
              pg_catalog.octet_length(
                pg_catalog.jsonb_build_object(
                  'cancellation_id', e.cancellation_id,
                  'amount', e.amount
                )::text
              )::numeric
            ),
            0
          )
        + (2::numeric * (pg_catalog.count(*) - 1)::numeric)
    end
    into
      v_total_numeric,
      v_count,
      v_all_resolvable,
      v_projected_bytes
    from public.payment_cancellation_events e
   where e.order_uuid = p_order_uuid
     and e.origin = 'live';

  select pg_catalog.count(*)
    into v_committed_count
    from public.order_refund_attempts a
   where a.order_uuid = p_order_uuid
     and a.state = 'committed';

  -- The legacy snapshot columns are bigint/integer. Invalid over-range totals
  -- still converge to an ineligible batch; their exact values remain bound in
  -- the v2 eligibility hash and response instead of throwing on a cast.
  v_total_stored := least(
    v_total_numeric,
    9223372036854775807::numeric
  )::bigint;
  v_committed_stored := least(
    v_committed_count,
    2147483647::bigint
  )::integer;

  v_ineligible_reason := case
    when v_count = 0 then 'no_live_events'
    when not v_all_resolvable then 'event_not_resolvable'
    when v_total_numeric <> o.amount::numeric then 'amount_mismatch'
    when o.refunded_amount <> 0 or o.refunded_credits <> 0
      then 'prior_refund'
    when v_committed_count <> 0 then 'committed_refund'
    when o.cancel_intent_created_at is null then 'cancel_intent_missing'
    when v_projected_bytes > 32768::numeric
      then 'projection_too_large'
    else null
  end;

  if v_ineligible_reason is not null then
    v_hash := public.bp_versioned_hash(
      pg_catalog.jsonb_build_object(
        'order_uuid', p_order_uuid::text,
        'eligible', false,
        'reason', v_ineligible_reason,
        'event_count', v_count,
        'projected_bytes', v_projected_bytes,
        'total', v_total_numeric,
        'credits', o.credits
      ),
      2
    );
    insert into public.cancellation_resolution_batches (
      order_uuid,
      order_amount_snapshot,
      order_credits_snapshot,
      pre_refunded_amount,
      pre_refunded_credits,
      pre_committed_count,
      pre_legacy_contribution,
      had_cancel_intent,
      total_succeeded_amount,
      cancellation_projection,
      eligibility_result,
      eligibility_hash,
      eligibility_hash_version,
      resolved_at
    )
    values (
      p_order_uuid,
      o.amount,
      o.credits,
      o.refunded_amount,
      o.refunded_credits,
      v_committed_stored,
      0,
      o.cancel_intent_created_at is not null,
      v_total_stored,
      '[]'::jsonb,
      'ineligible',
      v_hash,
      2,
      null
    )
    returning id into v_batch;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'ineligible',
      'reason', v_ineligible_reason,
      'batch_id', v_batch,
      'events', v_count,
      'projected_bytes', v_projected_bytes
    );
  end if;

  -- This aggregate is reached only after its exact encoded size has been
  -- proven within the immutable 32 KiB table constraint.
  select pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'cancellation_id', e.cancellation_id,
             'amount', e.amount
           )
           order by e.requested_at asc nulls last, e.cancellation_id asc
         )
    into v_projection
    from public.payment_cancellation_events e
   where e.order_uuid = p_order_uuid
     and e.origin = 'live';

  if pg_catalog.octet_length(v_projection::text) <> v_projected_bytes then
    raise exception 'projection_size_miscalculated'
      using errcode = 'P0001';
  end if;

  v_hash := public.bp_versioned_hash(
    pg_catalog.jsonb_build_object(
      'order_uuid', p_order_uuid::text,
      'total', v_total_numeric,
      'credits', o.credits,
      'eligible', true,
      'event_count', v_count,
      'projected_bytes', v_projected_bytes
    ),
    2
  );
  insert into public.cancellation_resolution_batches (
    order_uuid,
    order_amount_snapshot,
    order_credits_snapshot,
    pre_refunded_amount,
    pre_refunded_credits,
    pre_committed_count,
    pre_legacy_contribution,
    had_cancel_intent,
    total_succeeded_amount,
    cancellation_projection,
    eligibility_result,
    eligibility_hash,
    eligibility_hash_version,
    resolved_at
  )
  values (
    p_order_uuid,
    o.amount,
    o.credits,
    0,
    0,
    0,
    0,
    true,
    v_total_stored,
    v_projection,
    'eligible',
    v_hash,
    2,
    pg_catalog.now()
  )
  returning id into v_batch;

  -- Hamilton/largest-remainder allocation. The deterministic event order is
  -- preserved from 0062; only projection construction is bounded above.
  select coalesce(
           pg_catalog.sum(
             pg_catalog.floor(
               e.amount::numeric * o.credits / v_total_numeric
             )::integer
           ),
           0
         )
    into v_assigned
    from public.payment_cancellation_events e
   where e.order_uuid = p_order_uuid
     and e.origin = 'live';
  v_remaining := o.credits - v_assigned;

  for ev in
    select
      e.cancellation_id,
      pg_catalog.floor(
        e.amount::numeric * o.credits / v_total_numeric
      )::integer as base_alloc,
      pg_catalog.row_number() over (
        order by
          (
            e.amount::numeric * o.credits / v_total_numeric
          ) - pg_catalog.floor(
            e.amount::numeric * o.credits / v_total_numeric
          ) desc,
          e.requested_at asc nulls last,
          e.cancellation_id asc
      ) as rn
      from public.payment_cancellation_events e
     where e.order_uuid = p_order_uuid
       and e.origin = 'live'
     order by rn
  loop
    v_alloc := ev.base_alloc
      + case when ev.rn <= v_remaining then 1 else 0 end;
    perform public.bp_apply_external_resolution(
      ev.cancellation_id,
      null,
      v_alloc,
      v_batch
    );
  end loop;

  update public.orders
     set status = 'canceled',
         canceled_at = coalesce(canceled_at, pg_catalog.now())
   where order_uuid = p_order_uuid
     and status <> 'canceled';

  update public.reconciliation_issues i
     set state = 'resolved',
         resolved_at = pg_catalog.now(),
         resolution_source = 'system',
         resolved_by = null,
         detail = coalesce(i.detail, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
                'resolution_note',
                'auto_full_batch:' || v_batch::text
              )
   where i.order_uuid = p_order_uuid
     and i.type = 'unmatched_cancellation'
     and i.state = 'open';

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'resolved_full',
    'batch_id', v_batch,
    'events', v_count
  );
end;
$$;

revoke all on function
  public.bp_0084_resolve_external_cancellation_auto_full_impl(uuid)
  from public, anon, authenticated, service_role;

do $$
declare
  v_impl regprocedure :=
    'public.bp_0084_resolve_external_cancellation_auto_full_impl(uuid)'::regprocedure;
  v_wrapper regprocedure :=
    'public.resolve_external_cancellation_auto_full(uuid)'::regprocedure;
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(v_impl)
    into v_definition;
  if not (
       select p.prosecdef
         from pg_catalog.pg_proc p
        where p.oid = v_impl
     )
     or not (
       select coalesce(p.proconfig, array[]::text[])
                && array['search_path=', 'search_path=""']
         from pg_catalog.pg_proc p
        where p.oid = v_impl
     )
     or pg_catalog.has_function_privilege(
          'service_role', v_impl, 'EXECUTE'
        )
     or not pg_catalog.has_function_privilege(
          'service_role', v_wrapper, 'EXECUTE'
        )
     or pg_catalog.strpos(
          v_definition,
          'v_projected_bytes > 32768::numeric'
        ) = 0
     or pg_catalog.strpos(
          v_definition,
          '''reason'', v_ineligible_reason'
        ) = 0
     or pg_catalog.strpos(
          v_definition,
          '''event_count'', v_count'
        ) = 0
     or pg_catalog.strpos(
          v_definition,
          '''projected_bytes'', v_projected_bytes'
        ) = 0
     or pg_catalog.strpos(
          v_definition,
          'if pg_catalog.octet_length(v_projection::text) <>'
        ) = 0 then
    raise exception '008902 postflight: bounded projection authority drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values (
  '008902_financial_projection_bounds', null, null, null
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
