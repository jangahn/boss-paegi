-- 0072: 계정 탈퇴 외부 정리 outbox/saga
--
-- 목적:
--   1) dolls/highlights/uploaded avatar 경로를 DB 익명화·삭제 전에 manifest로 고정한다.
--   2) cleanup job 생성 + 0062 금융 quarantine + 0034 개인정보 render-block/신고 종결 +
--      soft-delete를 한 트랜잭션으로 묶는다.
--   3) Vercel 요청이 Storage/Auth 정리 도중 중단되어도 lease 만료 뒤 content-maintain이 재시도한다.
--
-- 적용 순서: 이 migration 먼저 → 앱 코드 배포. 운영 적용은 별도 승인 절차에서 수행한다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- ── 1. durable cleanup outbox ────────────────────────────────────────────────
create table public.account_deletion_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  -- 의도적으로 profiles FK를 두지 않는다. 현재 금융 FK가 profile hard-delete를 막지만,
  -- 향후 합법적인 영구 purge가 추가되어도 외부 Storage/Auth 정리 outbox와 scrub된 감사 이력이
  -- profile보다 오래 살아 재시도/증명 가능해야 한다. user_id 유효성은 job 생성 RPC의 row lock이 보장한다.
  user_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed')),
  manifest jsonb not null,
  attempt_count int not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  -- signed-upload URL은 발급 뒤 2시간 동안 auth 재검사 없이 업로드할 수 있다.
  -- 탈퇴 직전 발급된 마지막 token까지 만료된 뒤 prefix 전수 sweep을 한 번 더
  -- 성공해야 completed가 된다. 그 전에는 재활성 trigger가 ABA를 계속 차단한다.
  final_sweep_after timestamptz not null
    default (now() + interval '2 hours 5 minutes'),
  lease_token uuid,
  leased_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint account_deletion_cleanup_manifest_check check (
    (
      status = 'completed'
      and manifest = '{}'::jsonb
    )
    or
    (
      status <> 'completed'
      and jsonb_typeof(manifest) = 'object'
      and manifest ?& array['dolls', 'highlights', 'avatar']
      and jsonb_typeof(manifest -> 'dolls') = 'array'
      and jsonb_typeof(manifest -> 'highlights') = 'array'
      and (
        manifest -> 'avatar' = 'null'::jsonb
        or jsonb_typeof(manifest -> 'avatar') = 'string'
      )
    )
  ),
  constraint account_deletion_cleanup_lease_check check (
    (status = 'leased') = (lease_token is not null and leased_until is not null)
  ),
  constraint account_deletion_cleanup_completion_check check (
    (status = 'completed') = (completed_at is not null)
  )
);

comment on table public.account_deletion_cleanup_jobs is
  '계정 탈퇴 Storage/Auth 정리 outbox. manifest는 완료 즉시 {}로 scrub하며 앱/cron은 lease RPC로만 접근한다.';

alter table public.account_deletion_cleanup_jobs enable row level security;
revoke all on table public.account_deletion_cleanup_jobs
  from public, anon, authenticated, service_role;

-- 재활성 뒤 다시 탈퇴할 수 있으므로 user_id 영구 unique가 아니라 active job만 하나로 제한한다.
create unique index uq_account_deletion_cleanup_active_user
  on public.account_deletion_cleanup_jobs(user_id)
  where status in ('pending', 'leased');

-- due 시각이 오래된 job부터 처리해 반복 실패 job도 새 job에 굶지 않게 한다.
create index idx_account_deletion_cleanup_claim
  on public.account_deletion_cleanup_jobs(next_attempt_at, created_at, id)
  where status in ('pending', 'leased');

-- ── 2. DB 저장값(full public/signed URL 또는 bucket-relative path) 정규화 ───
create or replace function public.bp_account_cleanup_storage_path(
  p_value text,
  p_bucket text
)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v text;
begin
  if p_bucket !~ '^[a-z0-9-]+$' then
    return null;
  end if;

  v := pg_catalog.btrim(p_value);
  v := pg_catalog.split_part(pg_catalog.split_part(v, '?', 1), '#', 1);
  if v = '' then
    return null;
  end if;

  if pg_catalog.strpos(v, '/' || p_bucket || '/') > 0 then
    -- greedy prefix 제거 = URL 안 마지막 /{bucket}/ 뒤의 상대경로.
    v := pg_catalog.regexp_replace(v, '^.*/' || p_bucket || '/', '');
  elsif v ~ '^[a-z][a-z0-9+.-]*://' then
    -- bucket marker 없는 외부 URL은 절대 Storage 삭제 대상으로 변환하지 않는다.
    return null;
  end if;

  v := pg_catalog.ltrim(v, '/');
  if v = ''
     or ('/' || v || '/') like '%/../%'
     or ('/' || v || '/') like '%/./%' then
    return null;
  end if;
  return v;
