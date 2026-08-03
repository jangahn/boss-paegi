-- storage_cleanup_intents.pgtap.sql — 0079 upload intent/object outbox 검증.
-- Storage 자체는 외부 부작용이므로 DB receipt, ownership, freshness, lease
-- fencing 및 참조 상태의 원자 수렴을 이 disposable transaction에서 검증한다.

begin;
select plan(82);

select has_table(
  'public',
  'storage_upload_intents',
  'signed-upload intent table exists'
);
select has_table(
  'public',
  'storage_object_cleanup_jobs',
  'detached-object cleanup outbox exists'
);
select has_table(
  'public',
  'storage_legacy_upload_sweep_control',
  'legacy-token rollout inventory window exists'
);
select has_table(
  'public',
  'storage_legacy_upload_protections',
  'referenced legacy rollout assets have a protection ledger'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.storage_upload_intents'::regclass
  ),
  true,
  'upload intents have RLS enabled'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.storage_object_cleanup_jobs'::regclass
  ),
  true,
  'object cleanup jobs have RLS enabled'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid =
       'public.storage_legacy_upload_sweep_control'::regclass
  ),
  true,
  'legacy upload sweep control has RLS enabled'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid =
       'public.storage_legacy_upload_protections'::regclass
  ),
  true,
  'legacy upload protections have RLS enabled'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.storage_upload_intents',
    'SELECT'
  ),
  'upload intents are RPC-only'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.storage_object_cleanup_jobs',
    'SELECT'
  ),
  'object cleanup jobs are RPC-only'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.enqueue_legacy_signed_upload_orphans(integer)',
    'EXECUTE'
  ),
  'legacy orphan inventory scan is service-only operational work'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.enqueue_legacy_signed_upload_orphans(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.enqueue_legacy_signed_upload_orphans(integer)',
    'EXECUTE'
  ),
  'browser roles cannot nominate Storage objects for cleanup'
);
select ok(
  not has_table_privilege('authenticated', 'public.dolls', 'DELETE'),
  'browser cannot bypass doll cleanup receipt with DELETE'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_policy
     where polrelid = 'public.dolls'::regclass
       and polcmd = 'd'
  ),
  0,
  'dolls expose no DELETE RLS policy'
);
select has_trigger(
  'public',
  'app_settings',
  'trg_app_settings_attach_upload_intents',
  'site asset references attach intents'
);
select has_trigger(
  'public',
  'events',
  'trg_events_attach_upload_intents',
  'event references attach intents'
);
select has_trigger(
  'public',
  'dolls',
  'trg_zz_dolls_attach_upload_intent',
  'doll inserts attach intents'
);
select has_trigger(
  'public',
  'score_highlights',
  'trg_zz_score_highlights_attach_upload_intent',
  'highlight inserts attach intents'
);
select ok(
  pg_get_constraintdef(
    (
      select oid
        from pg_catalog.pg_constraint
       where conrelid = 'public.storage_object_cleanup_jobs'::regclass
         and conname = 'storage_object_cleanup_jobs_bucket_check'
    )
  ) like '%highlights%',
  'expired highlight objects are allowed in the generic outbox'
);

create temporary table storage_ctx (
  admin_id uuid not null,
  user_id uuid not null,
  other_id uuid not null,
  score_id uuid not null,
  doll_id uuid not null,
  site_path text not null,
  orphan_path text not null,
  wrong_purpose_path text not null,
  avatar_old_path text not null,
  avatar_new_path text not null,
  highlight_path text not null,
  doll_path text not null,
  legacy_orphan_path text not null,
  legacy_protected_path text not null,
  legacy_outside_path text not null,
  legacy_sweep jsonb,
  upload_lease_one jsonb,
  upload_lease_two jsonb,
  avatar_old_job uuid,
  avatar_clear_job uuid,
  doll_job uuid,
  object_lease_one jsonb,
  object_lease_two jsonb
) on commit drop;

