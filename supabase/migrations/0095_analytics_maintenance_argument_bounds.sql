-- 0095: post-contract maintenance bounds and stale service RPC closure.
--
-- These service-role RPCs perform delete-and-rebuild or retention deletion.
-- Their legacy greatest(0, p_days - 1) loops treated NULL, zero, and negative
-- values as "today", while a negative retention moved the cutoff into the
-- future. Validate before the advisory lock, date arithmetic, or any DML.
--
-- Bounded recovery horizons:
--   telemetry rollup: current KST day + the 30-day raw retention window
--   analytics rollup: current KST day + the 90-day raw retention window
--   analytics raw retention: 1..90 days (90 is the published policy)
--
-- This follows the staged OAuth expand/contract pair as an independent
-- post-contract hardening migration; 0093/0094 must not be renumbered.
-- It also removes direct service-role access from six superseded RPCs found
-- by the final public-function inventory. The functions remain owner-callable
-- for reversible rollback and SECURITY DEFINER dependencies.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

-- boss_paegi_oauth_post_contract_catalog_injection_point
do $boss_paegi_raw_post_contract_guard$
begin
  raise exception '0095 requires the staged post-contract runner'
    using errcode = 'P0001';
end;
$boss_paegi_raw_post_contract_guard$;

do $preflight$
begin
  if to_regprocedure('public.reassign_anon_data(uuid,uuid)') is null
     or to_regprocedure(
       'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)'
     ) is null then
    raise exception '0095 preflight: OAuth contract RPC missing';
  end if;

  if has_function_privilege(
       'service_role',
       'public.reassign_anon_data(uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.reassign_anon_data(uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.reassign_anon_data(uuid,uuid)',
       'EXECUTE'
     )
     or obj_description(
       to_regprocedure('public.reassign_anon_data(uuid,uuid)'),
       'pg_proc'
     ) is distinct from
       'Internal primitive; invoke only through flow-scoped OAuth migration consumption.'
     or has_function_privilege(
       'service_role',
       'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',
       'EXECUTE'
     )
     or obj_description(
       to_regprocedure(
         'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)'
       ),
       'pg_proc'
     ) is distinct from
       'Expand-only pre-ledger cookie bridge; execution revoked after the full deployment drain.' then
    raise exception '0095 preflight: OAuth contract stage is incomplete';
  end if;

  if to_regprocedure('public.telemetry_rollup_days(integer)') is null
     or to_regprocedure('public.telemetry_prune()') is null
     or to_regprocedure('public.maintain_analytics_rollups(integer)') is null
     or to_regprocedure('public.prune_analytics_events(integer)') is null then
    raise exception '0095 preflight: analytics maintenance RPC missing';
  end if;

  if to_regprocedure(
       'public.admin_dismiss_report(uuid,uuid,text)'
     ) is null
     or to_regprocedure(
       'public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)'
     ) is null
     or to_regprocedure(
       'public.legal_sections_valid(jsonb)'
     ) is null
     or to_regprocedure(
       'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'
     ) is null
     or to_regprocedure(
       'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'
     ) is null
     or to_regprocedure(
       'public.release_generation_preflight(uuid,uuid,uuid,text)'
     ) is null then
    raise exception '0095 preflight: superseded service RPC missing';
  end if;

  if to_regclass('public.telemetry_sessions') is null
     or to_regclass('public.telemetry_rollups') is null
     or to_regclass('public.analytics_events') is null
     or to_regclass('public.analytics_rollups') is null
     or to_regclass('public.scores') is null then
    raise exception '0095 preflight: analytics maintenance relation missing';
  end if;
end;
$preflight$;

-- KST daily telemetry rollup. At most 31 dates are rebuilt: today and the
-- complete 30-day raw-data horizon.
create or replace function public.telemetry_rollup_days(p_days int default 3)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_min_days constant int := 1;
  c_max_days constant int := 31;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_rows int := 0;
  i int;