end;
$$;

revoke all on function public.bp_account_cleanup_storage_path(text, text)
  from public, anon, authenticated, service_role;

-- ── 3. soft-delete + cleanup job 원자 생성 ───────────────────────────────────
-- 0062 최종 정의의 금융 차단/quarantine을 유지하면서 0034의 highlight render-block 및
-- 삭제될 doll의 pending report 종결을 복원한다.
create or replace function public.admin_soft_delete_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_existing public.account_deletion_cleanup_jobs%rowtype;
  v_job_id uuid;
  v_manifest jsonb;
  v_doll_paths jsonb;
  v_highlight_paths jsonb;
  v_avatar_path text;
  v_pending_order uuid;
  lot record;
begin
  -- profiles FOR UPDATE는 child FK insert의 KEY SHARE와 충돌한다. 이미 시작된 child write가
  -- 끝난 뒤 manifest를 읽고, 이 트랜잭션 종료 전 신규 dolls/scores/orders/refund insert를 막는다.
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  -- 동일 탈퇴의 동시/재호출은 active outbox를 그대로 반환한다.
  select *
    into v_existing
    from public.account_deletion_cleanup_jobs
   where user_id = p_user_id
     and status in ('pending', 'leased')
   order by created_at desc, id desc
   limit 1
   for update;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_existing.id,
      'user_id', p_user_id,
      'cleanup_status', v_existing.status,
      'manifest', v_existing.manifest
    );
  end if;

  -- 이미 완료된 동일 탈퇴의 방어적 재호출. 재활성 계정은 deleted_at=null이므로 새 job을 만든다.
  if v_profile.deleted_at is not null then
    select *
      into v_existing
      from public.account_deletion_cleanup_jobs
     where user_id = p_user_id
       and status = 'completed'
     order by completed_at desc, id desc
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'job_id', v_existing.id,
        'user_id', p_user_id,
        'cleanup_status', 'completed',
        'manifest', '{}'::jsonb
      );
    end if;
    raise exception 'account_deleted_without_cleanup_job' using errcode = 'P0001';
  end if;

  -- 결제 상태 전이를 먼저 잠근 뒤 최근 pending을 이 원자 경계 안에서도 차단한다.
  perform 1 from public.orders where user_id = p_user_id for update;
  select order_uuid
    into v_pending_order
    from public.orders
   where user_id = p_user_id
     and status = 'pending'
     and created_at > now() - interval '30 minutes'
   order by created_at desc
   limit 1
   for update;
  if found then
    raise exception 'payment_pending' using errcode = 'P0001';
  end if;

  -- 0062 §39: open 환불/의무 이슈가 있으면 먼저 해결해야 한다.
  -- 기존 row의 상태 전이도 manifest/quarantine 판정과 경합하지 않도록 전수 잠근다.
  perform 1
    from public.order_refund_attempts
   where user_id = p_user_id
   for update;
  perform 1
    from public.refund_requests
   where user_id = p_user_id
   for update;
  perform 1
    from public.reconciliation_issues
   where user_id = p_user_id
   for update;

  if exists (
    select 1
      from public.order_refund_attempts
     where user_id = p_user_id
       and state in (
         'prepared', 'pg_requested', 'pg_pending', 'pg_succeeded',
         'manual_pending', 'manual_review'
       )
  ) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.refund_requests
     where user_id = p_user_id
       and state in ('building', 'prepared', 'processing', 'blocked')
  ) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.reconciliation_issues i
     where i.user_id = p_user_id
       and i.state = 'open'
       and i.type in (
         'economic_over_refund', 'manual_pg_cancel', 'unmatched_cancellation'
       )
  ) then
    raise exception 'open_issue_blocks_delete' using errcode = 'P0001';
  end if;

  -- 기존 자산 row를 잠가 path 변경/새 highlight attach와 manifest 수집을 직렬화한다.
  perform 1
    from public.dolls
   where owner_id = p_user_id
   for update;
  perform 1
    from public.scores
   where owner_id = p_user_id
   for update;
  perform 1
    from public.score_highlights sh
    join public.scores s on s.id = sh.score_id
   where s.owner_id = p_user_id
   for update of sh;

  select coalesce(pg_catalog.jsonb_agg(path order by path), '[]'::jsonb)
    into v_doll_paths
    from (
      select distinct public.bp_account_cleanup_storage_path(image_url, 'dolls') as path
        from public.dolls
       where owner_id = p_user_id
    ) paths
   where path is not null;

  select coalesce(pg_catalog.jsonb_agg(path order by path), '[]'::jsonb)
    into v_highlight_paths
    from (
      select distinct
             public.bp_account_cleanup_storage_path(sh.highlight_clip_path, 'highlights') as path
        from public.score_highlights sh
        join public.scores s on s.id = sh.score_id
       where s.owner_id = p_user_id
         and sh.highlight_clip_path is not null
    ) paths
   where path is not null;

  v_avatar_path :=
    public.bp_account_cleanup_storage_path(v_profile.avatar_url, 'avatars');
  if v_avatar_path is not null
     and v_avatar_path not like p_user_id::text || '/%' then
    -- OAuth/provider/default avatar는 외부 자산. 서버 업로드 본인 폴더만 물리삭제한다.
    v_avatar_path := null;
  end if;

  v_manifest := pg_catalog.jsonb_build_object(
    'dolls', v_doll_paths,
    'highlights', v_highlight_paths,
    'avatar', v_avatar_path
  );

  insert into public.account_deletion_cleanup_jobs(user_id, manifest)
  values (p_user_id, v_manifest)
  returning id into v_job_id;

  -- 0062 §39 금융 quarantine: live lot을 계정삭제 만료로 잠그고 캐시/원장을 정합시킨다.
  for lot in
    select id, (qty - consumed - refunded - refund_reserved) as avail
      from public.credit_lots
     where user_id = p_user_id
       and expired_at is null
     for update
  loop
    update public.credit_lots
       set expired_at = now(), expiration_reason = 'account_deleted'
     where id = lot.id;
    if lot.avail > 0 then
      update public.member_accounts
         set gen_credits = gen_credits - lot.avail
       where user_id = p_user_id;
    end if;
    perform public.bp_credit_ledger_write(
      p_user_id, -lot.avail, 'expire',
      null, null, lot.id, null, null, null, 'account_deleted'
    );
  end loop;

  -- 0034 §6 회귀 복원: 탈퇴자의 얼굴 highlight는 즉시 신규 렌더에서 차단한다.
  update public.score_highlights sh
     set highlight_deleted_at = coalesce(sh.highlight_deleted_at, now())
    from public.scores s
   where sh.score_id = s.id
     and s.owner_id = p_user_id;

  -- 곧 hard-delete될 dolls의 pending 신고를 시스템 actioned로 종결한다.
  update public.content_reports
     set status = 'actioned',
         resolved_at = now(),
         resolved_by = null
   where target_type = 'doll'
     and status = 'pending'
     and target_id in (
       select id from public.dolls where owner_id = p_user_id
     );

  update public.profiles
     set deleted_at = coalesce(deleted_at, now()),
         display_name = '탈퇴한 사용자',
         avatar_url = null
   where id = p_user_id;
  update public.member_accounts
     set email = null,
         gen_credits = 0
   where user_id = p_user_id;

  -- scores.doll_id는 ON DELETE SET NULL, 점수 숫자는 비식별 보존한다.
  delete from public.dolls where owner_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'user_id', p_user_id,
    'cleanup_status', 'pending',
    'manifest', v_manifest
  );
