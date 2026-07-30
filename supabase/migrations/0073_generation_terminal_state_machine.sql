-- Generation terminal-state hardening.
--
-- Invariants:
--   * picked / failed / expired are terminal and can never be recovered to done.
--   * expiry is a row-locked done -> expired transition and never refunds a
--     successfully generated but unselected result.
--   * terminal artifact cleanup is retryable until artifacts_cleaned_at is set.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

alter table public.ai_generations
  drop constraint if exists ai_generations_status_check;
alter table public.ai_generations
  add constraint ai_generations_status_check
  check (status in ('queued', 'done', 'failed', 'picked', 'expired'));

alter table public.ai_generations
  add column if not exists artifacts_cleaned_at timestamptz;
comment on column public.ai_generations.artifacts_cleaned_at is
  'Terminal candidate/tmp-face cleanup completion marker; NULL is the durable retry manifest.';

-- 초기 draft가 잠시 부여했던 direct column grant까지 재적용 시 회수한다.
-- marker는 complete/reopen RPC로만 변경한다.
revoke update (artifacts_cleaned_at)
  on table public.ai_generations from service_role;

create index if not exists idx_ai_generations_terminal_cleanup_pending
  on public.ai_generations (updated_at, id)
  where status in ('failed', 'picked', 'expired')
    and artifacts_cleaned_at is null;

-- Private rolling-deploy switch shared by later migrations. 0092 replaces it
-- with a constant false implementation after the new app and old requests
-- have drained.
create or replace function public.bp_rollout_compatibility_enabled(
  p_feature text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_feature in (
    'legacy_generation_transition',
    'legacy_score_submission',
    'legacy_checkout_reuse'
  );
$$;
revoke all on function public.bp_rollout_compatibility_enabled(text)
  from public, anon, authenticated, service_role;

-- Storage write는 DB transaction과 원자화할 수 없다. 복구 worker가 candidate를
-- 쓰는 동안 terminal cleanup이 prefix를 지우고 marker를 완료하는 race를 별도
-- lease로 직렬화한다. generation row 자체를 갱신하지 않아 caller version fence를
-- 소모하지 않으며, crash 시 leased_until 뒤 cleanup이 자동 진행된다.
create table if not exists public.generation_artifact_write_leases (
  generation_id uuid primary key
    references public.ai_generations(id) on delete cascade,
  lease_token uuid not null unique default gen_random_uuid(),
  leased_until timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.generation_artifact_write_leases enable row level security;
revoke all on table public.generation_artifact_write_leases
  from public, anon, authenticated, service_role;

create index if not exists idx_generation_artifact_write_lease_expiry
  on public.generation_artifact_write_leases(leased_until);

create or replace function public.enforce_generation_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'queued' and new.status in ('done', 'failed') then
    return new;
  end if;
  if old.status = 'done' and new.status in ('picked', 'expired') then
    return new;
  end if;
  -- Old recovery may finalize a failed row after the provider completed late.
  -- This is financially safe only when no credit refund has committed.
  if public.bp_rollout_compatibility_enabled(
       'legacy_generation_transition'
     )
     and old.status = 'failed'
     and new.status = 'done'
     and old.refunded_at is null
  then
    new.artifacts_cleaned_at := null;
    return new;
  end if;
  -- Old reviewer/ops expiry writes done->failed after deleting Storage. Map
  -- that exact no-credit shape to the new terminal state instead of leaving a
  -- live done row with missing objects.
  if public.bp_rollout_compatibility_enabled(
       'legacy_generation_transition'
     )
     and old.status = 'done'
     and new.status = 'failed'
     and new.fail_reason = 'expired'
     and old.credit_lot_id is null
  then
    new.status := 'expired';
    return new;
  end if;
  raise exception 'invalid_generation_transition:%->%', old.status, new.status
    using errcode = 'P0001';
end;
$$;
revoke all on function public.enforce_generation_status_transition()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_ai_generations_status_transition
  on public.ai_generations;
create trigger trg_ai_generations_status_transition
  before update of status on public.ai_generations
  for each row execute function public.enforce_generation_status_transition();

create or replace function public.claim_generation_artifact_write(
  p_gen_id uuid,
  p_expected_version int,
  p_lease_seconds int default 600
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
  v_lease public.generation_artifact_write_leases%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds int := greatest(120, least(coalesce(p_lease_seconds, 600), 900));
begin
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'outcome', 'not_found');
  end if;
  if g.status not in ('queued', 'done') or g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'conflict', 'status', g.status);
  end if;
  if g.version <> p_expected_version then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict',
      'expectedVersion', p_expected_version, 'actualVersion', g.version);
  end if;

  select *
    into v_lease
    from public.generation_artifact_write_leases
   where generation_id = p_gen_id
   for update;
  if found and v_lease.leased_until > clock_timestamp() then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'busy',
      'leased_until', v_lease.leased_until);
  end if;

  delete from public.generation_artifact_write_leases
   where generation_id = p_gen_id;
  insert into public.generation_artifact_write_leases(
    generation_id, lease_token, leased_until
  )
  values (
    p_gen_id,
    v_token,
    clock_timestamp() + pg_catalog.make_interval(secs => v_seconds)
  )
  returning * into v_lease;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'claimed',
    'lease_token', v_lease.lease_token,
    'leased_until', v_lease.leased_until
  );