begin
  if p_days is null or p_days not between c_min_days and c_max_days then
    raise exception 'telemetry_rollup_days_invalid_days'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('telemetry_rollups')
  );

  for i in 0 .. p_days - 1 loop
    v_d := v_today - i;
    v_lo := (v_d::timestamp at time zone 'Asia/Seoul');
    v_hi := ((v_d + 1)::timestamp at time zone 'Asia/Seoul');

    delete from public.telemetry_rollups where day_kst = v_d;

    insert into public.telemetry_rollups(
      day_kst,
      dim_type,
      dim_key,
      sessions,
      hits,
      score,
      attempts,
      switches,
      measure_a,
      updated_at
    )
    select
      v_d,
      'weapon',
      e.key,
      count(distinct s.id),
      coalesce(sum((e.value->>'hits')::numeric), 0),
      coalesce(sum((e.value->>'score')::numeric), 0),
      coalesce(sum((e.value->>'attempts')::numeric), 0),
      coalesce(sum((e.value->>'switches')::numeric), 0),
      0,
      now()
    from public.telemetry_sessions s,
         lateral jsonb_each(s.weapon_summary) e
    where s.started_at >= v_lo
      and s.started_at < v_hi
    group by e.key;

    insert into public.telemetry_rollups(
      day_kst,
      dim_type,
      dim_key,
      sessions,
      hits,
      score,
      attempts,
      switches,
      measure_a,
      updated_at
    )
    select
      v_d,
      'map',
      e.key,
      count(distinct s.id),
      coalesce(sum((e.value->>'hits')::numeric), 0),
      coalesce(sum((e.value->>'score')::numeric), 0),
      coalesce(sum((e.value->>'attempts')::numeric), 0),
      coalesce(sum((e.value->>'switches')::numeric), 0),
      0,
      now()
    from public.telemetry_sessions s,
         lateral jsonb_each(s.map_summary) e
    where s.started_at >= v_lo
      and s.started_at < v_hi
    group by e.key;

    insert into public.telemetry_rollups(
      day_kst,
      dim_type,
      dim_key,
      sessions,
      hits,
      score,
      attempts,
      switches,
      measure_a,
      updated_at
    )
    select v_d, 'funnel_step', step, cnt, 0, 0, 0, 0, 0, now()
    from (
      select 'entered' as step, count(*) as cnt
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
      union all
      select 'first_hit', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and first_hit_ms is not null
      union all
      select 'first_switch', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and first_switch_ms is not null
      union all
      select 'first_ult', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and first_ult_ms is not null
      union all
      select 'completed', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and end_reason = 'normal'
      union all
      select 'forced', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and end_reason in ('time_limit', 'score_limit')
      union all
      select 'abandoned', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and end_reason in ('abandon', 'reload', 'hidden_timeout')
      union all
      select 'multi_map', count(*)
      from public.telemetry_sessions
      where started_at >= v_lo and started_at < v_hi
        and distinct_maps >= 2
    ) f;

    get diagnostics v_rows = row_count;
  end loop;

  return jsonb_build_object('ok', true, 'days', p_days);
end;
$function$;

-- The route invokes rollup and raw-session pruning as separate RPC
-- transactions. Share the rollup lock so concurrent cron deliveries cannot
-- delete source rows between the rollup function's READ COMMITTED statements.
create or replace function public.telemetry_prune()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_retention_days constant int := 30;
  c_target_bytes constant bigint := 31457280;
  c_batch constant int := 2000;
  v_cutoff timestamptz;
  v_timeline_nulled int := 0;
  v_anon_deleted int := 0;
  v_over_deleted int := 0;
  v_size bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('telemetry_rollups')
  );

  v_cutoff := pg_catalog.now()
    - pg_catalog.make_interval(days => c_retention_days);

  update public.telemetry_sessions
  set timeline = null,
      timeline_dropped = true
  where timeline is not null
    and started_at < v_cutoff;
  get diagnostics v_timeline_nulled = row_count;

  delete from public.telemetry_sessions
  where is_anon
    and started_at < v_cutoff;
  get diagnostics v_anon_deleted = row_count;

  v_size := pg_catalog.pg_total_relation_size(
    'public.telemetry_sessions'
  );
  if v_size > c_target_bytes then
    delete from public.telemetry_sessions
    where id in (
      select s.id
      from public.telemetry_sessions s
      left join public.scores sc on sc.telemetry_session_id = s.id
      order by
        case
          when s.is_anon then 0
          when sc.id is null then 1
          else 2
        end,
        s.started_at asc
      limit c_batch
    );
    get diagnostics v_over_deleted = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'timeline_nulled', v_timeline_nulled,
    'anon_deleted', v_anon_deleted,
    'over_budget_deleted', v_over_deleted,
    'bytes', v_size
  );