end;
$$;

revoke all on function public.admin_soft_delete_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_soft_delete_account(uuid) to service_role;

-- ── 4. stale authenticated write DB backstop ─────────────────────────────────
-- 앱의 requireMember deleted_at gate를 통과해 대기 중이던 요청도 탈퇴 commit 뒤 재개될 수 있다.
-- nickname Data API UPDATE는 active profile에만 허용한다. USING은 delete-first
-- EvalPlanQual 재검사를 0-row로 수렴시키고 WITH CHECK는 active→deleted 우회를 막는다.
drop policy if exists "profiles: self update" on public.profiles;
create policy "profiles: self update"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id and deleted_at is null)
  with check (auth.uid() = id and deleted_at is null);

-- table owner/service 경로가 RLS를 우회하더라도 deleted profile의 scrubbed nickname을
-- 복원할 수 없다. soft-delete(active→deleted)와 정상 reactivation(deleted→active)은
-- 허용하고, deleted→deleted display_name 변경만 거부한다.
create or replace function public.bp_reject_deleted_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is not null and new.deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.bp_reject_deleted_profile_update()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_profiles_reject_deleted_display_name_update
  on public.profiles;
create trigger trg_profiles_reject_deleted_display_name_update
  before update of display_name on public.profiles
  for each row execute function public.bp_reject_deleted_profile_update();

