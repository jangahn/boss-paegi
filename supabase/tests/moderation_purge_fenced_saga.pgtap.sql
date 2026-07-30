-- moderation_purge_fenced_saga.pgtap.sql — 0078 durable purge/fence 검증.
-- disposable DB에서 전체 migration 적용 + pgTAP extension 뒤 실행한다.

begin;
select plan(32);

select has_table(
  'public',
  'moderation_purge_jobs',
  'moderation purge outbox exists'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.moderation_purge_jobs'::regclass
  ),
  true,
  'purge outbox has RLS enabled'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_policy
     where polrelid = 'public.moderation_purge_jobs'::regclass
  ),
  0,
  'purge outbox has no client policy'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.moderation_purge_jobs',
    'SELECT'
  ),
  'service role cannot read purge rows directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_moderation_purge_status(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'receipt-bearing purge begin and status RPCs remain available'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_moderation_purge_v2(uuid,integer,integer)',
    'EXECUTE'
  ),
  'service role can claim purge'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.finish_moderation_purge_v2(uuid,uuid,integer,boolean,text)',
    'EXECUTE'
  ),
  'service role can finish purge'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_moderation_purge_v2(uuid,integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot claim purge'
);
select has_trigger(
  'public',
  'dolls',
  'trg_dolls_reject_restore_during_purge',
  'every direct doll restore is fenced'
);

create temporary table purge_ctx (
  admin_id uuid not null,
  owner_id uuid not null,
  doll_id uuid not null,
  score_id uuid not null,
  doll_path text not null,
  highlight_path text not null,
  job_id uuid,
  lease_one jsonb,
  lease_two jsonb
) on commit drop;

do $fixture$
declare
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_doll uuid := gen_random_uuid();
  v_score uuid := gen_random_uuid();
  v_doll_path text := v_owner::text || '/' || v_doll::text || '.png';
  v_highlight_path text := v_score::text || '/' || gen_random_uuid()::text
    || '.webm';
  v_start jsonb;
begin
  insert into auth.users(id, email) values
    (v_admin, 'purge-admin-' || v_admin::text || '@test.local'),
    (v_owner, 'purge-owner-' || v_owner::text || '@test.local');
  insert into public.member_accounts(user_id, is_admin) values
    (v_admin, true),
    (v_owner, false);

  insert into public.dolls(id, owner_id, image_url)
  values (
    v_doll,
    v_owner,
    'https://project.test/storage/v1/object/public/dolls/' || v_doll_path
  );
  insert into public.scores(
    id, owner_id, doll_id, score, weapon, duration_ms
  )
  values (v_score, v_owner, v_doll, 10, 'fist', 1000);
  insert into public.score_highlights(
    score_id,
    highlight_clip_path,
    highlight_status,
    highlight_expires_at
  )
  values (
    v_score,
    v_highlight_path,
    'ready',
    clock_timestamp() + interval '1 day'
  );
  update public.dolls
     set deleted_at = clock_timestamp(),
         deleted_by = v_admin,
         deletion_reason = 'fixture takedown'
   where id = v_doll;

  v_start := public.admin_begin_doll_purge(
    v_admin,
    v_doll,
    'permanent fixture purge'
  );
  insert into purge_ctx(
    admin_id,
    owner_id,
    doll_id,
    score_id,
    doll_path,
    highlight_path,
    job_id
  )
  values (
    v_admin,
    v_owner,
    v_doll,
    v_score,
    v_doll_path,
    v_highlight_path,
    (v_start->>'job_id')::uuid
  );
end;
$fixture$;

select ok(job_id is not null, 'begin returns a durable job id')
  from purge_ctx;
select is(
  (
    select status
      from public.moderation_purge_jobs j
      join purge_ctx c on c.job_id = j.id
  ),
  'pending',
  'begin creates a pending purge job'
);
select is(
  (
    select manifest
      from public.moderation_purge_jobs j
      join purge_ctx c on c.job_id = j.id
  ),
  '[]'::jsonb,
  'begin never materializes doll history'
);
select is(
  pg_catalog.jsonb_array_length(
    (select manifest
       from public.moderation_purge_jobs j
       join purge_ctx c on c.job_id = j.id)
  ),
  0,
  'begin never materializes highlight history'
);
select is(
  (
    select (
      public.admin_begin_doll_purge(
        admin_id,
        doll_id,
        'repeated fixture purge'
      )->>'job_id'
    )::uuid
      from purge_ctx
  ),
  (select job_id from purge_ctx),
  'repeated begin is idempotent'
);
select throws_ok(
  format(
    'select public.admin_restore_doll(%L::uuid,%L::uuid,%L)',
    (select admin_id from purge_ctx),
    (select doll_id from purge_ctx),
    'restore blocked by purge'
  ),
  'P0001',
  'purge_pending',
  'restore RPC is blocked while purge is pending'
);
select throws_ok(
  format(
    'update public.dolls set deleted_at = null where id = %L::uuid',
    (select doll_id from purge_ctx)
  ),
  'P0001',
  'purge_pending',
  'direct restore is blocked by the trigger backstop'
);

