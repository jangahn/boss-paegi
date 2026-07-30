-- Face-bearing generated media and highlight clips must never be raw-path public.

begin;
select plan(6);

select is(
  (select b.public from storage.buckets b where b.id = 'dolls'),
  false,
  'dolls bucket is private'
);
select is(
  (select b.public from storage.buckets b where b.id = 'highlights'),
  false,
  'highlights bucket is private'
);
select is(
  (select b.public from storage.buckets b where b.id = 'avatars'),
  true,
  'avatars bucket remains intentionally public'
);
select ok(
  (select b.public from storage.buckets b where b.id = 'events')
  and
  (select b.public from storage.buckets b where b.id = 'site-assets'),
  'event and site asset buckets remain intentionally public'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'storage.objects'::regclass
  ),
  'storage objects retain row-level security'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_policy p
     where p.polrelid = 'storage.objects'::regclass
  ),
  0,
  'no anon/auth policy can bypass private signed-URL access'
);

select * from finish();
rollback;