-- 모든 owner child INSERT가 profile KEY SHARE를 잡고 deleted_at을 재검사하게 해,
-- admin_soft_delete_account의 profile FOR UPDATE와 하나의 직렬화 경계를 만든다.
create or replace function public.bp_reject_deleted_owner_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = new.owner_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.bp_reject_deleted_owner_insert()
  from public, anon, authenticated, service_role;

-- score_highlights에는 owner_id가 없으므로 score→profile을 따라가는 전용
-- lifecycle trigger가 필요하다. score도 SHARE lock해 review 전이와 attach를
-- 직렬화하고 공개 불가 점수의 신규 Storage 참조를 막는다.
create or replace function public.bp_reject_deleted_score_highlight_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_review_status text;
begin
  select p.deleted_at, s.review_status
    into v_deleted_at, v_review_status
    from public.scores s
    join public.profiles p on p.id = s.owner_id
   where s.id = new.score_id
   for share of s, p;
  if not found then
    raise exception 'score_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  if v_review_status not in ('registered', 'cleared') then
    raise exception 'score_not_publishable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.bp_reject_deleted_score_highlight_insert()
  from public, anon, authenticated, service_role;

-- cleanup 완료 전에 계정을 재활성화하면 retry worker가 새 avatar/auth metadata를 다시 지우는
-- ABA race가 생긴다. 기존 admin_reactivate_account 본문을 복제하지 않고 profile 상태 전이
-- 자체를 DB에서 막아 모든 현재/미래 재활성 경로에 같은 규칙을 적용한다.
create or replace function public.bp_reject_reactivation_during_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is not null
     and new.deleted_at is null
     and exists (
       select 1
         from public.account_deletion_cleanup_jobs j
        where j.user_id = new.id
          and j.status in ('pending', 'leased')
     ) then
    raise exception 'account_cleanup_pending' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.bp_reject_reactivation_during_cleanup()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_profiles_reject_early_reactivation
  on public.profiles;
create trigger trg_profiles_reject_early_reactivation
  before update of deleted_at on public.profiles
  for each row execute function public.bp_reject_reactivation_during_cleanup();

drop trigger if exists trg_dolls_reject_deleted_owner_insert on public.dolls;
create trigger trg_dolls_reject_deleted_owner_insert
  before insert on public.dolls
  for each row execute function public.bp_reject_deleted_owner_insert();

drop trigger if exists trg_scores_reject_deleted_owner_insert on public.scores;
create trigger trg_scores_reject_deleted_owner_insert
  before insert on public.scores
  for each row execute function public.bp_reject_deleted_owner_insert();

drop trigger if exists trg_score_highlights_reject_deleted_owner_insert
  on public.score_highlights;
create trigger trg_score_highlights_reject_deleted_owner_insert
  before insert on public.score_highlights
  for each row
  execute function public.bp_reject_deleted_score_highlight_insert();

drop trigger if exists trg_ai_generations_reject_deleted_owner_insert
  on public.ai_generations;
create trigger trg_ai_generations_reject_deleted_owner_insert
  before insert on public.ai_generations
  for each row execute function public.bp_reject_deleted_owner_insert();

-- generation RPC 자체도 profile을 먼저 잠근다. trigger는 future/직접 INSERT 방어,
-- RPC 검사는 크레딧 소비보다 앞선 명시적 fail-fast 계약이다.
create or replace function public.create_generation_and_consume(
  p_user uuid,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_gen uuid;
  v_remaining int;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  insert into public.ai_generations (owner_id, status, role)
  values (p_user, 'queued', p_role)
  returning id into v_gen;

  v_remaining := public.consume_gen_credit_v2(p_user, v_gen);
  if v_remaining is null then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'generation_id', v_gen,
    'remaining', v_remaining
  );
end;
$$;

