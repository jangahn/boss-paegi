-- 0102: 정리 잡 백오프를 '연속 실패' 기준으로 교정 — attempt_count conflation 3건
--
-- 종전엔 claim 마다 attempt_count +1 만 있고 리셋이 없어 이 값이 '누적 청구
-- 횟수'를 인코딩했다. 다배치 계정(객체 수백 개)은 정상 진행만으로 수십 회
-- 청구를 쌓으므로, 첫 실제 실패에서 백오프 지수 2^min(attempt_count-1, 7)
-- 가 곧바로 상한(1h)으로 점프해 정리 완료·재활성 해제가 부당하게 지연됐다
-- (감사 wf_d47fc072 M6). 성공 finish 두 지점(단계 전진 pending·completed)에
-- attempt_count = 0 리셋을 추가해 이 값이 '마지막 성공 이후 연속 청구 수'
-- (= 연속 실패 수 + 1)가 되게 한다 — 첫 실패는 30s 부터 정상 에스컬레이션.
--
-- target_remains(성공 보고했으나 storage 대상 잔존) 경로는 검증 실패로
-- 간주해 리셋하지 않는다. claim 의 +1, 실패 경로, 백오프 공식은 무접촉이라
-- lease fence·attempt_count >= 1 (TS lease 검증) 불변식이 그대로 유지되며,
-- 나머지 함수 본문은 008903 원문과 자구 동일하다.

-- ── 같은 결함 계열 1: finish_account_deletion_cleanup_v2 ─────────────────────

