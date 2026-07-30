-- account_deletion_cleanup_saga.pgtap.sql — 0072 cleanup outbox/lease 실행 검증.
-- disposable DB에서 0001~0072 적용 + pgTAP extension 뒤 실행한다. 전체 transaction rollback.

begin;
select plan(62);

-- ── schema / ACL ─────────────────────────────────────────────────────────────
select has_table(
  'public',
  'account_deletion_cleanup_jobs',
  'cleanup jobs table exists'
);
select has_column(
  'public',
  'account_deletion_cleanup_jobs',
  'manifest',
  'cleanup jobs manifest exists'
);
select has_column(
  'public',
  'account_deletion_cleanup_jobs',
  'lease_token',
  'cleanup jobs lease token exists'
);
select has_column(
  'public',
  'account_deletion_cleanup_jobs',
  'final_sweep_after',
  'cleanup jobs retain a signed-upload final-sweep horizon'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.account_deletion_cleanup_jobs'::regclass
  ),
  true,
  'cleanup jobs RLS enabled'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_policy
     where polrelid = 'public.account_deletion_cleanup_jobs'::regclass
  ),
  0,
  'cleanup jobs policy count = 0'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.account_deletion_cleanup_jobs',
    'SELECT'
  ),
  'service_role has no direct table SELECT'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.account_deletion_cleanup_jobs',
    'SELECT'
  ),
  'anon has no direct table SELECT'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_soft_delete_account(uuid)',
    'EXECUTE'
  ),
  'service_role can call soft-delete'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)',
    'EXECUTE'
  ),
  'service_role can claim cleanup'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.finish_account_deletion_cleanup_v2(uuid,uuid,integer,boolean,text)',
    'EXECUTE'
  ),
  'service_role can finish cleanup'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_soft_delete_account(uuid)',
    'EXECUTE'
  ),
  'anon cannot call soft-delete'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot claim cleanup'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_account_cleanup_storage_path(text,text)',
    'EXECUTE'
  ),
  'service_role cannot call internal path helper'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_constraint
     where conrelid = 'public.account_deletion_cleanup_jobs'::regclass
       and contype = 'f'
  ),
  0,
  'cleanup outbox deliberately has no profile FK so purge cannot erase/block retry history'
);
select has_trigger(
  'public',
  'profiles',
  'trg_profiles_reject_early_reactivation',
  'profiles blocks reactivation while cleanup is active'
);
select has_trigger(
  'public',
  'profiles',
  'trg_profiles_reject_deleted_display_name_update',
  'profiles preserve the deleted-account nickname scrub'
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
         = '((auth.uid() = id) AND (deleted_at IS NULL))'
       and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
         = '((auth.uid() = id) AND (deleted_at IS NULL))'
  ),
  'profile self-update policy is authenticated active-self only'
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
  'deleted-profile trigger helper is not an external RPC'
);
select has_trigger(
  'public',
  'dolls',
  'trg_dolls_reject_deleted_owner_insert',
  'dolls reject deleted owner inserts'
);
select has_trigger(
  'public',
  'scores',
  'trg_scores_reject_deleted_owner_insert',
  'scores reject deleted owner inserts'
);
select has_trigger(
  'public',
  'score_highlights',
  'trg_score_highlights_reject_deleted_owner_insert',
  'score_highlights reject deleted owner inserts'
);
select has_trigger(
  'public',
  'ai_generations',
  'trg_ai_generations_reject_deleted_owner_insert',
  'ai_generations reject deleted owner inserts'
);

-- ── fixture + atomic manifest/soft-delete ────────────────────────────────────
create temporary table cleanup_ctx (
  user_id uuid not null,
  doll_id uuid not null,
  score_id uuid not null,
  spare_score_id uuid not null,
  report_id uuid not null,
  start_result jsonb not null,
  lease_result jsonb
) on commit drop;

do $fixture$
declare
  v_user uuid := gen_random_uuid();
  v_doll uuid := gen_random_uuid();
  v_score uuid := gen_random_uuid();
  v_spare_score uuid := gen_random_uuid();
  v_report uuid := gen_random_uuid();
  v_start jsonb;