do $fixture$
declare
  v_admin uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_score uuid := gen_random_uuid();
  v_doll uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values
    (v_admin, 'storage-admin-' || v_admin::text || '@test.local'),
    (v_user, 'storage-user-' || v_user::text || '@test.local'),
    (v_other, 'storage-other-' || v_other::text || '@test.local');
  insert into public.member_accounts(user_id, is_admin) values
    (v_admin, true),
    (v_user, false),
    (v_other, false);
  insert into public.scores(
    id, owner_id, score, weapon, duration_ms
  )
  values (v_score, v_user, 10, 'fist', 1000);
  update public.profiles
     set avatar_url =
       'https://project.test/storage/v1/object/public/avatars/'
       || v_user::text || '/legacy-avatar.jpg'
   where id = v_user;
  insert into storage_ctx(
    admin_id,
    user_id,
    other_id,
    score_id,
    doll_id,
    site_path,
    orphan_path,
    wrong_purpose_path,
    avatar_old_path,
    avatar_new_path,
    highlight_path,
    doll_path,
    legacy_orphan_path,
    legacy_protected_path,
    legacy_outside_path
  )
  values (
    v_admin,
    v_user,
    v_other,
    v_score,
    v_doll,
    'og/260729/' || gen_random_uuid()::text || '.webp',
    'logo/260729/' || gen_random_uuid()::text || '.png',
    '260729/' || gen_random_uuid()::text || '.png',
    v_user::text || '/legacy-avatar.jpg',
    v_user::text || '/' || gen_random_uuid()::text || '.jpg',
    v_score::text || '/' || gen_random_uuid()::text || '.webm',
    v_user::text || '/' || v_doll::text || '.png',
    'og/260729/' || gen_random_uuid()::text || '.webp',
    'logo/260729/' || gen_random_uuid()::text || '.png',
    'og/260729/' || gen_random_uuid()::text || '.jpg'
  );
end;
$fixture$;

select throws_ok(
  format(
    'select public.create_admin_storage_upload_intent(%L::uuid,%L,%L,%L)',
    (select user_id from storage_ctx),
    'site_asset_og',
    'site-assets',
    (select site_path from storage_ctx)
  ),
  'P0001',
  'not_admin',
  'non-admin cannot create an admin upload intent'
);
select throws_ok(
  format(
    'select public.create_admin_storage_upload_intent(%L::uuid,%L,%L,%L)',
    (select admin_id from storage_ctx),
    'site_asset_og',
    'site-assets',
    'og/not-canonical.png'
  ),
  'P0001',
  'invalid_upload_intent',
  'admin upload path must be canonical'
);
select lives_ok(
  format(
    'select public.create_admin_storage_upload_intent(%L::uuid,%L,%L,%L)',
    (select admin_id from storage_ctx),
    'site_asset_og',
    'site-assets',
    (select site_path from storage_ctx)
  ),
  'admin can create a canonical site upload intent'
);
insert into public.storage_upload_intents(
  owner_user_id,
  purpose,
  bucket,
  path
)
select
  admin_id,
  'site_asset_og',
  'events',
  wrong_purpose_path
from storage_ctx;
select throws_ok(
  format(
    'select public.confirm_admin_storage_upload_intent(%L::uuid,%L,%L)',
    (select admin_id from storage_ctx),
    'events',
    (select wrong_purpose_path from storage_ctx)
  ),
  'P0001',
  'upload_intent_forbidden',
  'admin confirm rejects a same-owner path whose persisted purpose mismatches its canonical namespace'
);
select throws_ok(
  format(
    'select public.confirm_admin_storage_upload_intent(%L::uuid,%L,%L)',
    (select other_id from storage_ctx),
    'site-assets',
    (select site_path from storage_ctx)
  ),
  'P0001',
  'not_admin',
  'non-admin cannot confirm an admin upload'
);
select lives_ok(
  format(
    'select public.confirm_admin_storage_upload_intent(%L::uuid,%L,%L)',
    (select admin_id from storage_ctx),
    'site-assets',
    (select site_path from storage_ctx)
  ),
  'own fresh admin intent can be confirmed'
);
select is(
  (
    select status
      from public.storage_upload_intents i
      join storage_ctx c on c.site_path = i.path
  ),
  'confirmed',
  'confirm transitions issued to confirmed'
);

