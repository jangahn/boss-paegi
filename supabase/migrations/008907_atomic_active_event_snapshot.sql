-- 008907: atomically project every public active-event surface.
--
-- The former server implementation issued four surface reads plus two
-- transition reads. Under READ COMMITTED, an admin mutation between those
-- statements could combine rows from different database states. This
-- service-role-only STABLE SQL function evaluates one SQL statement against
-- one MVCC snapshot and emits only the bounded public DTO.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.events') is null then
    raise exception '008907 preflight: public.events missing';
  end if;
  if exists (
    select 1
    from (
      values
        ('id'),
        ('type'),
        ('status'),
        ('title'),
        ('summary'),
        ('starts_at'),
        ('ends_at'),
        ('popup_active'),
        ('banner_home_active'),
        ('banner_gallery_active'),
        ('banner_leaderboard_active'),
        ('priority'),
        ('pinned'),
        ('popup_dismiss_days'),
        ('published_at'),
        ('created_at'),
        ('deleted_at')
    ) required(column_name)
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'events'
        and c.column_name = required.column_name
    )
  ) then
    raise exception '008907 preflight: public.events contract incomplete';
  end if;
end;
$preflight$;

create or replace function public.get_active_event_surfaces()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with bounds as materialized (
    select pg_catalog.statement_timestamp() as server_now
  ),
  eligible as materialized (
    select
      e.id,
      e.type,
      e.title,
      e.summary,
      e.starts_at,
      e.ends_at,
      e.popup_active,
      e.banner_home_active,
      e.banner_gallery_active,
      e.banner_leaderboard_active,
      e.priority,
      e.pinned,
      e.popup_dismiss_days,
      e.published_at,
      e.created_at
    from public.events e
    where e.status = 'published'
      and e.deleted_at is null
      and (
        e.popup_active
        or e.banner_home_active
        or e.banner_gallery_active
        or e.banner_leaderboard_active
      )
  ),
  active_candidates as materialized (
    select e.*
    from eligible e
    cross join bounds b
    where (e.starts_at is null or e.starts_at <= b.server_now)
      and (e.ends_at is null or e.ends_at > b.server_now)
  ),
  future_transitions as (
    select e.starts_at as transition_at
    from eligible e
    cross join bounds b
    where e.starts_at > b.server_now
    union all
    select e.ends_at as transition_at
    from eligible e
    cross join bounds b
    where e.ends_at > b.server_now
  ),
  next_transition as (
    select pg_catalog.min(t.transition_at) as transition_at
    from future_transitions t
  ),
  popup_pick as (
    select pg_catalog.jsonb_build_object(
      'id', e.id,
      'type', e.type,
      'title', e.title,
      'summary', e.summary,
      'popupDismissDays', e.popup_dismiss_days
    ) as value
    from active_candidates e
    where e.popup_active
    order by
      e.priority desc,
      e.pinned desc,
      e.published_at desc nulls last,
      e.created_at desc,
      e.id desc
    limit 1
  ),
  home_pick as (
    select pg_catalog.jsonb_build_object(
      'id', e.id,
      'type', e.type,
      'summary', e.summary
    ) as value
    from active_candidates e
    where e.banner_home_active
    order by
      e.priority desc,
      e.pinned desc,
      e.published_at desc nulls last,
      e.created_at desc,
      e.id desc
    limit 1
  ),
  gallery_pick as (
    select pg_catalog.jsonb_build_object(
      'id', e.id,
      'type', e.type,
      'summary', e.summary
    ) as value
    from active_candidates e
    where e.banner_gallery_active
    order by
      e.priority desc,
      e.pinned desc,
      e.published_at desc nulls last,
      e.created_at desc,
      e.id desc
    limit 1
  ),
  leaderboard_pick as (
    select pg_catalog.jsonb_build_object(
      'id', e.id,
      'type', e.type,
      'summary', e.summary
    ) as value
    from active_candidates e
    where e.banner_leaderboard_active
    order by
      e.priority desc,
      e.pinned desc,
      e.published_at desc nulls last,
      e.created_at desc,
      e.id desc
    limit 1
  ),
  response as (
    select pg_catalog.jsonb_build_object(
      'serverNow',
        pg_catalog.to_char(
          b.server_now at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
      'nextTransitionAt',
        case
          when n.transition_at is null then null
          else pg_catalog.to_char(
            n.transition_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        end,
      'popup', (select p.value from popup_pick p),
      'banners', pg_catalog.jsonb_build_object(
        'home', (select h.value from home_pick h),
        'gallery', (select g.value from gallery_pick g),
        'leaderboard', (select l.value from leaderboard_pick l)
      )
    ) as payload
    from bounds b
    cross join next_transition n
  )
  select r.payload
  from response r
  -- The table constraints cap each public string at 200 characters. Keep an
  -- independent fail-closed ceiling so later schema drift cannot turn this
  -- public projection into an unbounded PostgREST response.
  where pg_catalog.pg_column_size(r.payload) <= 8192
$function$;

revoke all on function public.get_active_event_surfaces()
  from public, anon, authenticated, service_role;
grant execute on function public.get_active_event_surfaces()
  to service_role;

do $verify$
declare
  v_proc oid := to_regprocedure('public.get_active_event_surfaces()');
begin
  if v_proc is null then
    raise exception '008907 verification: RPC missing';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid = v_proc
      and l.lanname = 'sql'
      and p.provolatile = 's'
      and p.prosecdef
      and p.prorettype = 'jsonb'::regtype
      and p.proconfig = array['search_path=pg_catalog, public']
  ) then
    raise exception '008907 verification: function contract drift';
  end if;
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.get_active_event_surfaces()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.get_active_event_surfaces()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.get_active_event_surfaces()',
       'EXECUTE'
     ) then
    raise exception '008907 verification: RPC ACL drift';
  end if;
end;
$verify$;

insert into public.schema_migration_journal (
  version,
  migration_hash,
  manifest_hash,
  app_commit
)
values (
  '008907_atomic_active_event_snapshot',
  null,
  null,
  null
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
