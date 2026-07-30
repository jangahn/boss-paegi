-- 0073 generation terminal state-machine integration tests.
-- Run only against a disposable database with migrations through 0073 applied.

begin;
select plan(55);

select has_column(
  'public',
  'ai_generations',
  'artifacts_cleaned_at',
  'terminal artifact cleanup marker exists'
);
select ok(
  (
    select pg_get_constraintdef(oid) like '%expired%'
      from pg_constraint
     where conrelid = 'public.ai_generations'::regclass
       and conname = 'ai_generations_status_check'
  ),
  'status constraint includes expired'
);
select has_trigger(
  'public',
  'ai_generations',
  'trg_ai_generations_status_transition',
  'transition trigger exists'
);
select has_table(
  'public',
  'generation_artifact_write_leases',
  'artifact write lease table exists'
);
select is(
  (
    select relrowsecurity
      from pg_class
     where oid = 'public.generation_artifact_write_leases'::regclass
  ),
  true,
  'artifact write lease table has RLS'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_generation_artifact_write(uuid,integer,integer)',
    'EXECUTE'
  ),
  'service role can claim artifact write lease'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.claim_generation_artifact_write(uuid,integer,integer)',
    'EXECUTE'
  ),
  'anon cannot claim artifact write lease'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_deleted_owner_inflight_generations(integer)',
    'EXECUTE'
  ),
  'service role can fairly list deleted-owner inflight generations'
);
select ok(
  not has_column_privilege(
    'service_role',
    'public.ai_generations',
    'artifacts_cleaned_at',
    'UPDATE'
  ),
  'service role cannot bypass cleanup RPC with direct marker UPDATE'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.expire_generation(uuid,integer)',
    'EXECUTE'
  ),
  'service role can expire'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.expire_generation(uuid,integer)',
    'EXECUTE'
  ),
  'anon cannot expire'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_generation_artifact_cleanup(uuid,text)',
    'EXECUTE'
  ),
  'authenticated cannot mark cleanup'
);

create temporary table generation_ctx (
  user_id uuid not null,
  queued_id uuid not null,
  done_id uuid not null,
  picked_id uuid not null,
  failed_id uuid not null,
  expired_id uuid not null,
  cleanup_id uuid not null,
  queued_fail_id uuid not null,
  done_expire_id uuid not null,
  lease_id uuid not null,
  failed_cleanup_id uuid not null,
  refund_user_id uuid not null,
  refund_success_id uuid not null,
  refund_stale_id uuid not null,
  refund_lot_id uuid not null,
  fair_gen_id uuid not null,
  lease_result jsonb
) on commit drop;

do $fixture$
declare
  v_user uuid := gen_random_uuid();
  v_refund_user uuid := gen_random_uuid();
  v_refund_lot uuid := gen_random_uuid();