end;
$$;
revoke all on function public.claim_generation_artifact_write(uuid, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_generation_artifact_write(uuid, int, int)
  to service_role;

create or replace function public.release_generation_artifact_write(
  p_gen_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from public.generation_artifact_write_leases
   where generation_id = p_gen_id
     and lease_token = p_lease_token;
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object(
    'ok', v_deleted = 1,
    'outcome', case when v_deleted = 1 then 'released' else 'lease_lost' end
  );
end;
$$;
revoke all on function public.release_generation_artifact_write(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_generation_artifact_write(uuid, uuid)
  to service_role;

-- deleted profile을 먼저 1000개로 자르는 2단계 scan은 뒤 owner를 영구
-- starvation시킨다. 실제 terminalize 대상 row를 직접 join/order/limit한다.
create or replace function public.list_deleted_owner_inflight_generations(
  p_limit int default 20
)
returns table(id uuid, owner_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.owner_id
    from public.ai_generations g
    join public.profiles p on p.id = g.owner_id
   where p.deleted_at is not null
     and g.status in ('queued', 'done')
   order by g.updated_at asc, g.id asc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;
revoke all on function public.list_deleted_owner_inflight_generations(int)
  from public, anon, authenticated;
grant execute on function public.list_deleted_owner_inflight_generations(int)
  to service_role;

-- Keep the failure/refund RPC terminal-safe. Only queued and an already-failed
-- retry are legal inputs; done/picked/expired never move backwards.
create or replace function public.mark_generation_failed_and_refund(
  p_gen_id uuid, p_fail_reason text, p_expected_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
  v_refund_version int;
begin
  select * into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    raise exception 'generation_not_found' using errcode = 'P0001';
  end if;
  -- Old paid-user expiry calls this RPC after Storage cleanup. Converge it to
  -- done->expired without refund so the old caller stops before its unsafe
  -- direct done->failed fallback.
  if g.status = 'done'
     and p_fail_reason = 'expired'
     and public.bp_rollout_compatibility_enabled(
       'legacy_generation_transition'
     )
  then
    if p_expected_version is not null and g.version <> p_expected_version then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'version_conflict',
        'expectedVersion', p_expected_version, 'actualVersion', g.version);
    end if;
    update public.ai_generations
       set status = 'expired', fail_reason = 'expired'
     where id = p_gen_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'expired', 'refunded', false);
  end if;
  if g.status not in ('queued', 'failed') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  -- caller fence는 어떤 상태/금융 write보다 먼저 한 번만 검증한다.
  if p_expected_version is not null and g.version <> p_expected_version then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict',
      'expectedVersion', p_expected_version, 'actualVersion', g.version);
  end if;
  if g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if g.status <> 'failed' then
    update public.ai_generations
       set status = 'failed', fail_reason = p_fail_reason
     where id = p_gen_id
     returning version into v_refund_version;
  else
    v_refund_version := g.version;
  end if;
  if g.credit_lot_id is null then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_consume');
  end if;
  -- status update audit trigger가 version을 올렸으므로 내부 core에는 전이 후
  -- 현재 version을 넘긴다. 외부 expected fence를 두 번 적용하지 않는다.
  return public.refund_gen_credit_v2(p_gen_id, v_refund_version);
end;
$$;
revoke all on function public.mark_generation_failed_and_refund(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.mark_generation_failed_and_refund(uuid, text, int)
  to service_role;

create or replace function public.expire_generation(
  p_gen_id uuid, p_expected_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare g public.ai_generations;
begin
  select * into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'outcome', 'not_found');
  end if;
  if g.status = 'expired' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_expired', 'idempotent', true);
  end if;
  if g.status <> 'done' or g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'conflict', 'status', g.status);
  end if;
  if p_expected_version is not null and g.version <> p_expected_version then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict',
      'expectedVersion', p_expected_version, 'actualVersion', g.version);
  end if;

  update public.ai_generations
     set status = 'expired', fail_reason = 'expired'
   where id = p_gen_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'expired');
end;
$$;
revoke all on function public.expire_generation(uuid, int)
  from public, anon, authenticated;
grant execute on function public.expire_generation(uuid, int)
  to service_role;