begin
  insert into auth.users(id, email)
  values (v_user, 'cleanup-saga@example.test');
  insert into public.member_accounts(user_id, gen_credits)
  values (v_user, 0)
  on conflict (user_id) do nothing;

  update public.profiles
     set avatar_url =
       'https://project.test/storage/v1/object/public/avatars/'
       || v_user::text || '/avatar.jpg?cache=1'
   where id = v_user;

  insert into public.dolls(id, owner_id, image_url)
  values (
    v_doll,
    v_user,
    'https://project.test/storage/v1/object/sign/dolls/'
      || v_user::text || '/doll.jpg?token=secret'
  );
  insert into public.scores(id, owner_id, doll_id, score, weapon, duration_ms)
  values (v_score, v_user, v_doll, 10, 'fist', 1000);
  insert into public.scores(id, owner_id, score, weapon, duration_ms)
  values (v_spare_score, v_user, 11, 'fist', 1000);
  insert into public.score_highlights(score_id, highlight_clip_path)
  values (v_score, v_user::text || '/highlight.webm');
  insert into public.content_reports(id, target_type, target_id, reason)
  values (v_report, 'doll', v_doll, 'privacy');

  v_start := public.admin_soft_delete_account(v_user);
  insert into cleanup_ctx
    (user_id, doll_id, score_id, spare_score_id, report_id, start_result)
  values
    (v_user, v_doll, v_score, v_spare_score, v_report, v_start);
end;
$fixture$;

