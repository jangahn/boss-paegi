-- 008906: restore the service-only dependency ACL for admin search RPCs.
--
-- 0076 correctly removed the LIKE escaping helper from the browser Data API
-- surface, but search_members/search_orders remain SECURITY INVOKER functions.
-- Revoking the default PUBLIC grant without granting service_role made both
-- trusted admin projections fail at runtime with SQLSTATE 42501.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regprocedure('public.like_escape(text)') is null
     or to_regprocedure(
       'public.search_members(text,integer)'
     ) is null
     or to_regprocedure(
       'public.search_orders(text,text,integer,integer)'
     ) is null then
    raise exception '008906 preflight: admin search functions missing';
  end if;
end;
$preflight$;

revoke all on function public.like_escape(text)
  from public, anon, authenticated, service_role;
grant execute on function public.like_escape(text)
  to service_role;

do $verify$
begin
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.like_escape(text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.like_escape(text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.like_escape(text)',
       'EXECUTE'
     ) then
    raise exception '008906 verification: like_escape ACL drift';
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
  '008906_admin_search_helper_acl',
  null,
  null,
  null
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