end;
$function$;

-- Acquisition rollup recovery is bounded to every date that can still have
-- raw analytics data under the 90-day policy (today plus 90 prior dates).
create or replace function public.maintain_analytics_rollups(
  p_days int default 7
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_min_days constant int := 1;
  c_max_days constant int := 91;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date;
  v_lo timestamptz;
  v_hi timestamptz;
  i int;
begin
  if p_days is null or p_days not between c_min_days and c_max_days then
    raise exception 'maintain_analytics_rollups_invalid_days'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('analytics_rollups')
  );

  for i in 0 .. p_days - 1 loop
    v_d := v_today - i;
    v_lo := (v_d::timestamp at time zone 'Asia/Seoul');
    v_hi := ((v_d + 1)::timestamp at time zone 'Asia/Seoul');

    delete from public.analytics_rollups where day_kst = v_d;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'visit_by_source',
      coalesce(source_scope, ''),
      coalesce(source_kind, ''),
      coalesce(source_value, ''),
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'visit' and day_kst = v_d
    group by source_scope, source_kind, source_value;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'viral_inbound_by_type',
      coalesce(viral_type, ''),
      '',
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'visit'
      and source_scope = 'first_touch'
      and source_kind = 'viral'
      and day_kst = v_d
    group by viral_type;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'share_by_surface',
      coalesce(surface, ''),
      '',
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'share' and day_kst = v_d
    group by surface;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'share_by_target',
      coalesce(target, ''),
      '',
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'share' and day_kst = v_d
    group by target;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'share_by_score_tier',
      coalesce(score_tier::text, ''),
      '',
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'share'
      and target = 'score'
      and day_kst = v_d
    group by score_tier;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'share_by_member_state',
      member_state,
      '',
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'share' and day_kst = v_d
    group by member_state;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'share_game_over',
      '',
      '',
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'share'
      and surface = 'game_over'
      and target = 'score'
      and day_kst = v_d;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'conversion_play_by_source',
      coalesce(source_kind, ''),
      coalesce(source_value, ''),
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'conversion'
      and conversion_step = 'play'
      and day_kst = v_d
    group by source_kind, source_value;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'conversion_signup_by_source',
      coalesce(source_kind, ''),
      coalesce(source_value, ''),
      '',
      '',
      count(*),
      now()
    from public.analytics_events
    where kind = 'conversion'
      and conversion_step = 'signup'
      and day_kst = v_d
    group by source_kind, source_value;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select v_d, 'score_submit', '', '', '', '', count(*), now()
    from public.scores
    where created_at >= v_lo and created_at < v_hi;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select
      v_d,
      'play_session',
      '',
      '',
      '',
      '',
      count(distinct telemetry_session_id),
      now()
    from public.scores
    where created_at >= v_lo
      and created_at < v_hi
      and telemetry_session_id is not null;
  end loop;

  return jsonb_build_object('ok', true, 'days', p_days);
end;
$function$;

-- Retention remains configurable within the documented privacy envelope, but
-- cannot underflow/overflow date arithmetic or move the cutoff into the future.
create or replace function public.prune_analytics_events(
  p_retention_days int default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_min_retention_days constant int := 1;
  c_max_retention_days constant int := 90;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_cutoff date;
  v_deleted int := 0;
begin
  if p_retention_days is null
     or p_retention_days not between
       c_min_retention_days and c_max_retention_days then
    raise exception 'prune_analytics_events_invalid_retention_days'
      using errcode = '22023';
  end if;

  -- Serialize pruning with rollup rebuilds so a rebuild cannot observe a
  -- partially changed raw-data horizon.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('analytics_rollups')
  );

  v_cutoff := v_today - p_retention_days;

  delete from public.analytics_events
  where day_kst < v_cutoff;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted', v_deleted,
    'cutoff', v_cutoff
  );
end;
$function$;

-- CREATE OR REPLACE preserves the previous ACL. Remove every explicit
-- non-owner grantee, not only the standard Supabase roles, before granting
-- the one intended caller.
revoke all on function public.telemetry_rollup_days(int)
  from public, anon, authenticated, service_role;
revoke all on function public.telemetry_prune()
  from public, anon, authenticated, service_role;
revoke all on function public.maintain_analytics_rollups(int)
  from public, anon, authenticated, service_role;