begin
  insert into auth.users(id, email)
  values (v_user, 'generation-state@example.test');
  insert into public.member_accounts(user_id, gen_credits)
  values (v_user, 7)
  on conflict (user_id) do update set gen_credits = excluded.gen_credits;

  insert into public.ai_generations(owner_id, status)
  values (v_user, 'queued');
  insert into generation_ctx
  select
    v_user,
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    v_refund_user,
    gen_random_uuid(),
    gen_random_uuid(),
    v_refund_lot,
    gen_random_uuid(),
    null;

  delete from public.ai_generations where owner_id = v_user;
  insert into public.ai_generations(id, owner_id, status)
    select queued_id, user_id, 'queued' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select done_id, user_id, 'done' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select picked_id, user_id, 'picked' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select failed_id, user_id, 'failed' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select expired_id, user_id, 'expired' from generation_ctx;
  insert into public.ai_generations(
    id, owner_id, status, candidate_urls
  )
    select
      cleanup_id,
      user_id,
      'expired',
      pg_catalog.jsonb_build_array(
        user_id::text || '/candidates/' || cleanup_id::text || '/0.jpg'
      )
    from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select queued_fail_id, user_id, 'queued' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select done_expire_id, user_id, 'done' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select lease_id, user_id, 'queued' from generation_ctx;
  insert into public.ai_generations(id, owner_id, status)
    select failed_cleanup_id, user_id, 'failed' from generation_ctx;

  insert into auth.users(id, email)
  values (v_refund_user, 'generation-refund-version@example.test');
  insert into public.member_accounts(user_id, gen_credits)
  values (v_refund_user, 0)
  on conflict (user_id) do update set gen_credits = excluded.gen_credits;
  insert into public.credit_lots(
    id, user_id, source, qty, consumed, granted_at, expires_at
  )
  values (
    v_refund_lot,
    v_refund_user,
    'signup_bonus',
    2,
    2,
    now(),
    now() + interval '1 year'
  );
  insert into public.ai_generations(
    id, owner_id, status, credit_lot_id, consumed_at
  )
    select refund_success_id, refund_user_id, 'queued', refund_lot_id, now()
      from generation_ctx;
  insert into public.ai_generations(
    id, owner_id, status, credit_lot_id, consumed_at
  )
    select refund_stale_id, refund_user_id, 'queued', refund_lot_id, now()
      from generation_ctx;
end;
$fixture$;

-- Full allowed transition set.
select lives_ok(
  format(
    'update public.ai_generations set status=''done'' where id=%L',
    (select queued_id from generation_ctx)
  ),
  'queued -> done allowed'
);
select lives_ok(
  format(
    'update public.ai_generations set status=''picked'' where id=%L',
    (select queued_id from generation_ctx)
  ),
  'done -> picked allowed'
);

select lives_ok(
  format(
    'update public.ai_generations set status=''failed'' where id=%L',
    (select queued_fail_id from generation_ctx)
  ),
  'queued -> failed allowed'
);

select lives_ok(
  format(
    'update public.ai_generations set status=''expired'' where id=%L',
    (select done_expire_id from generation_ctx)
  ),
  'done -> expired allowed'
);

-- Every forbidden backward/skip transition class.
select throws_ok(
  format(
    'update public.ai_generations set status=''picked'' where id=%L',
    (select failed_id from generation_ctx)
  ),
  'P0001',
  'invalid_generation_transition:failed->picked',
  'failed cannot become picked'
);
select throws_ok(
  format(
    'update public.ai_generations set status=''done'' where id=%L',
    (select picked_id from generation_ctx)
  ),
  'P0001',
  'invalid_generation_transition:picked->done',
  'picked cannot resurrect'
);
select throws_ok(
  format(
    'update public.ai_generations set status=''done'' where id=%L',
    (select failed_id from generation_ctx)
  ),
  'P0001',
  'invalid_generation_transition:failed->done',
  'failed cannot resurrect'
);
select throws_ok(
  format(
    'update public.ai_generations set status=''done'' where id=%L',
    (select expired_id from generation_ctx)
  ),
  'P0001',
  'invalid_generation_transition:expired->done',
  'expired cannot resurrect'
);
select throws_ok(
  format(
    'update public.ai_generations set status=''expired'' where id=%L',
    (select failed_id from generation_ctx)
  ),
  'P0001',
  'invalid_generation_transition:failed->expired',
  'failed cannot expire'
);
select throws_ok(
  format(
    'update public.ai_generations set status=''failed'' where id=%L',
    (select done_id from generation_ctx)
  ),
  'P0001',
  'invalid_generation_transition:done->failed',
  'done cannot be refunded as failure'
);