insert into public.app_settings(key, value)
select
  'media_config',
  pg_catalog.jsonb_build_object(
    'ogImagePath',
    site_path,
    'logoPath',
    null
  )
from storage_ctx;
select is(
  (
    select status
      from public.storage_upload_intents i
      join storage_ctx c on c.site_path = i.path
  ),
  'attached',
  'committing the site reference atomically attaches its intent'
);
update public.app_settings
   set value = '{"ogImagePath":null,"logoPath":null}'::jsonb
 where key = 'media_config';
select is(
  (
    select status
      from public.storage_upload_intents i
      join storage_ctx c on c.site_path = i.path
  ),
  'attached',
  'detaching a published admin asset preserves its audit/rollback intent'
);
select is(
  (
    select count(*)::int
      from public.storage_object_cleanup_jobs j
      join storage_ctx c
        on j.bucket = 'site-assets'
       and j.path = c.site_path
  ),
  0,
  'detached admin site asset is intentionally not auto-purged'
);

select lives_ok(
  format(
    'select public.create_admin_storage_upload_intent(%L::uuid,%L,%L,%L)',
    (select admin_id from storage_ctx),
    'site_asset_logo',
    'site-assets',
    (select orphan_path from storage_ctx)
  ),
  'a second unattached intent can be issued'
);
update public.storage_upload_intents
   set cleanup_after = clock_timestamp() - interval '1 second',
       next_attempt_at = clock_timestamp() - interval '1 second'
 where path = (select orphan_path from storage_ctx);
update storage_ctx
   set upload_lease_one = public.claim_storage_upload_cleanup(120);
select is(
  upload_lease_one->>'path',
  orphan_path,
  'expired unattached intent is claimable'
)
from storage_ctx;
select is(
  (upload_lease_one->>'lease_version')::int,
  1,
  'first upload cleanup claim gets fence version one'
)
from storage_ctx;
select throws_ok(
  format(
    'select public.finish_storage_upload_cleanup(%L::uuid,%L::uuid,%s,true,null)',
    (select upload_lease_one->>'job_id' from storage_ctx),
    gen_random_uuid(),
    1
  ),
  'P0001',
  'cleanup_lease_lost',
  'wrong upload cleanup token cannot finish'
);
select is(
  (
    select public.finish_storage_upload_cleanup(
             (upload_lease_one->>'job_id')::uuid,
             (upload_lease_one->>'lease_token')::uuid,
             (upload_lease_one->>'lease_version')::int,
             false,
             'injected remove error'
           )->>'status'
      from storage_ctx
  ),
  'pending',
  'failed upload removal remains durable for retry'
);
update public.storage_upload_intents
   set next_attempt_at = clock_timestamp() - interval '1 second'
 where path = (select orphan_path from storage_ctx);
update storage_ctx
   set upload_lease_two = public.claim_storage_upload_cleanup(120);
select is(
  (upload_lease_two->>'lease_version')::int,
  2,
  'upload cleanup retry advances the lease fence'
)
from storage_ctx;
select is(
  (
    select public.finish_storage_upload_cleanup(
             (upload_lease_two->>'job_id')::uuid,
             (upload_lease_two->>'lease_token')::uuid,
             (upload_lease_two->>'lease_version')::int,
             true,
             null
           )->>'status'
      from storage_ctx
  ),
  'cleaned',
  'current upload cleanup lease reaches cleaned'
);
select throws_ok(
  format(
    'select public.finish_storage_upload_cleanup(%L::uuid,%L::uuid,%s,true,null)',
    (select upload_lease_one->>'job_id' from storage_ctx),
    (select upload_lease_one->>'lease_token' from storage_ctx),
    (select (upload_lease_one->>'lease_version')::int from storage_ctx)
  ),
  'P0001',
  'cleanup_lease_lost',
  'stale upload cleanup lease cannot overwrite the winner'
);