revoke all on function public.create_generation_and_consume(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_generation_and_consume(uuid, text)
  to service_role;

create or replace function public.create_generation_row(
  p_user uuid,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_gen uuid;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  insert into public.ai_generations (owner_id, status, role)
  values (p_user, 'queued', p_role)
  returning id into v_gen;
  return v_gen;
end;
$$;

revoke all on function public.create_generation_row(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_generation_row(uuid, text)
  to service_role;

-- Disposable DB 2-session concurrency plan (수동/CI harness):
--   A) S1 BEGIN; admin_soft_delete_account(U); (COMMIT 보류)
--      S2 create_generation_row(U, 'boss')/dolls/scores INSERT는 대기하고,
--      S1 COMMIT 뒤 account_deleted(P0001)로 실패해야 한다.
--   B) S1 BEGIN; create_generation_row 또는 각 child INSERT 후 COMMIT 보류
--      S2 admin_soft_delete_account(U)는 대기하고, S1 COMMIT 뒤 manifest/soft-delete를 완료한다.
--      그 뒤 같은 stale request의 추가 INSERT는 account_deleted로 실패해야 한다.
--   C) cleanup job completed 뒤 admin_reactivate_account로 deleted_at=NULL 복원하면
--      세 child INSERT는 다시 성공해야 한다(완료 전 복원은 account_cleanup_pending).
--   D) authenticated display_name UPDATE가 먼저 row lock을 잡으면 탈퇴가 대기하고,
--      양쪽 commit 뒤 최종 display_name은 반드시 '탈퇴한 사용자'여야 한다.
--   E) 탈퇴가 먼저 row lock을 잡으면 stale authenticated UPDATE가 대기한 뒤 0-row로
--      수렴하고, RLS 우회 UPDATE도 trigger의 account_deleted로 실패해야 한다.
-- pgTAP 단일 세션은 아래 B의 직렬화 대기 자체를 만들 수 없으므로, deleted/reactivated 결과 계약과
-- trigger/RPC 존재는 account_deletion_cleanup_saga.pgtap.sql에서 별도로 실행 검증한다.

-- ── 5. fair lease claim (route 즉시 처리 + content-maintain 공용) ────────────
create or replace function public.claim_account_deletion_cleanup(
  p_job_id uuid default null,
  p_lease_seconds int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_deletion_cleanup_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_lease_seconds int :=
    greatest(15, least(coalesce(p_lease_seconds, 120), 600));
begin
  with candidate as (
    select j.id
      from public.account_deletion_cleanup_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and (
         (j.status = 'pending' and j.next_attempt_at <= clock_timestamp())
         or
         (j.status = 'leased' and j.leased_until <= clock_timestamp())
       )
     order by j.next_attempt_at asc, j.created_at asc, j.id asc
     limit 1
     for update skip locked
  )
  update public.account_deletion_cleanup_jobs j
     set status = 'leased',
         lease_token = v_token,
         leased_until = clock_timestamp() + pg_catalog.make_interval(secs => v_lease_seconds),
         attempt_count = j.attempt_count + 1,
         updated_at = clock_timestamp()
    from candidate c
   where j.id = c.id
  returning j.* into v_job;

  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'manifest', v_job.manifest,
    'lease_token', v_job.lease_token,
    'leased_until', v_job.leased_until,
    'attempt_count', v_job.attempt_count
  );
end;
$$;

revoke all on function public.claim_account_deletion_cleanup(uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_account_deletion_cleanup(uuid, int)
  to service_role;

-- ── 6. fenced finish: 성공 scrub/completed, 실패 backoff/pending ─────────────
create or replace function public.finish_account_deletion_cleanup(
  p_job_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_deletion_cleanup_jobs%rowtype;
  v_delay_seconds int;
  v_error text;
begin
  select *
    into v_job
    from public.account_deletion_cleanup_jobs
   where id = p_job_id
     and status = 'leased'
     and lease_token = p_lease_token
     and leased_until > clock_timestamp()
   for update;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  if p_success then
    -- 첫 pass가 성공해도 탈퇴 직전 발급된 signed-upload token은 아직 유효할 수
    -- 있다. horizon까지 active outbox를 유지하고 cron의 prefix 전수 sweep을
    -- 다시 통과한 뒤에만 manifest scrub/completed를 허용한다.
    if clock_timestamp() < v_job.final_sweep_after then
      update public.account_deletion_cleanup_jobs
         set status = 'pending',
             lease_token = null,
             leased_until = null,
             last_error = null,
             next_attempt_at = v_job.final_sweep_after,
             updated_at = clock_timestamp()
       where id = p_job_id;

      return pg_catalog.jsonb_build_object(
        'ok', true,
        'job_id', p_job_id,
        'lease_token', p_lease_token,
        'status', 'pending_final_sweep',
        'final_sweep_after', v_job.final_sweep_after
      );
    end if;

    update public.account_deletion_cleanup_jobs
       set status = 'completed',
           manifest = '{}'::jsonb,
           lease_token = null,
           leased_until = null,
           last_error = null,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = p_job_id;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', p_job_id,
      'lease_token', p_lease_token,
      'status', 'completed'
    );
  end if;

  v_error := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_error), ''), 'cleanup_failed'),
    1000
  );
  -- 30s, 60s, 120s ... 최대 1h. next_attempt_at 우선 정렬이라 due된 오래된 job이 공정하게 선점된다.
  v_delay_seconds := least(
    3600,
    (
      30 * pg_catalog.power(
        2::numeric,
        least(greatest(v_job.attempt_count - 1, 0), 7)
      )
    )::int
  );

  update public.account_deletion_cleanup_jobs
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         last_error = v_error,
         next_attempt_at =
           clock_timestamp() + pg_catalog.make_interval(secs => v_delay_seconds),
         updated_at = clock_timestamp()
   where id = p_job_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', p_job_id,
    'lease_token', p_lease_token,
    'status', 'pending',
    'retry_in_seconds', v_delay_seconds
  );