-- Failure/refund expected-version fence: matching queued+consumed succeeds,
-- stale expected returns before either status or lot/cache mutation.
select is(
  (
    select public.mark_generation_failed_and_refund(
      refund_success_id,
      'expected_version_success',
      (
        select version
          from public.ai_generations g
         where g.id = c.refund_success_id
      )
    ) ->> 'outcome'
      from generation_ctx c
  ),
  'refunded',
  'matching expected version transitions and refunds consumed generation'
);
select is(
  (
    select status
      from public.ai_generations g
      join generation_ctx c on c.refund_success_id = g.id
  ),
  'failed',
  'matching expected version persists failed status'
);
select ok(
  (
    select refunded_at is not null
      from public.ai_generations g
      join generation_ctx c on c.refund_success_id = g.id
  ),
  'matching expected version stamps refunded_at'
);
select is(
  (
    select gen_credits
      from public.member_accounts m
      join generation_ctx c on c.refund_user_id = m.user_id
  ),
  1,
  'matching expected version restores one live credit'
);
select is(
  (
    select public.mark_generation_failed_and_refund(
      refund_stale_id,
      'must_not_persist',
      999
    ) ->> 'outcome'
      from generation_ctx
  ),
  'version_conflict',
  'stale expected version is rejected before transition'
);
select ok(
  (
    select g.status = 'queued'
           and g.refunded_at is null
           and g.fail_reason is null
      from public.ai_generations g
      join generation_ctx c on c.refund_stale_id = g.id
  ),
  'stale expected version leaves generation unchanged'
);
select is(
  (
    select consumed
      from public.credit_lots l
      join generation_ctx c on c.refund_lot_id = l.id
  ),
  1,
  'stale expected version leaves remaining lot consumption unchanged'
);

-- Expiry RPC: version fence, row-lock transition, idempotency, no credit refund.
select is(
  (
    select public.expire_generation(done_id, 999) ->> 'outcome'
      from generation_ctx
  ),
  'version_conflict',
  'expiry rejects stale version'
);
select is(
  (
    select public.expire_generation(
      done_id,
      (select version from public.ai_generations g where g.id = c.done_id)
    ) ->> 'outcome'
      from generation_ctx c
  ),
  'expired',
  'expiry transitions matching done row'
);
select is(
  (
    select status
      from public.ai_generations g
      join generation_ctx c on c.done_id = g.id
  ),
  'expired',
  'expiry persists terminal status'
);
select is(
  (
    select public.expire_generation(done_id, null) ->> 'outcome'
      from generation_ctx
  ),
  'already_expired',
  'expiry is idempotent'
);
select is(
  (
    select gen_credits
      from public.member_accounts m
      join generation_ctx c on c.user_id = m.user_id
  ),
  7,
  'expiry does not refund or change credits'
);
select is(
  (
    select public.expire_generation(picked_id, null) ->> 'outcome'
      from generation_ctx
  ),
  'conflict',
  'picked wins expiry race'
);
select is(
  (
    select status
      from public.ai_generations g
      join generation_ctx c on c.picked_id = g.id
  ),
  'picked',
  'expiry conflict leaves picked unchanged'
);
select throws_ok(
  format(
    'select public.mark_generation_failed_and_refund(%L,''late_failure'',null)',
    (select done_id from generation_ctx)
  ),
  'P0001',
  'invalid_state',
  'failure/refund RPC rejects expired'
);

-- Deterministic terminal-cleanup race: write lease claimed while queued remains
-- authoritative even if pick wins; cleanup waits until the writer releases/crashes.
update generation_ctx c
   set lease_result = public.claim_generation_artifact_write(
     c.lease_id,
     (
       select version
         from public.ai_generations g
        where g.id = c.lease_id
     ),
     600
   );
update public.ai_generations g
   set status = 'done'
  from generation_ctx c
 where g.id = c.lease_id;
update public.ai_generations g
   set status = 'picked'
  from generation_ctx c
 where g.id = c.lease_id;