select throws_ok(
  format(
    'select public.create_avatar_upload_intent(%L::uuid,%L)',
    (select user_id from storage_ctx),
    (select other_id::text || '/' || gen_random_uuid()::text || '.jpg'
       from storage_ctx)
  ),
  'P0001',
  'invalid_upload_intent',
  'avatar intent rejects another user folder'
);
select lives_ok(
  format(
    'select public.create_avatar_upload_intent(%L::uuid,%L)',
    (select user_id from storage_ctx),
    (select avatar_new_path from storage_ctx)
  ),
  'avatar intent is created before signed upload'
);
select throws_ok(
  format(
    'select public.confirm_avatar_upload_intent(%L::uuid,%L)',
    (select other_id from storage_ctx),
    (select avatar_new_path from storage_ctx)
  ),
  'P0001',
  'upload_intent_forbidden',
  'a different user cannot confirm the avatar intent'
);
select lives_ok(
  format(
    'select public.confirm_avatar_upload_intent(%L::uuid,%L)',
    (select user_id from storage_ctx),
    (select avatar_new_path from storage_ctx)
  ),
  'owner can confirm the fresh avatar upload'
);
update storage_ctx c
   set avatar_old_job = (
     public.request_avatar_replace(
       c.user_id,
       c.avatar_new_path,
       'https://project.test/storage/v1/object/public/avatars/'
         || c.avatar_new_path
     )->>'job_id'
   )::uuid;
select is(
  (
    select public.bp_account_cleanup_storage_path(
             p.avatar_url,
             'avatars'
           )
      from public.profiles p
      join storage_ctx c on c.user_id = p.id
  ),
  (select avatar_new_path from storage_ctx),
  'avatar replace commits the new DB reference'
);
select is(
  (
    select status
      from public.storage_upload_intents i
      join storage_ctx c on c.avatar_new_path = i.path
  ),
  'attached',
  'avatar replace atomically attaches the new intent'
);
select is(
  (
    select path
      from public.storage_object_cleanup_jobs j
      join storage_ctx c on c.avatar_old_job = j.id
  ),
  (select avatar_old_path from storage_ctx),
  'avatar replace durably enqueues the detached old object'
);
select is(
  (
    select public.request_avatar_replace(
             c.user_id,
             c.avatar_new_path,
             'https://project.test/storage/v1/object/public/avatars/'
               || c.avatar_new_path
           )->>'job_id'
      from storage_ctx c
  ),
  (select avatar_old_job::text from storage_ctx),
  'lost avatar-replace response replays the pending cleanup receipt'
);
select is(
  (
    select count(*)::int
      from public.storage_object_cleanup_jobs j
      join storage_ctx c
        on j.bucket = 'avatars'
       and j.path = c.avatar_old_path
  ),
  1,
  'avatar-replace replay does not duplicate its cleanup receipt'
);
update storage_ctx c
   set avatar_clear_job = (
     public.request_avatar_clear(c.user_id)->>'job_id'
   )::uuid;