create or replace function public.finish_account_deletion_cleanup_v2(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_success boolean,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_deletion_cleanup_jobs%rowtype;
  v_user_id uuid;
  v_batch_size integer;
  v_generation_batch_size integer;
  v_existing_count integer;
  v_removed_count integer;
  v_scrubbed_generations integer;
  v_delay integer;
  v_horizon timestamptz;
  v_has_target boolean;
  v_has_generation boolean;
  v_has_open_intent boolean;
  v_has_open_generation_reconciliation boolean;
  v_auth_scrubbed boolean;
  v_status text;
  v_next_attempt_at timestamptz;
begin
  select j.user_id
    into v_user_id
    from public.account_deletion_cleanup_jobs j
   where j.id = p_job_id;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  perform public.bp_user_mutation_lock(v_user_id);
  perform 1
    from public.profiles p
   where p.id = v_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_job
    from public.account_deletion_cleanup_jobs j
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_token = p_lease_token
     and j.lease_version = p_lease_version
     and j.leased_until > pg_catalog.clock_timestamp()
   for update;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  v_batch_size := pg_catalog.jsonb_array_length(v_job.lease_targets);
  v_generation_batch_size :=
    pg_catalog.jsonb_array_length(v_job.lease_generation_ids);
  select count(*)::integer
    into v_existing_count
    from pg_catalog.jsonb_array_elements(v_job.lease_targets) target
   where exists (
     select 1
       from storage.objects o
      where o.bucket_id = target->>'bucket'
        and o.name = target->>'path'
   );
  v_removed_count := v_batch_size - v_existing_count;

  if not coalesce(p_success, false) then
    v_delay := least(
      3600,
      (
        30 * pg_catalog.power(
          2::numeric,
          least(greatest(v_job.attempt_count - 1, 0), 7)
        )
      )::integer
    );
    update public.account_deletion_cleanup_jobs
       set status = 'pending',
           lease_targets = '[]'::jsonb,
           lease_generation_ids = '[]'::jsonb,
           removed_target_count =
             removed_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = pg_catalog.left(
             coalesce(
               nullif(pg_catalog.btrim(p_error), ''),
               'cleanup_failed'
             ),
             1000
           ),
           next_attempt_at =
             pg_catalog.clock_timestamp()
               + pg_catalog.make_interval(secs => v_delay),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'user_id', v_job.user_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending',
      'retry_in_seconds', v_delay
    );
  end if;

  if v_existing_count > 0 then
    update public.account_deletion_cleanup_jobs
       set status = 'pending',
           lease_targets = '[]'::jsonb,
           lease_generation_ids = '[]'::jsonb,
           removed_target_count =
             removed_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = 'cleanup_target_remains',
           next_attempt_at =
             pg_catalog.clock_timestamp() + interval '5 seconds',
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'user_id', v_job.user_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending_target_remains',
      'remaining_targets', v_existing_count
    );
  end if;

  v_scrubbed_generations :=
    public.bp_scrub_account_generation_batch(
      v_job.user_id,
      v_job.lease_generation_ids
    );
  if v_scrubbed_generations <> v_generation_batch_size then
    raise exception 'cleanup_generation_target_changed'
      using errcode = 'P0001';
  end if;

  v_horizon :=
    public.bp_account_cleanup_intent_horizon(v_job.user_id);
  update public.account_deletion_cleanup_jobs
     set removed_target_count =
           removed_target_count + v_removed_count,
         scrubbed_generation_count =
           scrubbed_generation_count + v_scrubbed_generations,
         final_sweep_after = greatest(
           final_sweep_after,
           coalesce(v_horizon, final_sweep_after)
         )
   where id = v_job.id
  returning * into v_job;

  select exists (
    select 1
      from public.bp_account_cleanup_targets(v_job.user_id, 1)
  ) into v_has_target;
  select exists (
    select 1
      from public.bp_account_cleanup_generation_targets(
        v_job.user_id,
        1
      )
  ) into v_has_generation;
  v_has_open_intent :=
    public.bp_account_cleanup_has_open_intent(v_job.user_id);
  v_has_open_generation_reconciliation :=
    public.bp_account_cleanup_has_open_generation_reconciliation(
      v_job.user_id
    );
  v_auth_scrubbed :=
    public.bp_account_cleanup_auth_is_scrubbed(v_job.user_id);

  if v_has_target or v_has_generation then
    v_status := 'pending_batch';
    v_next_attempt_at := pg_catalog.clock_timestamp();
  elsif pg_catalog.clock_timestamp() < v_job.final_sweep_after then
    v_status := 'pending_final_sweep';
    v_next_attempt_at := v_job.final_sweep_after;
  elsif v_has_open_generation_reconciliation then
    v_status := 'pending_generation_reconciliation';
    v_next_attempt_at := pg_catalog.clock_timestamp() + interval '5 minutes';
  elsif v_has_open_intent then
    v_status := 'pending_intent_drain';
    v_next_attempt_at := pg_catalog.clock_timestamp() + interval '30 seconds';
  elsif not v_auth_scrubbed then
    v_status := 'pending_auth_scrub';
    v_next_attempt_at := pg_catalog.clock_timestamp();
  else
    update auth.users u
       set raw_app_meta_data =
             case
               when pg_catalog.jsonb_typeof(u.raw_app_meta_data) = 'object'
                 then u.raw_app_meta_data - 'bp_account_cleanup_fence'
               else u.raw_app_meta_data
             end,
           updated_at = pg_catalog.clock_timestamp()
     where u.id = v_job.user_id
       and u.raw_app_meta_data
             ->'bp_account_cleanup_fence'->>'job_id' =
               v_job.id::text
       and u.raw_app_meta_data
             ->'bp_account_cleanup_fence'->>'user_id' =
               v_job.user_id::text
       and u.raw_app_meta_data
             ->'bp_account_cleanup_fence'->>'action' = 'scrub';

    update public.account_deletion_cleanup_jobs
       set status = 'completed',
           manifest = '{}'::jsonb,
           lease_targets = '[]'::jsonb,
           lease_generation_ids = '[]'::jsonb,
           lease_token = null,
           leased_until = null,
           last_error = null,
           attempt_count = 0,
           completed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'user_id', v_job.user_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'completed',
      'removed_targets', v_job.removed_target_count,
      'scrubbed_generations', v_job.scrubbed_generation_count
    );
  end if;

  update public.account_deletion_cleanup_jobs
     set status = 'pending',
         lease_targets = '[]'::jsonb,
         lease_generation_ids = '[]'::jsonb,
         lease_token = null,
         leased_until = null,
         last_error = null,
         attempt_count = 0,
         next_attempt_at = v_next_attempt_at,
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', v_status,
    'final_sweep_after', v_job.final_sweep_after
  );
end;
$$;

-- ── 같은 결함 계열 2: finish_moderation_purge_v2 ─────────────────────────────
-- 008903 v2 는 모더레이션 퍼지도 다배치(성공 finish 가 pending_batch/
-- pending_final_sweep/pending_intent_drain 으로 재무장)라 동일하게
-- attempt_count 가 배치 수를 인코딩한다. 성공 두 지점(단계 전진·completed)에
-- 리셋 추가, purge_target_remains 는 검증 실패로 간주해 무리셋. 나머지는
-- 008903 원문과 자구 동일.

