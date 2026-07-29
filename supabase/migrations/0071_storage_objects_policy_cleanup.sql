-- Private character and highlight objects are accessed only through server-issued
-- signed URLs or signed upload tokens. Dashboard-created policies once granted
-- the public role bucket-wide SELECT and owner-folder INSERT access without a
-- bucket predicate, which made every private object anonymously readable.
--
-- Keep storage.objects closed to anon/authenticated clients. Server-side
-- operations use the service-role client and bypass RLS.

drop policy if exists "dolls 1l0lmw_0" on storage.objects;
drop policy if exists "dolls 1l0lmw_1" on storage.objects;

do $$
begin
  if not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage'
       and c.relname = 'objects'
       and c.relrowsecurity
  ) then
    raise exception '0071 postflight: storage.objects RLS must remain enabled';
  end if;

  if exists (
    select 1
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
  ) then
    raise exception '0071 postflight: storage.objects must have no client policies';
  end if;
end $$;