select is(
  (
    select status
      from public.storage_object_cleanup_jobs j
      join storage_ctx c on c.avatar_clear_job = j.id
  ),
  'pending',
  'avatar clear enqueues the newly detached object'
);
select is(
  (
    select public.request_avatar_clear(user_id)->>'job_id'
      from storage_ctx
  ),
  (select avatar_clear_job::text from storage_ctx),
  'lost avatar-clear response replays the pending cleanup receipt'
);
select is(
  (
    select count(*)::int
      from public.storage_object_cleanup_jobs j
      join storage_ctx c
        on j.bucket = 'avatars'
       and j.path = c.avatar_new_path
  ),
  1,
  'avatar-clear replay does not duplicate its cleanup receipt'
);
select ok(
  (
    select avatar_url is null
      from public.profiles p
      join storage_ctx c on c.user_id = p.id
  ),
  'avatar clear changes DB state before Storage deletion'
);

select lives_ok(
  format(
    'select public.create_highlight_upload_intent(%L::uuid,%L::uuid,%L)',
    (select user_id from storage_ctx),
    (select score_id from storage_ctx),
    (select highlight_path from storage_ctx)
  ),
  'highlight intent is created for an owned publishable score'
);
select throws_ok(
  format(
    'select public.confirm_highlight_upload_intent(%L::uuid,%L::uuid,%L)',
    (select other_id from storage_ctx),
    (select score_id from storage_ctx),
    (select highlight_path from storage_ctx)
  ),
  'P0001',
  'forbidden',
  'another user cannot confirm the highlight'
);
select lives_ok(
  format(
    'select public.confirm_highlight_upload_intent(%L::uuid,%L::uuid,%L)',
    (select user_id from storage_ctx),
    (select score_id from storage_ctx),
    (select highlight_path from storage_ctx)
  ),
  'highlight owner can confirm the upload'
);
insert into public.score_highlights(
  score_id,
  highlight_clip_path,
  highlight_status,
  highlight_expires_at
)
select
  score_id,
  highlight_path,
  'ready',
  clock_timestamp() - interval '1 second'
from storage_ctx;
select is(
  (
    select status
      from public.storage_upload_intents i
      join storage_ctx c on c.highlight_path = i.path
  ),
  'attached',
  'highlight insert atomically attaches its intent'
);
select is(
  public.request_expired_highlight_cleanup(10)->>'processed',
  '1',
  'expired-highlight sweep tombstones one DB reference'
);
select ok(
  (
    select highlight_deleted_at is not null
      from public.score_highlights h
      join storage_ctx c on c.score_id = h.score_id
  ),
  'expired highlight is tombstoned'
);
select is(
  (
    select kind || '|' || bucket || '|' || path
      from public.storage_object_cleanup_jobs j
      join storage_ctx c
        on j.subject_id = c.score_id
       and j.kind = 'highlight_expired'
  ),
  (
    select 'highlight_expired|highlights|' || highlight_path
      from storage_ctx
  ),
  'expired highlight gets a retryable highlights-bucket cleanup job'
);

select lives_ok(
  format(
    'select public.create_doll_upload_intent(%L::uuid,%L::uuid,%L)',
    (select user_id from storage_ctx),
    (select doll_id from storage_ctx),
    (select doll_path from storage_ctx)
  ),
  'server doll upload creates a durable intent before upload'
);
insert into public.dolls(id, owner_id, image_url)
select
  doll_id,
  user_id,
  'https://project.test/storage/v1/object/public/dolls/' || doll_path
from storage_ctx;
select is(
  (
    select status
      from public.storage_upload_intents i
      join storage_ctx c on c.doll_path = i.path
  ),
  'attached',
  'doll DB insert atomically attaches its upload intent'
);
select is(
  (
    select public.request_doll_role_update(
             user_id,
             doll_id,
             'client'
           )->>'role'
      from storage_ctx
  ),
  'client',
  'role update goes through the lifecycle-fenced RPC'
);
update storage_ctx c
   set doll_job = (
     public.request_doll_delete(c.user_id, c.doll_id)->>'job_id'
   )::uuid;