create or replace function public.finish_moderation_purge_v2(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_success boolean,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.moderation_purge_jobs%rowtype;
  v_doll public.dolls%rowtype;
  v_doll_id uuid;
  v_batch_size integer;
  v_existing_count integer;
  v_removed_count integer;
  v_delay integer;
  v_horizon timestamptz;
  v_has_target boolean;
  v_has_open_intent boolean;
  v_status text;
  v_next_attempt_at timestamptz;
begin
  select j.doll_id
    into v_doll_id
    from public.moderation_purge_jobs j
   where j.id = p_job_id;
  if not found then
    raise exception 'purge_lease_lost' using errcode = 'P0001';
  end if;

  select *
    into v_doll
    from public.dolls d
   where d.id = v_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_job
    from public.moderation_purge_jobs j
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_token = p_lease_token
     and j.lease_version = p_lease_version
     and j.leased_until > pg_catalog.clock_timestamp()
   for update;
  if not found then
    raise exception 'purge_lease_lost' using errcode = 'P0001';
  end if;
  if v_doll.deleted_at is null then
    raise exception 'purge_state_conflict' using errcode = 'P0001';
  end if;

  v_batch_size := pg_catalog.jsonb_array_length(v_job.manifest);
  select count(*)::integer
    into v_existing_count
    from pg_catalog.jsonb_array_elements(v_job.manifest) target
   where exists (
     select 1
       from storage.objects o
      where o.bucket_id = target->>'bucket'
        and o.name = target->>'path'
   );
  v_removed_count := v_batch_size - v_existing_count;

  if not coalesce(p_success, false) then
    v_delay := least(
      3600,
      (
        30 * pg_catalog.power(
          2::numeric,
          least(greatest(v_job.attempt_count - 1, 0), 7)
        )
      )::integer
    );
    update public.moderation_purge_jobs
       set status = 'pending',
           manifest = '[]'::jsonb,
           purged_target_count =
             purged_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = pg_catalog.left(
             coalesce(
               nullif(pg_catalog.btrim(p_error), ''),
               'purge_failed'
             ),
             1000
           ),
           next_attempt_at =
             pg_catalog.clock_timestamp()
               + pg_catalog.make_interval(secs => v_delay),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'doll_id', v_job.doll_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending',
      'retry_in_seconds', v_delay
    );
  end if;

  if v_existing_count > 0 then
    update public.moderation_purge_jobs
       set status = 'pending',
           manifest = '[]'::jsonb,
           purged_target_count =
             purged_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = 'purge_target_remains',
           next_attempt_at =
             pg_catalog.clock_timestamp() + interval '5 seconds',
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'doll_id', v_job.doll_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending_target_remains',
      'remaining_targets', v_existing_count
    );
  end if;

  v_horizon :=
    public.bp_moderation_cleanup_intent_horizon(v_job.doll_id);
  update public.moderation_purge_jobs
     set purged_target_count =
           purged_target_count + v_removed_count,
         final_sweep_after = greatest(
           final_sweep_after,
           coalesce(v_horizon, final_sweep_after)
         )
   where id = v_job.id
  returning * into v_job;

  select exists (
    select 1
      from public.bp_moderation_cleanup_targets(v_job.doll_id, 1)
  ) into v_has_target;
  v_has_open_intent :=
    public.bp_moderation_cleanup_has_open_intent(v_job.doll_id);

  if v_has_target then
    v_status := 'pending_batch';
    v_next_attempt_at := pg_catalog.clock_timestamp();
  elsif pg_catalog.clock_timestamp() < v_job.final_sweep_after then
    v_status := 'pending_final_sweep';
    v_next_attempt_at := v_job.final_sweep_after;
  elsif v_has_open_intent then
    v_status := 'pending_intent_drain';
    v_next_attempt_at := pg_catalog.clock_timestamp() + interval '30 seconds';
  else
    update public.dolls
       set artifacts_purged_at =
             coalesce(artifacts_purged_at, pg_catalog.clock_timestamp())
     where id = v_job.doll_id;

    insert into public.moderation_actions_ledger(
      admin_user_id,
      action_type,
      target_type,
      target_id,
      reason,
      metadata
    )
    values (
      v_job.admin_user_id,
      'purge_doll',
      'doll',
      v_job.doll_id,
      v_job.reason,
      pg_catalog.jsonb_build_object(
        'purge_job_id', v_job.id,
        'purged_targets', v_job.purged_target_count,
        'lease_version', v_job.lease_version
      )
    );

    update public.moderation_purge_jobs
       set status = 'completed',
           manifest = '[]'::jsonb,
           lease_token = null,
           leased_until = null,
           last_error = null,
           attempt_count = 0,
           completed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'doll_id', v_job.doll_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'completed',
      'purged_targets', v_job.purged_target_count
    );
  end if;

  update public.moderation_purge_jobs
     set status = 'pending',
         manifest = '[]'::jsonb,
         lease_token = null,
         leased_until = null,
         last_error = null,
         attempt_count = 0,
         next_attempt_at = v_next_attempt_at,
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'doll_id', v_job.doll_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', v_status,
    'final_sweep_after', v_job.final_sweep_after
  );