create or replace function public.begin_generation_artifact_cleanup(
  p_gen_id uuid, p_expected_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
  v_leased_until timestamptz;
begin
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'outcome', 'not_found');
  end if;
  if g.status not in ('failed', 'picked', 'expired')
     or g.status <> p_expected_status then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'conflict', 'status', g.status);
  end if;
  if g.artifacts_cleaned_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_cleaned', 'idempotent', true);
  end if;

  select l.leased_until
    into v_leased_until
    from public.generation_artifact_write_leases l
   where l.generation_id = p_gen_id
   for update;
  if found and v_leased_until > clock_timestamp() then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'write_busy',
      'leased_until', v_leased_until);
  end if;
  delete from public.generation_artifact_write_leases
   where generation_id = p_gen_id;

  -- generation은 terminal이라 이 row lock이 풀린 뒤에도 신규 write lease를
  -- claim할 수 없다. 따라서 반환 후 Storage delete→complete가 안전하다.
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'ready');
end;
$$;
revoke all on function public.begin_generation_artifact_cleanup(uuid, text)
  from public, anon, authenticated;
grant execute on function public.begin_generation_artifact_cleanup(uuid, text)
  to service_role;

-- legacy/in-flight worker의 보상삭제가 실패한 경우 완료 marker를 재개방해
-- terminal cron이 다시 prefix를 지우게 한다. 새 lease 경계 적용 뒤에도 방어층으로 유지한다.
create or replace function public.reopen_generation_artifact_cleanup(
  p_gen_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
begin
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'outcome', 'not_found');
  end if;
  if g.status not in ('failed', 'picked', 'expired') then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'conflict', 'status', g.status);
  end if;
  if g.artifacts_cleaned_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_open', 'idempotent', true);
  end if;

  update public.ai_generations
     set artifacts_cleaned_at = null
   where id = p_gen_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'reopened');
end;
$$;
revoke all on function public.reopen_generation_artifact_cleanup(uuid)
  from public, anon, authenticated;
grant execute on function public.reopen_generation_artifact_cleanup(uuid)
  to service_role;

create or replace function public.complete_generation_artifact_cleanup(
  p_gen_id uuid, p_expected_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare g public.ai_generations;
begin
  select * into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'outcome', 'not_found');
  end if;
  if g.status not in ('failed', 'picked', 'expired')
     or g.status <> p_expected_status then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'conflict', 'status', g.status);
  end if;
  if g.artifacts_cleaned_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_cleaned', 'idempotent', true);
  end if;
  if exists (
    select 1
      from public.generation_artifact_write_leases l
     where l.generation_id = p_gen_id
       and l.leased_until > clock_timestamp()
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'write_busy');
  end if;

  update public.ai_generations
     set candidate_urls = '[]'::jsonb,
         artifacts_cleaned_at = pg_catalog.clock_timestamp()
   where id = p_gen_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'cleaned');
end;
$$;
revoke all on function public.complete_generation_artifact_cleanup(uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_generation_artifact_cleanup(uuid, text)
  to service_role;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.ai_generations'::regclass
       and conname = 'ai_generations_status_check'
       and pg_get_constraintdef(oid) like '%expired%'
  ) then
    raise exception '0073 postflight: expired status constraint missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.ai_generations'::regclass
       and tgname = 'trg_ai_generations_status_transition'
       and not tgisinternal
  ) then
    raise exception '0073 postflight: generation transition trigger missing';
  end if;
  if not (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.generation_artifact_write_leases'::regclass
  )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.generation_artifact_write_leases',
       'SELECT')
  then
    raise exception '0073 postflight: artifact write lease table boundary open';
  end if;

  if not pg_catalog.has_function_privilege(
    'service_role', 'public.expire_generation(uuid,integer)', 'EXECUTE')
  then
    raise exception '0073 postflight: service_role cannot expire generation';
  end if;
  if pg_catalog.has_function_privilege(
    'anon', 'public.expire_generation(uuid,integer)', 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.expire_generation(uuid,integer)', 'EXECUTE')
  then
    raise exception '0073 postflight: client role can expire generation';
  end if;
  if not pg_catalog.has_function_privilege(
    'service_role',
    'public.complete_generation_artifact_cleanup(uuid,text)',
    'EXECUTE')
  then
    raise exception '0073 postflight: service_role cannot complete artifact cleanup';
  end if;
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_generation_artifact_write(uuid,integer,integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.release_generation_artifact_write(uuid,uuid)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.begin_generation_artifact_cleanup(uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.reopen_generation_artifact_cleanup(uuid)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.list_deleted_owner_inflight_generations(integer)',
       'EXECUTE')
  then
    raise exception '0073 postflight: artifact lifecycle RPC grant missing';
  end if;
  if pg_catalog.has_function_privilege(
    'anon',
    'public.complete_generation_artifact_cleanup(uuid,text)',
    'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.complete_generation_artifact_cleanup(uuid,text)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon',
       'public.claim_generation_artifact_write(uuid,integer,integer)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.begin_generation_artifact_cleanup(uuid,text)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon',
       'public.list_deleted_owner_inflight_generations(integer)',
       'EXECUTE')
  then
    raise exception '0073 postflight: client role can access artifact lifecycle';
  end if;

  if pg_catalog.has_column_privilege(
    'service_role',
    'public.ai_generations',
    'artifacts_cleaned_at',
    'UPDATE'
  ) then
    raise exception '0073 postflight: cleanup marker direct UPDATE grant leaked';
  end if;
end $$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0073_generation_terminal_state_machine', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
