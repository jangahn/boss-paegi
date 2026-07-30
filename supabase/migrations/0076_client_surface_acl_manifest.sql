-- 0076: public Data API client surface exact ACL manifest.
--
-- Production had legacy default grants that were absent from fresh local
-- Supabase: authenticated users could bypass application/RPC validation and
-- INSERT directly into scores/dolls, while several RLS tables also retained
-- TRUNCATE/TRIGGER/REFERENCES privileges.  RLS is not a substitute for an
-- exact privilege boundary (and does not protect TRUNCATE).
--
-- Keep only the browser reads used by the application and the active-account
-- nickname write. Deleted profiles stay scrubbed through exact RLS plus a
-- trigger backstop. Raw scores and ranking projections are consumed exclusively
-- by server routes so pending/voided rows cannot be recovered through Data API.
-- Everything else remains server/RPC-only.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Fix the source of the production drift.  Hosted projects created with the
-- legacy "auto expose" default granted every future table/function/sequence
-- created by the application migration role (`postgres`) to Data API roles.
-- Fresh/local defaults also retained non-obvious
-- TRUNCATE/TRIGGER/REFERENCES privileges.  Future objects must start denied
-- and opt in explicitly in their own migration.
alter default privileges for role postgres in schema public
  revoke all privileges on tables
  from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences
  from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on functions
  from public, anon, authenticated, service_role;
-- Hosted Supabase also owns platform defaults as `supabase_admin`; the
-- project `postgres` role is intentionally not a member and cannot alter
-- them.  Repository migrations run as `postgres`, while exact current-object
-- revokes below also close any platform-created public helper.

do $$
begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.dolls') is null
     or to_regclass('public.member_accounts') is null
     or to_regclass('public.scores') is null
     or to_regclass('public.score_highlights') is null
     or to_regclass('public.score_stats') is null
     or to_regclass('public.user_badges') is null
     or to_regclass('public.ai_generations') is null then
    raise exception '0076 preflight: required public table missing';
  end if;
end;
$$;

-- Remove both legacy table grants and the one historical independent column
-- grant before rebuilding the allowlist.  REVOKE table privileges does not
-- remove a column-level ACL.
revoke all privileges on table
  public.ai_generations,
  public.dolls,
  public.member_accounts,
  public.profiles,
  public.score_highlights,
  public.score_stats,
  public.scores,
  public.user_badges
from public, anon, authenticated;

revoke all privileges (display_name)
  on table public.profiles
  from public, anon, authenticated;

-- A production-only legacy audit table may still exist even though fresh
-- repository rebuilds no longer create it.  Preserve its rows but make it
-- unreachable from Data API client roles.
do $$
begin
  if to_regclass('public.doll_owner_migration_log') is not null then
    execute
      'revoke all privileges on table public.doll_owner_migration_log '
      || 'from public, anon, authenticated';
  end if;
end;
$$;

-- Exact browser table surface.
grant select on table
  public.dolls,
  public.member_accounts,
  public.profiles,
  public.score_highlights,
  public.score_stats,
  public.user_badges
to anon, authenticated;

-- Rolling expand exception: the currently deployed doll route removes the
-- Storage object before its owner-scoped browser DELETE. Keep that exact
-- self-delete capability until the 0079 outbox-aware app is live; 0092 closes
-- it. Removing it here would leave a public row pointing at a missing object.
grant delete on table public.dolls to authenticated;

grant update (display_name) on table public.profiles to authenticated;
drop policy if exists "profiles: self update" on public.profiles;
create policy "profiles: self update"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id and deleted_at is null)
  with check (auth.uid() = id and deleted_at is null);

-- Inserts are server/RPC-only.  These legacy policies would otherwise reopen
-- the bypass if a broad default grant returned.
drop policy if exists "dolls: owner insert" on public.dolls;
drop policy if exists "dolls: owner delete" on public.dolls;
create policy "dolls: owner delete"
  on public.dolls
  for delete
  to authenticated
  using (auth.uid() = owner_id and deleted_at is null);
drop policy if exists "profiles: self insert" on public.profiles;
drop policy if exists "scores: owner insert" on public.scores;

-- Trigger/internal helpers must not appear as callable Data API RPCs.
revoke all on function public.handle_new_user()
  from public, anon, authenticated;
revoke all on function public.random_nickname()
  from public, anon, authenticated;
revoke all on function public.set_updated_at_and_version()
  from public, anon, authenticated;
revoke all on function public.analytics_events_set_day_kst()
  from public, anon, authenticated;
revoke all on function public.like_escape(text)
  from public, anon, authenticated;
revoke all on function public.bp_reject_deleted_profile_update()
  from public, anon, authenticated, service_role;
do $$
begin
  -- Hosted Supabase may install this event-trigger helper while a fresh local
  -- project does not.  Event triggers do not require Data API EXECUTE.
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute
      'revoke all on function public.rls_auto_enable() '
      || 'from public, anon, authenticated';
  end if;
end;
$$;