end;
$$;

revoke all on function public.finish_account_deletion_cleanup(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_account_deletion_cleanup(uuid, uuid, boolean, text)
  to service_role;

-- ── 7. postflight: default-deny table + exact external RPC surface ───────────
do $$
begin
  if (
    select count(*)
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.profiles'::regclass
       and p.polcmd = 'w'
  ) <> 1
     or not exists (
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
     ) then
    raise exception '0072 postflight: active-only profile update policy drift';
  end if;

  if not (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.account_deletion_cleanup_jobs'::regclass
  ) then
    raise exception '0072 postflight: cleanup jobs RLS must be enabled';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_policy
     where polrelid = 'public.account_deletion_cleanup_jobs'::regclass
  ) then
    raise exception '0072 postflight: cleanup jobs must have zero RLS policies';
  end if;

  if has_table_privilege('anon', 'public.account_deletion_cleanup_jobs', 'SELECT')
     or has_table_privilege('authenticated', 'public.account_deletion_cleanup_jobs', 'SELECT')
     or has_table_privilege('service_role', 'public.account_deletion_cleanup_jobs', 'SELECT') then
    raise exception '0072 postflight: cleanup jobs table must be RPC-only';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.admin_soft_delete_account(uuid)',
      'EXECUTE'
    )
     or not has_function_privilege(
       'service_role',
       'public.claim_account_deletion_cleanup(uuid,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.finish_account_deletion_cleanup(uuid,uuid,boolean,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.create_generation_and_consume(uuid,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.create_generation_row(uuid,text)',
       'EXECUTE'
     ) then
    raise exception '0072 postflight: service_role exact RPC grants missing';
  end if;

  if has_function_privilege(
      'anon',
      'public.claim_account_deletion_cleanup(uuid,integer)',
      'EXECUTE'
    )
     or has_function_privilege(
       'authenticated',
       'public.claim_account_deletion_cleanup(uuid,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_account_cleanup_storage_path(text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_owner_insert()',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_score_highlight_insert()',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_reject_reactivation_during_cleanup()',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.bp_reject_deleted_profile_update()',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.bp_reject_deleted_profile_update()',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_profile_update()',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.create_generation_row(uuid,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.create_generation_and_consume(uuid,text)',
       'EXECUTE'
     ) then
    raise exception '0072 postflight: cleanup ACL boundary is open';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.dolls'::regclass
       and tgname = 'trg_dolls_reject_deleted_owner_insert'
       and not tgisinternal
  )
     or not exists (
       select 1
         from pg_catalog.pg_trigger
        where tgrelid = 'public.scores'::regclass
          and tgname = 'trg_scores_reject_deleted_owner_insert'
          and not tgisinternal
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger
        where tgrelid = 'public.score_highlights'::regclass
          and tgname = 'trg_score_highlights_reject_deleted_owner_insert'
          and not tgisinternal
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger
       where tgrelid = 'public.ai_generations'::regclass
          and tgname = 'trg_ai_generations_reject_deleted_owner_insert'
          and not tgisinternal
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger
        where tgrelid = 'public.profiles'::regclass
          and tgname = 'trg_profiles_reject_early_reactivation'
          and not tgisinternal
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger
        where tgrelid = 'public.profiles'::regclass
          and tgname = 'trg_profiles_reject_deleted_display_name_update'
          and tgenabled = 'O'
          and not tgisinternal
     ) then
    raise exception '0072 postflight: account lifecycle trigger missing';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0072_account_deletion_cleanup_saga', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
