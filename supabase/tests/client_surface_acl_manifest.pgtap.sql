-- 0076 exact Data API client surface.

begin;
select plan(26);

select is(
  (
    select count(*)::int
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
  ),
  0,
  'future public tables/functions/sequences start default-deny'
);

select ok(
  has_table_privilege('anon', 'public.dolls', 'SELECT')
  and has_table_privilege('anon', 'public.member_accounts', 'SELECT')
  and has_table_privilege('anon', 'public.profiles', 'SELECT')
  and has_table_privilege('anon', 'public.score_highlights', 'SELECT')
  and has_table_privilege('anon', 'public.score_stats', 'SELECT')
  and has_table_privilege('anon', 'public.user_badges', 'SELECT')
  and not has_table_privilege('anon', 'public.scores', 'SELECT'),
  'anon has intended browser reads but no raw score access'
);

select ok(
  has_table_privilege('authenticated', 'public.dolls', 'SELECT')
  and has_table_privilege('authenticated', 'public.member_accounts', 'SELECT')
  and has_table_privilege('authenticated', 'public.profiles', 'SELECT')
  and has_table_privilege('authenticated', 'public.score_highlights', 'SELECT')
  and has_table_privilege('authenticated', 'public.score_stats', 'SELECT')
  and has_table_privilege('authenticated', 'public.user_badges', 'SELECT')
  and not has_table_privilege(
    'authenticated',
    'public.scores',
    'SELECT'
  ),
  'authenticated has intended browser reads but no raw score access'
);

select ok(
  not has_table_privilege('authenticated', 'public.dolls', 'DELETE'),
  'authenticated doll delete must use the durable cleanup RPC'
);
select ok(
  not has_table_privilege('anon', 'public.dolls', 'DELETE'),
  'anon cannot delete dolls'
);

select is(
  (
    select count(*)::int
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
       and g.privilege_type <> 'SELECT'
  ),
  0,
  'no unexpected client table privilege remains'
);

select ok(
  has_column_privilege(
    'authenticated',
    'public.profiles',
    'display_name',
    'UPDATE'
  ),
  'authenticated can update only the intended nickname column'
);
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
  and not has_column_privilege(
    'authenticated',
    'public.profiles',
    'avatar_url',
    'UPDATE'
  )
  and not has_column_privilege(
    'authenticated',
    'public.profiles',
    'deleted_at',
    'UPDATE'
  ),
  'authenticated cannot update profile identity/lifecycle columns'
);

select is(
  (
    select count(*)::int
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
       and not (
         g.table_name = 'profiles'
         and g.column_name = 'display_name'
         and g.grantee = 'authenticated'
         and g.privilege_type = 'UPDATE'
       )
  ),
  0,
  'no unexpected client column write privilege remains'
);

select is(
  (
    select count(*)::int
      from pg_catalog.pg_policy p
      join pg_catalog.pg_class c on c.oid = p.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('dolls', 'profiles', 'scores')
       and p.polcmd in ('a', '*')
  ),
  0,
  'legacy direct INSERT policies are absent'
);

select ok(
  (
    select count(*) = 1
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.profiles'::regclass
       and p.polcmd = 'w'
  )
  and exists (
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
         = '((auth.uid() = id) AND (deleted_at IS NULL) AND oauth_current_auth_session_live())'
       and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
         = '((auth.uid() = id) AND (deleted_at IS NULL) AND oauth_current_auth_session_live())'
  ),
  'profile nickname RLS is exactly active authenticated self-update'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_trigger
     where tgrelid = 'public.profiles'::regclass
       and tgname = 'trg_profiles_reject_deleted_display_name_update'
       and tgenabled = 'O'
       and not tgisinternal
  ),
  1,
  'deleted-profile nickname trigger is installed and enabled'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.bp_reject_deleted_profile_update()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bp_reject_deleted_profile_update()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_reject_deleted_profile_update()',
    'EXECUTE'
  ),
  'deleted-profile nickname helper is not callable through Data API roles'
);

select ok(
  not has_table_privilege('anon', 'public.ai_generations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.ai_generations', 'SELECT')
  and not has_table_privilege('anon', 'public.ai_generations', 'TRUNCATE')
  and not has_table_privilege(
    'authenticated',
    'public.ai_generations',
    'TRUNCATE'
  ),
  'generation state remains server-only'
);

select ok(
  coalesce(
    not has_table_privilege(
      'anon',
      to_regclass('public.doll_owner_migration_log'),
      'SELECT'
    ),
    true
  )
  and coalesce(
    not has_table_privilege(
      'authenticated',
      to_regclass('public.doll_owner_migration_log'),
      'INSERT'
    ),
    true
  )
  and coalesce(
    not has_table_privilege(
      'authenticated',
      to_regclass('public.doll_owner_migration_log'),
      'TRUNCATE'
    ),
    true
  ),
  'legacy owner-migration ledger is client-inaccessible when present'
);

select ok(
  not has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE'),
  'auth trigger function is not a client RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.random_nickname()',
    'EXECUTE'
  ),
  'nickname helper is not a client RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.set_updated_at_and_version()',
    'EXECUTE'
  ),
  'audit trigger function is not a client RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.analytics_events_set_day_kst()',
    'EXECUTE'
  ),
  'analytics trigger function is not a client RPC'
);
select ok(
  not has_function_privilege('anon', 'public.like_escape(text)', 'EXECUTE'),
  'internal search escaping helper is not a client RPC'
);
select ok(
  coalesce(
    not has_function_privilege(
      'anon',
      to_regprocedure('public.rls_auto_enable()'),
      'EXECUTE'
    ),
    true
  ),
  'hosted RLS event-trigger helper is not a client RPC when present'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.get_leaderboard(text,integer)',
    'EXECUTE'
  ),
  'anon cannot bypass the server leaderboard route'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_leaderboard(text,integer)',
    'EXECUTE'
  ),
  'authenticated cannot bypass the server leaderboard route'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_score_percentile(integer)',
    'EXECUTE'
  ),
  'anon cannot call the score percentile projection'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_score_percentile(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_leaderboard(text,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_score_percentile(integer)',
    'EXECUTE'
  ),
  'ranking projections remain available only to server routes'
);

select is(
  (
    select count(*)::int
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
       and g.grantee = 'PUBLIC'
  ),
  0,
  'SQL PUBLIC pseudo-role has no table grant'
);

select * from finish();
rollback;