select is(
  (select lease_result ->> 'outcome' from generation_ctx),
  'claimed',
  'recoverer claims artifact write lease before Storage copy'
);
select is(
  (
    select public.begin_generation_artifact_cleanup(
      lease_id, 'picked'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'write_busy',
  'terminal cleanup waits while recovery write lease is active'
);
select is(
  (
    select public.complete_generation_artifact_cleanup(
      lease_id, 'picked'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'write_busy',
  'cleanup marker cannot bypass an active recovery write lease'
);
select is(
  (
    select public.release_generation_artifact_write(
      lease_id,
      (lease_result ->> 'lease_token')::uuid
    ) ->> 'outcome'
      from generation_ctx
  ),
  'released',
  'recoverer releases matching artifact write lease'
);
select is(
  (
    select public.begin_generation_artifact_cleanup(
      lease_id, 'picked'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'ready',
  'terminal cleanup becomes ready after writer release'
);
select is(
  (
    select public.complete_generation_artifact_cleanup(
      lease_id, 'picked'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'cleaned',
  'terminal cleanup completes after lease release'
);
select ok(
  (
    select artifacts_cleaned_at is not null
      from public.ai_generations g
      join generation_ctx c on c.lease_id = g.id
  ),
  'lease-serialized cleanup stamps marker'
);
select is(
  (
    select public.reopen_generation_artifact_cleanup(lease_id) ->> 'outcome'
      from generation_ctx
  ),
  'reopened',
  'failed compensation can reopen a completed cleanup marker'
);
select ok(
  (
    select artifacts_cleaned_at is null
      from public.ai_generations g
      join generation_ctx c on c.lease_id = g.id
  ),
  'reopened marker is a durable retry manifest'
);

select is(
  (
    select public.begin_generation_artifact_cleanup(
      failed_cleanup_id, 'failed'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'ready',
  'failed generation participates in artifact cleanup'
);
select is(
  (
    select public.complete_generation_artifact_cleanup(
      failed_cleanup_id, 'failed'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'cleaned',
  'failed generation cleanup can complete'
);
select ok(
  (
    select artifacts_cleaned_at is not null
      from public.ai_generations g
      join generation_ctx c on c.failed_cleanup_id = g.id
  ),
  'failed generation cleanup stamps marker'
);

-- External cleanup marker can only finish the matching terminal row.
select is(
  (
    select public.complete_generation_artifact_cleanup(
      cleanup_id, 'picked'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'conflict',
  'cleanup marker rejects wrong expected terminal state'
);
select is(
  (
    select public.complete_generation_artifact_cleanup(
      cleanup_id, 'expired'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'cleaned',
  'cleanup marker accepts matching expired row'
);
select is(
  (
    select candidate_urls
      from public.ai_generations g
      join generation_ctx c on c.cleanup_id = g.id
  ),
  '[]'::jsonb,
  'cleanup completion clears candidate paths'
);
select ok(
  (
    select artifacts_cleaned_at is not null
      from public.ai_generations g
      join generation_ctx c on c.cleanup_id = g.id
  ),
  'cleanup completion stamps marker'
);
select is(
  (
    select public.complete_generation_artifact_cleanup(
      cleanup_id, 'expired'
    ) ->> 'outcome'
      from generation_ctx
  ),
  'already_cleaned',
  'cleanup completion is idempotent'
);

-- 1000 deleted profiles with no work must not starve the 1001st profile's
-- queued row. The RPC joins target generations first instead of pre-limiting owners.
do $fair_fixture$
declare
  v_user uuid;
  v_fair_gen uuid := (select fair_gen_id from generation_ctx);
begin
  for i in 1..1001 loop
    v_user := gen_random_uuid();
    insert into auth.users(id, email)
    values (
      v_user,
      'generation-fair-' || i::text || '-' || v_user::text || '@example.test'
    );
    if i = 1001 then
      insert into public.ai_generations(id, owner_id, status)
      values (v_fair_gen, v_user, 'queued');
    end if;
    update public.profiles
       set deleted_at = now()
     where id = v_user;
  end loop;
end;
$fair_fixture$;

select ok(
  (
    select exists (
      select 1
        from public.list_deleted_owner_inflight_generations(20) q
        join generation_ctx c on c.fair_gen_id = q.id
    )
  ),
  'deleted-owner inflight scan reaches work beyond 1000 no-work profiles'
);

select * from finish();
rollback;