revoke all on function public.prune_analytics_events(int)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_dismiss_report(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.admin_settle_stuck_order_idempotent(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.legal_sections_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.record_generation_pick_provider_result(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.record_generation_preflight_result(
  uuid, uuid, uuid, text, text, text, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.release_generation_preflight(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

do $acl_cleanup$
declare
  v_grant record;
begin
  for v_grant in
    select distinct
      p.oid as function_oid,
      r.rolname
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        p.proacl,
        pg_catalog.acldefault('f', p.proowner)
      )
    ) a
    join pg_catalog.pg_roles r on r.oid = a.grantee
    where p.oid = any(array[
      to_regprocedure('public.telemetry_rollup_days(integer)'),
      to_regprocedure('public.telemetry_prune()'),
      to_regprocedure('public.maintain_analytics_rollups(integer)'),
      to_regprocedure('public.prune_analytics_events(integer)'),
      to_regprocedure('public.admin_dismiss_report(uuid,uuid,text)'),
      to_regprocedure(
        'public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)'
      ),
      to_regprocedure('public.legal_sections_valid(jsonb)'),
      to_regprocedure(
        'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'
      ),
      to_regprocedure(
        'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'
      ),
      to_regprocedure(
        'public.release_generation_preflight(uuid,uuid,uuid,text)'
      )
    ])
      and a.grantee <> p.proowner
  loop
    execute format(
      'revoke all on function %s from %I',
      v_grant.function_oid::regprocedure,
      v_grant.rolname
    );
  end loop;
end;
$acl_cleanup$;

grant execute on function public.telemetry_rollup_days(int) to service_role;
grant execute on function public.telemetry_prune() to service_role;
grant execute on function public.maintain_analytics_rollups(int) to service_role;
grant execute on function public.prune_analytics_events(int) to service_role;

do $postflight$
declare
  v_signature text;
  v_function_oid oid;
  v_service_role_oid oid;
begin
  select oid
  into v_service_role_oid
  from pg_catalog.pg_roles
  where rolname = 'service_role';

  if v_service_role_oid is null then
    raise exception '0095 postflight: service_role is missing';
  end if;

  foreach v_signature in array array[
    'public.telemetry_rollup_days(integer)',
    'public.telemetry_prune()',
    'public.maintain_analytics_rollups(integer)',
    'public.prune_analytics_events(integer)'
  ]
  loop
    v_function_oid := to_regprocedure(v_signature);

    if not has_function_privilege('service_role', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception '0095 postflight: maintenance RPC ACL drift (%)',
        v_signature;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          p.proacl,
          pg_catalog.acldefault('f', p.proowner)
        )
      ) a
      where p.oid = v_function_oid
        and a.grantee = v_service_role_oid
        and a.privilege_type = 'EXECUTE'
        and not a.is_grantable
    )
    or exists (
      select 1
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          p.proacl,
          pg_catalog.acldefault('f', p.proowner)
        )
      ) a
      where p.oid = v_function_oid
        and a.privilege_type = 'EXECUTE'
        and a.grantee not in (p.proowner, v_service_role_oid)
    ) then
      raise exception '0095 postflight: maintenance RPC exact ACL drift (%)',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.admin_dismiss_report(uuid,uuid,text)',
    'public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)',
    'public.legal_sections_valid(jsonb)',
    'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)',
    'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)',
    'public.release_generation_preflight(uuid,uuid,uuid,text)'
  ]
  loop
    v_function_oid := to_regprocedure(v_signature);

    if has_function_privilege('service_role', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or exists (
         select 1
         from pg_catalog.pg_proc p
         cross join lateral pg_catalog.aclexplode(
           coalesce(
             p.proacl,
             pg_catalog.acldefault('f', p.proowner)
           )
         ) a
         where p.oid = v_function_oid
           and a.privilege_type = 'EXECUTE'
           and a.grantee <> p.proowner
       ) then
      raise exception '0095 postflight: superseded RPC ACL drift (%)',
        v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'telemetry_rollup_days',
        'telemetry_prune',
        'maintain_analytics_rollups',
        'prune_analytics_events'
      )
      and (
        not p.prosecdef
        or not coalesce(
          p.proconfig @> array['search_path=public']::text[],
          false
        )
      )
  ) then
    raise exception '0095 postflight: maintenance RPC security drift';
  end if;
end;
$postflight$;

notify pgrst, 'reload schema';
commit;