select is(
  (
    select count(*)::int
      from public.dolls d
      join storage_ctx c on c.doll_id = d.id
  ),
  0,
  'doll row is deleted in the outbox transaction'
);
select is(
  (
    select kind || '|' || bucket || '|' || path
      from public.storage_object_cleanup_jobs j
      join storage_ctx c on c.doll_job = j.id
  ),
  (
    select 'doll_delete|dolls|' || doll_path
      from storage_ctx
  ),
  'doll delete leaves an exact durable Storage receipt'
);
select is(
  (
    select public.request_doll_delete(user_id, doll_id)->>'already_deleted'
      from storage_ctx
  ),
  'true',
  'lost doll-delete response is safely repeatable'
);

update storage_ctx c
   set object_lease_one = public.claim_storage_object_cleanup(c.doll_job, 120);
select is(
  object_lease_one->>'job_id',
  doll_job::text,
  'specific object cleanup job is claimable'
)
from storage_ctx;
select is(
  public.claim_storage_object_cleanup(doll_job, 120),
  null::jsonb,
  'unexpired object lease cannot be claimed twice'
)
from storage_ctx;
select is(
  (
    select public.finish_storage_object_cleanup(
             (object_lease_one->>'job_id')::uuid,
             (object_lease_one->>'lease_token')::uuid,
             (object_lease_one->>'lease_version')::int,
             false,
             'injected object remove failure'
           )->>'status'
      from storage_ctx
  ),
  'pending',
  'object removal failure remains retryable'
);
update public.storage_object_cleanup_jobs
   set next_attempt_at = clock_timestamp() - interval '1 second'
 where id = (select doll_job from storage_ctx);
update storage_ctx c
   set object_lease_two =
     public.claim_storage_object_cleanup(c.doll_job, 120);
select is(
  (object_lease_two->>'lease_version')::int,
  2,
  'object retry advances the lease fence'
)
from storage_ctx;
select is(
  (
    select public.finish_storage_object_cleanup(
             (object_lease_two->>'job_id')::uuid,
             (object_lease_two->>'lease_token')::uuid,
             (object_lease_two->>'lease_version')::int,
             true,
             null
           )->>'status'
      from storage_ctx
  ),
  'completed',
  'current object lease completes cleanup'
);
select throws_ok(
  format(
    'select public.finish_storage_object_cleanup(%L::uuid,%L::uuid,%s,true,null)',
    (select object_lease_one->>'job_id' from storage_ctx),
    (select object_lease_one->>'lease_token' from storage_ctx),
    (select (object_lease_one->>'lease_version')::int from storage_ctx)
  ),
  'P0001',
  'cleanup_lease_lost',
  'stale object lease cannot overwrite completion'
);
select is(
  (
    select count(*)::int
      from public.storage_upload_intents
     where status = 'cleaned'
  ),
  1,
  'only the unattached orphan intent was swept'
);
select ok(
  (
    select count(*) >= 3
      from public.storage_object_cleanup_jobs
     where status in ('pending', 'completed')
  ),
  'avatar, highlight and doll detach paths all retain durable receipts'
);

select is(
  (
    select enabled_at is not null
       and window_ends_at =
         enabled_at + interval '2 hours 5 minutes'
      from public.storage_legacy_upload_sweep_control
     where singleton = true
  ),
  true,
  'contract migration activates one exact old-token sweep horizon'
);
select is(
  public.bp_legacy_signed_upload_purpose(
    'site-assets',
    'og/not-a-generated-object.svg'
  ),
  null::text,
  'inventory classifier fails closed outside canonical generated paths'
);