-- Public pages obtain ranking projections from server routes. Direct Data API
-- access would bypass route response validation and the server-only score
-- boundary, so only service_role may invoke either projection.
revoke all on function public.get_leaderboard(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_leaderboard(text, integer)
  to service_role;
revoke all on function public.get_score_percentile(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_score_percentile(integer)
  to service_role;

-- Exact table/column/policy/function postflight.  Any future default-grant
-- drift aborts the migration instead of silently widening the API.
do $$
declare
  v_count int;
begin
  if exists (
    select 1
      from pg_catalog.pg_default_acl d
      join pg_catalog.pg_roles owner_role on owner_role.oid = d.defaclrole
      join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral pg_catalog.aclexplode(d.defaclacl) acl
      left join pg_catalog.pg_roles grantee_role
        on grantee_role.oid = acl.grantee
     where owner_role.rolname = 'postgres'
       and n.nspname = 'public'
       and d.defaclobjtype in ('r', 'S', 'f')
       and (
         acl.grantee = 0
         or grantee_role.rolname in (
           'anon',
           'authenticated',
           'service_role'
         )
       )
  ) then
    raise exception '0076 postflight: permissive public default ACL remains';
  end if;

  with expected(table_name, grantee, privilege_type) as (
    values
      ('dolls', 'anon', 'SELECT'),
      ('dolls', 'authenticated', 'SELECT'),
      ('dolls', 'authenticated', 'DELETE'),
      ('member_accounts', 'anon', 'SELECT'),
      ('member_accounts', 'authenticated', 'SELECT'),
      ('profiles', 'anon', 'SELECT'),
      ('profiles', 'authenticated', 'SELECT'),
      ('score_highlights', 'anon', 'SELECT'),
      ('score_highlights', 'authenticated', 'SELECT'),
      ('score_stats', 'anon', 'SELECT'),
      ('score_stats', 'authenticated', 'SELECT'),
      ('user_badges', 'anon', 'SELECT'),
      ('user_badges', 'authenticated', 'SELECT')
  ),
  actual as (
    select g.table_name, g.grantee, g.privilege_type
      from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.table_name in (
         'ai_generations',
         'dolls',
         'member_accounts',
         'profiles',
         'score_highlights',
         'score_stats',
         'scores',
         'user_badges',
         'doll_owner_migration_log'
       )
       and g.grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  drift as (
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)
  )
  select count(*) into v_count from drift;
  if v_count <> 0 then
    raise exception '0076 postflight: client table ACL drift (%)', v_count;
  end if;

  with expected(table_name, column_name, grantee, privilege_type) as (
    values ('profiles', 'display_name', 'authenticated', 'UPDATE')
  ),
  actual as (
    select g.table_name, g.column_name, g.grantee, g.privilege_type
      from information_schema.role_column_grants g
     where g.table_schema = 'public'
       and g.table_name in (
         'ai_generations',
         'dolls',
         'member_accounts',
         'profiles',
         'score_highlights',
         'score_stats',
         'scores',
         'user_badges',
         'doll_owner_migration_log'
       )
       and g.grantee in ('anon', 'authenticated', 'PUBLIC')
       and g.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
  ),
  drift as (
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)
  )
  select count(*) into v_count from drift;
  if v_count <> 0 then
    raise exception '0076 postflight: client column ACL drift (%)', v_count;
  end if;

  if (
    select count(*)
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.profiles'::regclass
       and p.polcmd = 'w'
  ) <> 1
     or not exists (
       select 1
         from pg_catalog.pg_policy p
        where p.polrelid = 'public.profiles'::regclass
          and p.polname = 'profiles: self update'
          and p.polcmd = 'w'
          and p.polpermissive
          and p.polroles = array[
            (select r.oid from pg_catalog.pg_roles r
              where r.rolname = 'authenticated')
          ]::oid[]
          and pg_catalog.pg_get_expr(p.polqual, p.polrelid)
            = '((auth.uid() = id) AND (deleted_at IS NULL))'
          and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
            = '((auth.uid() = id) AND (deleted_at IS NULL))'
     ) then
    raise exception '0076 postflight: active-only profile update policy drift';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.profiles'::regclass
       and tgname = 'trg_profiles_reject_deleted_display_name_update'
       and tgenabled = 'O'
       and not tgisinternal
  ) then
    raise exception '0076 postflight: deleted-profile nickname guard missing';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_policy p
      join pg_catalog.pg_class c on c.oid = p.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('dolls', 'profiles', 'scores')
       and p.polcmd in ('a', '*')
  ) then
    raise exception '0076 postflight: client INSERT policy remains';
  end if;

  if has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     or has_function_privilege(
       'authenticated',
       'public.set_updated_at_and_version()',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.bp_reject_deleted_profile_update()',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.bp_reject_deleted_profile_update()',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_profile_update()',
       'EXECUTE'
     )
     or has_function_privilege('anon', 'public.like_escape(text)', 'EXECUTE')
     or (
       to_regprocedure('public.rls_auto_enable()') is not null
       and has_function_privilege(
         'anon',
         to_regprocedure('public.rls_auto_enable()'),
         'EXECUTE'
       )
     )
     or has_function_privilege(
       'anon',
       'public.get_leaderboard(text,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.get_leaderboard(text,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.get_score_percentile(integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.get_score_percentile(integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.get_leaderboard(text,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.get_score_percentile(integer)',
       'EXECUTE'
     ) then
    raise exception '0076 postflight: client function ACL drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0076_client_surface_acl_manifest', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