select is(
  (select start_result ->> 'cleanup_status' from cleanup_ctx),
  'pending',
  'soft-delete returns pending durable job'
);
select is(
  (
    select start_result -> 'manifest' -> 'dolls'
      from cleanup_ctx
  ),
  '[]'::jsonb,
  'begin never materializes doll history'
);
select is(
  (
    select start_result -> 'manifest' -> 'highlights'
      from cleanup_ctx
  ),
  '[]'::jsonb,
  'begin never materializes highlight history'
);
select is(
  (
    select start_result -> 'manifest' -> 'avatar'
      from cleanup_ctx
  ),
  'null'::jsonb,
  'begin never materializes an avatar path'
);
select ok(
  (
    select p.deleted_at is not null
      from public.profiles p
      join cleanup_ctx c on c.user_id = p.id
  ),
  'profile is soft-deleted'
);
select ok(
  (
    select p.avatar_url is null
      from public.profiles p
      join cleanup_ctx c on c.user_id = p.id
  ),
  'profile avatar is scrubbed'
);
select is(
  (
    select count(*)::int
      from public.dolls d
      join cleanup_ctx c on c.doll_id = d.id
  ),
  0,
  'doll row is deleted'
);
select ok(
  (
    select sh.highlight_deleted_at is not null
      from public.score_highlights sh
      join cleanup_ctx c on c.score_id = sh.score_id
  ),
  '0034 highlight render-block is restored'
);
select is(
  (
    select r.status
      from public.content_reports r
      join cleanup_ctx c on c.report_id = r.id
  ),
  'actioned',
  '0034 pending report closure is restored'
);
select is(
  (
    select j.status
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c
        on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  'pending',
  'job and soft-delete committed in same transaction'
);

-- ── stale request / reactivation backstop ───────────────────────────────────
select set_config(
  'request.jwt.claim.sub',
  (select user_id::text from cleanup_ctx),
  true
);
set local role authenticated;
with updated as (
  update public.profiles
     set display_name = 'stale-auth-name'
   where id = auth.uid()
  returning 1
)
select is(
  (select count(*)::int from updated),
  0,
  'stale authenticated nickname update sees zero deleted rows'
);
reset role;

select throws_ok(
  format(
    'update public.profiles set display_name = %L where id = %L::uuid',
    'owner-bypass-name',
    (select user_id::text from cleanup_ctx)
  ),
  'P0001',
  'account_deleted',
  'trigger rejects an RLS-bypassing nickname update after soft-delete'
);
select is(
  (
    select p.display_name
      from public.profiles p
      join cleanup_ctx c on c.user_id = p.id
  ),
  '탈퇴한 사용자',
  'rejected stale nickname writes preserve the scrubbed public profile'
);

select throws_ok(
  format(
    'insert into public.dolls(owner_id, image_url) values (%L::uuid, %L)',
    (select user_id::text from cleanup_ctx),
    'deleted-owner-doll.png'
  ),
  'P0001',
  'account_deleted',
  'stale doll insert is rejected after soft-delete'
);
select throws_ok(
  format(
    'insert into public.scores(owner_id, score, weapon, duration_ms) values (%L::uuid, 1, %L, 1000)',
    (select user_id::text from cleanup_ctx),
    'fist'
  ),
  'P0001',
  'account_deleted',
  'stale score insert is rejected after soft-delete'
);
select throws_ok(
  format(
    'insert into public.score_highlights(score_id, highlight_status) values (%L::uuid, %L)',
    (select spare_score_id::text from cleanup_ctx),
    'card'
  ),
  'P0001',
  'account_deleted',
  'stale highlight attach is rejected after soft-delete'
);
select throws_ok(
  format(
    'insert into public.ai_generations(owner_id, status, role) values (%L::uuid, %L, %L)',
    (select user_id::text from cleanup_ctx),
    'queued',
    'boss'
  ),
  'P0001',
  'account_deleted',
  'stale generation insert is rejected after soft-delete'
);
select throws_ok(
  format(
    'select public.create_generation_row(%L::uuid, %L)',
    (select user_id::text from cleanup_ctx),
    'boss'
  ),
  'P0001',
  'account_deleted',
  'no-credit generation RPC rejects deleted account before insert'
);
select throws_ok(
  format(
    'select public.create_generation_and_consume(%L::uuid, %L)',
    (select user_id::text from cleanup_ctx),
    'boss'
  ),
  'P0001',
  'account_deleted',
  'credit-consuming generation RPC rejects deleted account before consumption'
);
select throws_ok(
  format(
    'update public.profiles set deleted_at = null where id = %L::uuid',
    (select user_id::text from cleanup_ctx)
  ),
  'P0001',
  'account_cleanup_pending',
  'reactivation cannot race an active cleanup worker'
);

-- ── claim / fenced finish / retry ────────────────────────────────────────────
update cleanup_ctx
   set lease_result = public.claim_account_deletion_cleanup_v2(
     (start_result ->> 'job_id')::uuid,
     120,
     100
   );

select is(
  (
    select j.status
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  'leased',
  'claim moves job to leased'
);
select is(
  (
    select j.attempt_count
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  1,
  'first claim increments attempt_count'
);
select throws_ok(
  format(
    'select public.finish_account_deletion_cleanup_v2(%L::uuid, gen_random_uuid(), %s, true, null)',
    (select start_result ->> 'job_id' from cleanup_ctx),
    (select (lease_result->>'lease_version')::integer from cleanup_ctx)
  ),
  'P0001',
  'cleanup_lease_lost',
  'wrong lease token cannot finish'
);
select is(
  (
    select public.finish_account_deletion_cleanup_v2(
      (start_result ->> 'job_id')::uuid,
      (lease_result ->> 'lease_token')::uuid,
      (lease_result ->> 'lease_version')::integer,
      false,
      'injected failure'
    ) ->> 'status'
      from cleanup_ctx
  ),
  'pending',
  'failed finish returns job to pending'
);
select ok(
  (
    select j.next_attempt_at > clock_timestamp()
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  'failed finish schedules future backoff'
);
select is(
  (
    select public.claim_account_deletion_cleanup_v2(
      (start_result ->> 'job_id')::uuid,
      120,
      100
    )
      from cleanup_ctx
  ),
  null::jsonb,
  'job cannot be reclaimed before next_attempt_at'
);

update public.account_deletion_cleanup_jobs j
   set next_attempt_at = clock_timestamp() - interval '1 second'
  from cleanup_ctx c
 where j.id = (c.start_result ->> 'job_id')::uuid;
update cleanup_ctx
   set lease_result = public.claim_account_deletion_cleanup_v2(
     (start_result ->> 'job_id')::uuid,
     120,
     100
   );

select is(
  (
    select public.finish_account_deletion_cleanup_v2(
      (start_result ->> 'job_id')::uuid,
      (lease_result ->> 'lease_token')::uuid,
      (lease_result ->> 'lease_version')::integer,
      true,
      null
    ) ->> 'status'
      from cleanup_ctx
  ),
  'pending_final_sweep',
  'successful first pass waits for signed-upload token horizon'
);
select ok(
  (
    select j.status = 'pending'
           and j.next_attempt_at = j.final_sweep_after
           and j.manifest <> '{}'::jsonb
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  'pre-horizon success retains active manifest and schedules final sweep'
);
select throws_ok(
  format(
    'update public.profiles set deleted_at = null where id = %L::uuid',
    (select user_id::text from cleanup_ctx)
  ),
  'P0001',
  'account_cleanup_pending',
  'reactivation remains blocked during signed-upload final-sweep wait'
);

update public.account_deletion_cleanup_jobs j
   set final_sweep_after = clock_timestamp() - interval '1 second',
       next_attempt_at = clock_timestamp() - interval '1 second'
  from cleanup_ctx c
 where j.id = (c.start_result ->> 'job_id')::uuid;
update cleanup_ctx
   set lease_result = public.claim_account_deletion_cleanup_v2(
     (start_result ->> 'job_id')::uuid,
     120,
     100
   );

do $arm_cleanup_auth$
begin
  perform public.arm_account_deletion_cleanup_auth_fence(
    (start_result ->> 'job_id')::uuid,
    user_id,
    (lease_result ->> 'lease_token')::uuid,
    (lease_result ->> 'lease_version')::integer
  )
  from cleanup_ctx;
end;
$arm_cleanup_auth$;

update auth.users u
   set email = 'deleted+' || c.user_id::text || '@deleted.invalid',
       raw_user_meta_data = '{}'::jsonb
  from cleanup_ctx c
 where u.id = c.user_id;

select is(
  (
    select public.finish_account_deletion_cleanup_v2(
      (start_result ->> 'job_id')::uuid,
      (lease_result ->> 'lease_token')::uuid,
      (lease_result ->> 'lease_version')::integer,
      true,
      null
    ) ->> 'status'
      from cleanup_ctx
  ),
  'completed',
  'successful retry completes job'
);
select is(
  (
    select j.manifest
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  '{}'::jsonb,
  'completed job scrubs manifest'
);
select ok(
  (
    select j.completed_at is not null
           and j.lease_token is null
           and j.leased_until is null
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on j.id = (c.start_result ->> 'job_id')::uuid
  ),
  'completed job clears lease and stamps completion'
);
select is(
  (
    select count(*)::int
      from public.account_deletion_cleanup_jobs j
      join cleanup_ctx c on c.user_id = j.user_id
     where j.status in ('pending', 'leased')
  ),
  0,
  'completed user has no active cleanup job'
);

-- 완료 뒤 재활성은 정상이며 같은 DB backstop은 새 owner write를 허용한다.
select lives_ok(
  format(
    'update public.profiles set deleted_at = null where id = %L::uuid',
    (select user_id::text from cleanup_ctx)
  ),
  'profile can reactivate after cleanup completion'
);
select set_config(
  'request.jwt.claim.sub',
  (select user_id::text from cleanup_ctx),
  true
);
set local role authenticated;
with updated as (
  update public.profiles
     set display_name = 'active-self-name'
   where id = auth.uid()
  returning 1
)
select is(
  (select count(*)::int from updated),
  1,
  'active authenticated user retains normal self nickname update'
);
reset role;
select is(
  (
    select p.display_name
      from public.profiles p
      join cleanup_ctx c on c.user_id = p.id
  ),
  'active-self-name',
  'active self nickname update persists after reactivation'
);
select lives_ok(
  format(
    'insert into public.dolls(owner_id, image_url) values (%L::uuid, %L)',
    (select user_id::text from cleanup_ctx),
    'reactivated-owner-doll.png'
  ),
  'reactivated owner can insert doll'
);
select lives_ok(
  format(
    'insert into public.scores(owner_id, score, weapon, duration_ms) values (%L::uuid, 1, %L, 1000)',
    (select user_id::text from cleanup_ctx),
    'fist'
  ),
  'reactivated owner can insert score'
);
select lives_ok(
  format(
    'select public.create_generation_row(%L::uuid, %L)',
    (select user_id::text from cleanup_ctx),
    'boss'
  ),
  'reactivated owner can create generation'
);

select * from finish();
rollback;