update purge_ctx
   set lease_one = public.claim_moderation_purge_v2(
     job_id, 120, 100
   );
select is(
  lease_one->>'job_id',
  job_id::text,
  'claim returns the requested job'
)
from purge_ctx;
select is(
  (lease_one->>'lease_version')::int,
  1,
  'first claim gets lease version one'
)
from purge_ctx;
select is(
  public.claim_moderation_purge_v2(job_id, 120, 100),
  null::jsonb,
  'an unexpired lease cannot be claimed twice'
)
from purge_ctx;
select throws_ok(
  format(
    'select public.finish_moderation_purge_v2(%L::uuid,%L::uuid,%s,true,null)',
    (select job_id from purge_ctx),
    gen_random_uuid(),
    1
  ),
  'P0001',
  'purge_lease_lost',
  'wrong lease token cannot finish'
);
select is(
  (
    select public.finish_moderation_purge_v2(
             job_id,
             (lease_one->>'lease_token')::uuid,
             (lease_one->>'lease_version')::int,
             false,
             'injected storage failure'
           )->>'status'
      from purge_ctx
  ),
  'pending',
  'failed storage removal records a retry'
);
select is(
  (
    select last_error
      from public.moderation_purge_jobs j
      join purge_ctx c on c.job_id = j.id
  ),
  'injected storage failure',
  'retry preserves the failure reason'
);
select throws_ok(
  format(
    'select public.admin_restore_doll(%L::uuid,%L::uuid,%L)',
    (select admin_id from purge_ctx),
    (select doll_id from purge_ctx),
    'still blocked after retry'
  ),
  'P0001',
  'purge_pending',
  'failed attempt does not open a restore window'
);

update public.moderation_purge_jobs
   set final_sweep_after = clock_timestamp() - interval '1 second',
       next_attempt_at = clock_timestamp() - interval '1 second'
 where id = (select job_id from purge_ctx);
update purge_ctx
   set lease_two = public.claim_moderation_purge_v2(
     job_id, 120, 100
   );
select is(
  (lease_two->>'lease_version')::int,
  2,
  'retry claim advances the lease fence'
)
from purge_ctx;
select is(
  (
    select public.finish_moderation_purge_v2(
             job_id,
             (lease_two->>'lease_token')::uuid,
             (lease_two->>'lease_version')::int,
             true,
             null
           )->>'status'
      from purge_ctx
  ),
  'completed',
  'current lease completes the purge'
);
select is(
  (
    select status
      from public.moderation_purge_jobs j
      join purge_ctx c on c.job_id = j.id
  ),
  'completed',
  'job reaches completed'
);
select is(
  (
    select manifest
      from public.moderation_purge_jobs j
      join purge_ctx c on c.job_id = j.id
  ),
  '[]'::jsonb,
  'completed job erases its path manifest'
);
select ok(
  (
    select artifacts_purged_at is not null
      from public.dolls d
      join purge_ctx c on c.doll_id = d.id
  ),
  'doll is marked physically purged'
);
select is(
  (
    select count(*)::int
      from public.moderation_actions_ledger l
      join purge_ctx c
        on l.target_id = c.doll_id
       and l.action_type = 'purge_doll'
       and l.metadata->>'purge_job_id' = c.job_id::text
  ),
  1,
  'completion records exactly one audit ledger entry'
);
select throws_ok(
  format(
    'select public.finish_moderation_purge_v2(%L::uuid,%L::uuid,%s,true,null)',
    (select job_id from purge_ctx),
    (select lease_one->>'lease_token' from purge_ctx),
    (select (lease_one->>'lease_version')::int from purge_ctx)
  ),
  'P0001',
  'purge_lease_lost',
  'a stale lease cannot complete after the winner'
);
select throws_ok(
  format(
    'select public.admin_restore_doll(%L::uuid,%L::uuid,%L)',
    (select admin_id from purge_ctx),
    (select doll_id from purge_ctx),
    'purged cannot restore'
  ),
  'P0001',
  'already_purged',
  'completed physical purge is not restorable'
);
select is(
  (
    select public.admin_begin_doll_purge(
             admin_id,
             doll_id,
             'repeated completed purge'
           )->>'already_purged'
      from purge_ctx
  ),
  'true',
  'begin after completion is idempotently already-purged'
);

select * from finish();
rollback;