insert into storage.buckets(id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do nothing;
update public.storage_legacy_upload_sweep_control
   set inventory_floor_at =
         transaction_timestamp() - interval '1 day',
       enabled_at = transaction_timestamp() - interval '1 hour',
       window_ends_at =
         transaction_timestamp() + interval '1 hour 5 minutes'
 where singleton = true;
insert into storage.objects(bucket_id, name, created_at, updated_at)
select 'site-assets', legacy_orphan_path,
       transaction_timestamp() - interval '4 hours',
       transaction_timestamp() - interval '4 hours'
  from storage_ctx
union all
select 'site-assets', legacy_protected_path,
       transaction_timestamp() - interval '4 hours',
       transaction_timestamp() - interval '4 hours'
  from storage_ctx
union all
select 'site-assets', legacy_outside_path,
       transaction_timestamp() - interval '2 days',
       transaction_timestamp() - interval '2 days'
  from storage_ctx;

-- Reference-first ordering: the attach trigger shares the scanner's path lock.
-- With no intent row, the scanner must preserve rather than enqueue this path.
update public.app_settings a
   set value = pg_catalog.jsonb_build_object(
     'ogImagePath', null,
     'logoPath', c.legacy_protected_path
   )
  from storage_ctx c
 where a.key = 'media_config';
update storage_ctx
   set legacy_sweep = public.enqueue_legacy_signed_upload_orphans(10);
select is(
  legacy_sweep,
  '{"ok":true,"enabled":true,"examined":2,"enqueued":1,"protected":1}'::jsonb,
  'bounded scan distinguishes one orphan from one committed reference'
)
from storage_ctx;
select is(
  (
    select i.status || '|' || i.purpose || '|' || i.owner_user_id::text
      from public.storage_upload_intents i
      join storage_ctx c on c.legacy_orphan_path = i.path
     where i.bucket = 'site-assets'
  ),
  'pending|site_asset_og|00000000-0000-4000-8000-000000000000',
  'untracked orphan becomes an exact immediately retryable fenced receipt'
);
select is(
  (
    select p.reason
      from public.storage_legacy_upload_protections p
      join storage_ctx c on c.legacy_protected_path = p.path
     where p.bucket = 'site-assets'
  ),
  'scanner_reference_guard',
  'reference-first asset gets a durable do-not-reclassify proof'
);
select is(
  (
    select count(*)::int
      from public.storage_upload_intents i
      join storage_ctx c on c.legacy_protected_path = i.path
  ),
  0,
  'a referenced legacy asset never receives a deletion receipt'
);
select throws_ok(
  format(
    $sql$
      update public.app_settings
         set value = jsonb_build_object(
           'ogImagePath', %L,
           'logoPath', null
         )
       where key = 'media_config'
    $sql$,
    (select legacy_orphan_path from storage_ctx)
  ),
  'P0001',
  'upload_cleanup_in_progress',
  'cleanup-receipt-first ordering atomically rejects a later attach'
);
select is(
  (
    select count(*)::int
      from public.storage_upload_intents i
      join storage_ctx c on c.legacy_outside_path = i.path
  ),
  0,
  'objects before the recorded expand floor are never cleanup candidates'
);
select is(
  (
    select count(*)::int
      from public.storage_legacy_upload_protections p
      join storage_ctx c on c.legacy_outside_path = p.path
  ),
  0,
  'objects outside the finite rollout window are not reclassified as protected'
);

-- ── 부활 upsert 는 새 수명주기 — attempt_count 를 승계하지 않는다 (0102) ──────
update public.storage_object_cleanup_jobs j
   set status = 'completed',
       completed_at = clock_timestamp(),
       attempt_count = 9,
       lease_token = null,
       leased_until = null
  from storage_ctx c
 where j.id = c.avatar_old_job;
select is(
  (
    select public.bp_enqueue_detached_storage_asset(
             'avatar_replace',
             c.user_id,
             null,
             'avatars',
             c.avatar_old_path
           )
      from storage_ctx c
  ),
  (select avatar_old_job from storage_ctx),
  'completed cleanup receipt revives in place on re-detach'
);
select is(
  (
    select j.status || ':' || j.attempt_count::text
      from public.storage_object_cleanup_jobs j
      join storage_ctx c on c.avatar_old_job = j.id
  ),
  'pending:0',
  'revived cleanup lifecycle starts a fresh attempt_count'
);

select * from finish();
rollback;