end;
$$;

-- ── 같은 결함 계열 3: bp_enqueue_detached_storage_asset ──────────────────────
-- storage_object_cleanup_jobs 는 (bucket, path) unique upsert 로
-- canceled/completed 행을 부활시키는데(008901 이 guard 를 completed 까지
-- 확장), 종전 리셋 목록에 attempt_count 만 빠져 있어 이전 수명주기의
-- 카운터가 새 수명주기로 누적 승계 — 새 정리의 첫 실패가 곧바로 포화
-- 백오프(1h)를 받았다. 부활 = 새 수명주기이므로 attempt_count = 0 을 리셋
-- 목록에 추가한다. 나머지는 008901 원문과 자구 동일.

create or replace function public.bp_enqueue_detached_storage_asset(
  p_kind text,
  p_user_id uuid,
  p_subject_id uuid,
  p_bucket text,
  p_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_not_before timestamptz := pg_catalog.clock_timestamp();
  v_upload_expires_at timestamptz;
begin
  if p_path is null or p_path = '' then
    return null;
  end if;
  if not (
    (p_kind in ('avatar_clear', 'avatar_replace')
      and p_bucket = 'avatars')
    or (p_kind in ('doll_delete', 'doll_create_compensation')
      and p_bucket = 'dolls')
    or (p_kind = 'highlight_expired' and p_bucket = 'highlights')
  ) then
    raise exception 'invalid_cleanup_target' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-path:' || p_bucket || ':' || p_path,
      0
    )
  );
  if public.bp_storage_path_is_referenced(p_bucket, p_path) then
    return null;
  end if;

  if p_bucket in ('avatars', 'highlights') then
    select coalesce(i.last_token_horizon, i.expires_at)
      into v_upload_expires_at
      from public.storage_upload_intents i
     where i.bucket = p_bucket
       and i.path = p_path
       and (
         (p_bucket = 'avatars' and i.purpose = 'avatar_upload')
         or (
           p_bucket = 'highlights'
           and i.purpose = 'highlight_upload'
         )
       )
     for update;
    if found then
      v_not_before := greatest(
        v_not_before,
        v_upload_expires_at
      );
    end if;
  end if;

  insert into public.storage_object_cleanup_jobs(
    kind,
    user_id,
    subject_id,
    bucket,
    path,
    next_attempt_at
  )
  values (
    p_kind,
    p_user_id,
    p_subject_id,
    p_bucket,
    p_path,
    v_not_before
  )
  on conflict (bucket, path) do update
     set kind = excluded.kind,
         user_id = excluded.user_id,
         subject_id = excluded.subject_id,
         status = 'pending',
         attempt_count = 0,
         lease_token = null,
         leased_until = null,
         next_attempt_at = greatest(
           public.storage_object_cleanup_jobs.next_attempt_at,
           excluded.next_attempt_at
         ),
         last_error = null,
         completed_at = null,
         updated_at = pg_catalog.clock_timestamp()
   where public.storage_object_cleanup_jobs.status
           in ('canceled', 'completed')
  returning id into v_id;

  if v_id is null then
    select j.id
      into v_id
      from public.storage_object_cleanup_jobs j
     where j.bucket = p_bucket
       and j.path = p_path;
  end if;
  return v_id;
end;
$$;

