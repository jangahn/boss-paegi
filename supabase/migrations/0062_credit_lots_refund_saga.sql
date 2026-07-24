-- 0062: credit_lots 환불 saga — 로트 원장·환불 요청/시도 saga·PG 취소 관측·대사 이슈·shortfall 추적
--       + 레거시 잔액/취소 백필 + 금융 컬럼 RPC-only write 하드닝(additive).
--
-- 적용: management API query 엔드포인트로 파일 전문 실행
--   POST https://api.supabase.com/v1/projects/<ref>/database/query  (Bearer SUPABASE_ACCESS_TOKEN)
--
-- 배경: v0.76 환불 명세 — 크레딧을 "로트(부여 단위)" 로 재모델링하고, 부분·다건 환불을 request→attempt
--   saga 로 원자화한다. 외부 PG 취소는 관측 원장(payment_cancellation_events)으로 화해하고, 소비 후 환불된
--   미회수분은 shortfall 장부로 추적한다. 기존 orders/member_accounts/ai_generations 의 금융 컬럼과 두 원장
--   (credit_ledger·admin_actions_ledger)의 직접 쓰기를 차단하고 전 금융 write 를 SECURITY DEFINER RPC 로 모은다.
--
-- 이 파일은 **additive 단계(0062)** 다(§21): 신규 테이블/컬럼/FK/CHECK/index·신규 RPC/helper·레거시 백필·신규
--   테이블 RPC-only 권한까지 적용하되, **기존 orders/member/ai/원장의 구코드 직접 DML 을 깨는 revoke/stub 은
--   여기 넣지 않는다(그건 0063).** 단 신설 3테이블 확장 컬럼(금융)에 대한 column-level grant 재구성(A.5.2)은
--   additive 안전 범위이므로 포함한다. 적용 시점 전제 = closed gate(신규 money 진입 차단)·open op 0 실측.
--
-- 배포 순서(§44·A.7): P0(pgcrypto 선행) → 본 파일 단일 트랜잭션(S0~S12) → commit → notify pgrst.
--
-- ┌── P0 (이 트랜잭션 **밖**에서 선행 — §12.1) ─────────────────────────────────────────────
-- │  create extension if not exists pgcrypto with schema extensions;
-- │  (orders EXCLUSIVE LOCK 중 CREATE EXTENSION 을 실행하지 않기 위해 0062 본 파일 직전 별도 query 로 실행.
-- │   본 트랜잭션은 preflight P10 에서 extensions 스키마 설치·완전수식 해석 가능을 assert 만 한다.)
-- └────────────────────────────────────────────────────────────────────────────────────────

begin;

-- ── S0. 금융 write 대상 5테이블 명시 순서 잠금(읽기 허용). Phase-A gate·drain 후에도 DB lock 이중 방어. ──
lock table public.orders, public.member_accounts, public.ai_generations,
           public.credit_ledger, public.admin_actions_ledger in exclusive mode;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 공용 helper 함수 (신규 테이블 미참조 — 선행 정의 가능)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- (H1) sha256 hex — pgcrypto extensions.digest 완전수식(§6.2·§10). 입력은 canonical UTF8 텍스트.
create or replace function public.bp_sha256_hex(p_canonical text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to(p_canonical, 'UTF8'), 'sha256'), 'hex');
$$;
revoke all on function public.bp_sha256_hex(text) from public, anon, authenticated, service_role;

-- (H2) canonical JSON 직렬화 — object 키를 바이트순(collate "C")으로 정렬한 compact 직렬화(RFC 8785 유사).
--      Node preflight/RPC 재구현이 같은 규칙(키 정렬·공백 없음)으로 동일 hex 를 만든다(§10 golden 대조).
create or replace function public.bp_canonical_json(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  parts text[] := array[]::text[];
  elem jsonb;
  t text;
begin
  if p is null then
    return 'null';
  end if;
  t := jsonb_typeof(p);
  if t = 'object' then
    for k in select key from jsonb_each(p) order by key collate "C" loop
      parts := parts || (pg_catalog.to_json(k)::text || ':' || public.bp_canonical_json(p -> k));
    end loop;
    return '{' || array_to_string(parts, ',') || '}';
  elsif t = 'array' then
    for elem in select value from jsonb_array_elements(p) loop
      parts := parts || public.bp_canonical_json(elem);
    end loop;
    return '[' || array_to_string(parts, ',') || ']';
  else
    return p::text;   -- scalar(string/number/bool/null): jsonb 정규화 표현을 그대로 사용
  end if;
end;
$$;
revoke all on function public.bp_canonical_json(jsonb) from public, anon, authenticated, service_role;

-- (H3) versioned hash — canonical payload jsonb 에 hash_version 을 포함해 sha256 hex(§10 버전화).
create or replace function public.bp_versioned_hash(p_payload jsonb, p_version int)
returns text
language sql
immutable
set search_path = ''
as $$
  select public.bp_sha256_hex(
    public.bp_canonical_json(p_payload || pg_catalog.jsonb_build_object('hash_version', p_version)));
$$;
revoke all on function public.bp_versioned_hash(jsonb, int) from public, anon, authenticated, service_role;

-- (H4) 재귀 민감 키 검출(§6.3·§11) — object 전 depth·array 전 원소에서 금지 키(정확 소문자 비교) 검출.
create or replace function public.jsonb_has_sensitive_key(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare k text; v jsonb;
begin
  if p is null or jsonb_typeof(p) not in ('object', 'array') then
    return false;
  end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select key, value from jsonb_each(p) loop
      if lower(k) = any (array[
           'card','cardnumber','account','accountnumber','holdername',
           'customer','name','phone','email',
           'ssn','rrn','residentregistrationnumber','jumin','주민등록번호','주민번호']) then
        return true;
      end if;
      if public.jsonb_has_sensitive_key(v) then return true; end if;
    end loop;
  else  -- array
    for v in select value from jsonb_array_elements(p) loop
      if public.jsonb_has_sensitive_key(v) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;
revoke all on function public.jsonb_has_sensitive_key(jsonb) from public, anon, authenticated, service_role;

-- (H5) 원장 2종 공용 append-only 가드(BEFORE UPDATE OR DELETE — 무조건 raise. owner·definer 포함, §5.1).
create or replace function public.ledger_append_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%_append_only_violation', tg_table_name using errcode = 'P0001';
end;
$$;
revoke all on function public.ledger_append_only_guard() from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S1. orders 복합 유니크 — 신규 테이블 복합 소유권 FK 의 전제(반드시 S2 전).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
alter table public.orders add constraint uq_orders_uuid_user unique (order_uuid, user_id);

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S2. 신규 테이블 (FK 의존 순서). 각: DDL + 인덱스 + 감사/guard/nodelete 트리거 + 생성 직후 권한.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.1 credit_lots — 크레딧 로트 원장
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.credit_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  source text not null
    check (source in ('purchase', 'signup_bonus', 'cs_grant', 'legacy_free')),
  order_uuid uuid,
  qty int not null check (qty > 0),
  consumed int not null default 0 check (consumed >= 0),
  refunded int not null default 0 check (refunded >= 0),
  refund_reserved int not null default 0 check (refund_reserved >= 0),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  expired_at timestamptz,
  expiration_reason text
    check (expiration_reason in ('natural', 'account_deleted', 'order_canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint credit_lots_source_order_check
    check ((source = 'purchase') = (order_uuid is not null)),
  constraint credit_lots_counter_sum_check
    check (consumed + refunded + refund_reserved <= qty),
  constraint credit_lots_expiry_order_check
    check (expires_at > granted_at),
  constraint credit_lots_expired_coupling_check
    check ((expired_at is null) = (expiration_reason is null)),
  constraint credit_lots_order_user_fkey
    foreign key (order_uuid, user_id) references public.orders (order_uuid, user_id)
);

comment on table public.credit_lots is
  '크레딧 로트 원장 — 부여 단위별 수량·소비·회수·예약 추적. 쓰기는 SECURITY DEFINER RPC 만.';

alter table public.credit_lots add constraint uq_credit_lots_id_user unique (id, user_id);
alter table public.credit_lots add constraint uq_credit_lots_id_order unique (id, order_uuid);
alter table public.credit_lots add constraint uq_credit_lots_id_order_user unique (id, order_uuid, user_id);

create unique index uq_credit_lots_purchase_order
  on public.credit_lots (order_uuid) where source = 'purchase';
create index idx_credit_lots_user_live
  on public.credit_lots (user_id, granted_at desc) where expired_at is null;
create index idx_credit_lots_expiry
  on public.credit_lots (expires_at) where expired_at is null;
create index idx_credit_lots_user_source
  on public.credit_lots (user_id, source);

drop trigger if exists trg_credit_lots_audit on public.credit_lots;
create trigger trg_credit_lots_audit before update on public.credit_lots
  for each row execute function public.set_updated_at_and_version();

-- 불변·전이 가드
create or replace function public.credit_lots_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- 1. 식별·수량·기간 필드 불변
  if new.id <> old.id or new.user_id <> old.user_id or new.source <> old.source
     or new.order_uuid is distinct from old.order_uuid or new.qty <> old.qty
     or new.granted_at <> old.granted_at or new.expires_at <> old.expires_at
     or new.created_at <> old.created_at then
    raise exception 'credit_lots_immutable_field' using errcode = 'P0001';
  end if;
  -- 2. 만료 필드 set-once
  if old.expired_at is not null
     and (new.expired_at <> old.expired_at
          or new.expiration_reason is distinct from old.expiration_reason) then
    raise exception 'credit_lots_expiry_immutable' using errcode = 'P0001';
  end if;
  if old.expired_at is null and new.expired_at is not null then
    if new.expired_at > clock_timestamp() + interval '5 minutes' then
      raise exception 'credit_lots_expiry_future' using errcode = 'P0001';
    end if;
  end if;
  -- 3. 카운터 허용 전이(범위·합계는 테이블 CHECK 담보)
  if new.refunded < old.refunded then
    raise exception 'credit_lots_refunded_monotonic' using errcode = 'P0001';
  end if;
  if new.refund_reserved < old.refund_reserved then
    -- rr 감소는 두 형태만: ① rr −N 단독(다른 카운터 불변) ② rr −N + refunded +N 동량
    if not (
         (new.consumed = old.consumed and new.refunded = old.refunded)
      or (new.consumed = old.consumed
          and (old.refund_reserved - new.refund_reserved) = (new.refunded - old.refunded))
    ) then
      raise exception 'credit_lots_invalid_counter_transition' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.credit_lots_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_credit_lots_guard on public.credit_lots;
create trigger trg_credit_lots_guard before update on public.credit_lots
  for each row execute function public.credit_lots_guard();

create or replace function public.bp_forbid_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%_delete_forbidden', tg_table_name using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_forbid_delete() from public, anon, authenticated, service_role;

drop trigger if exists trg_credit_lots_nodelete on public.credit_lots;
create trigger trg_credit_lots_nodelete before delete on public.credit_lots
  for each row execute function public.bp_forbid_delete();

alter table public.credit_lots enable row level security;
revoke all on table public.credit_lots from public, anon, authenticated, service_role;
grant select on table public.credit_lots to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.2 refund_requests — 환불 요청(실행 단위·멱등키)
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.refund_requests (
  id uuid primary key,
  user_id uuid not null references public.profiles(id),
  admin_user_id uuid not null references public.profiles(id),
  origin text not null check (origin in ('admin_manual', 'cancel_intent')),
  scope_order_uuid uuid,
  requested_qty int not null check (requested_qty > 0),
  customer_requested_at timestamptz not null,
  reason text not null check (char_length(reason) between 5 and 500),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_hash_version smallint not null default 1,
  approved_plan_hash text check (approved_plan_hash is null or approved_plan_hash ~ '^[0-9a-f]{64}$'),
  approved_plan_hash_version smallint,
  approved_amount bigint check (approved_amount >= 0),
  state text not null default 'building'
    check (state in ('building', 'prepared', 'processing', 'blocked',
                     'completed', 'partial', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint refund_requests_scope_coupling_check
    check ((origin = 'cancel_intent') = (scope_order_uuid is not null)),
  constraint refund_requests_approved_coupling_check
    check ( (state = 'building'
             and approved_plan_hash is null and approved_amount is null)
         or (state <> 'building'
             and approved_plan_hash is not null and approved_amount is not null) ),
  constraint refund_requests_approved_hash_version_check
    check ((approved_plan_hash is null) = (approved_plan_hash_version is null)),
  constraint refund_requests_scope_user_fkey
    foreign key (scope_order_uuid, user_id) references public.orders (order_uuid, user_id)
);

comment on table public.refund_requests is
  '환불 실행 단위 — id=멱등키. 상태는 attempts 집계의 완전 함수(derive_refund_request_state) — deferred constraint trigger 가 tx 종료 시 강제. RPC-only write.';

alter table public.refund_requests add constraint uq_refund_requests_id_user unique (id, user_id);

create unique index uq_refund_requests_intent_active
  on public.refund_requests (scope_order_uuid)
  where origin = 'cancel_intent'
    and state in ('building', 'prepared', 'processing', 'blocked');
create index idx_refund_requests_user_created
  on public.refund_requests (user_id, created_at desc);
create index idx_refund_requests_state
  on public.refund_requests (state, created_at desc)
  where state in ('building', 'prepared', 'processing', 'blocked');

drop trigger if exists trg_refund_requests_audit on public.refund_requests;
create trigger trg_refund_requests_audit before update on public.refund_requests
  for each row execute function public.set_updated_at_and_version();

create or replace function public.refund_requests_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sum_qty int;
  v_sum_amount bigint;
  v_open int;
begin
  -- 1. 불변 필드
  if new.id <> old.id or new.user_id <> old.user_id or new.admin_user_id <> old.admin_user_id
     or new.origin <> old.origin or new.scope_order_uuid is distinct from old.scope_order_uuid
     or new.requested_qty <> old.requested_qty
     or new.customer_requested_at <> old.customer_requested_at
     or new.reason <> old.reason or new.payload_hash <> old.payload_hash
     or new.payload_hash_version <> old.payload_hash_version
     or new.created_at <> old.created_at then
    raise exception 'refund_requests_immutable_field' using errcode = 'P0001';
  end if;
  -- 2. approved_* set-once
  if old.approved_plan_hash is not null
     and (new.approved_plan_hash is distinct from old.approved_plan_hash
          or new.approved_amount is distinct from old.approved_amount
          or new.approved_plan_hash_version is distinct from old.approved_plan_hash_version) then
    raise exception 'refund_requests_approved_immutable' using errcode = 'P0001';
  end if;
  -- 3. building→prepared 전이 검증
  if old.state = 'building' and new.state = 'prepared' then
    select coalesce(sum(qty), 0), coalesce(sum(amount), 0),
           coalesce(sum((state <> 'prepared')::int), 0)
      into v_sum_qty, v_sum_amount, v_open
      from public.order_refund_attempts
     where request_id = new.id;
    if v_sum_qty <> new.requested_qty or v_sum_amount <> new.approved_amount or v_open <> 0 then
      raise exception 'refund_requests_prepare_mismatch' using errcode = 'P0001';
    end if;
  end if;
  -- 4. building 회귀 금지
  if old.state <> 'building' and new.state = 'building' then
    raise exception 'refund_requests_no_rebuild' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.refund_requests_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_refund_requests_guard on public.refund_requests;
create trigger trg_refund_requests_guard before update on public.refund_requests
  for each row execute function public.refund_requests_guard();

drop trigger if exists trg_refund_requests_nodelete on public.refund_requests;
create trigger trg_refund_requests_nodelete before delete on public.refund_requests
  for each row execute function public.bp_forbid_delete();

alter table public.refund_requests enable row level security;
revoke all on table public.refund_requests from public, anon, authenticated, service_role;
grant select on table public.refund_requests to service_role;

-- 상태 산출 정본 함수(§4.10)
--   plpgsql — 본문이 뒤(A.3.3)에서 생성되는 order_refund_attempts 를 참조하므로 language sql 이면
--   생성 시점 참조 검증에 걸린다(파일 내부 순서 유지·첫 실행 시점엔 테이블 존재).
create or replace function public.derive_refund_request_state(p_request_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  return (
    with a as (
      select state, release_reason
        from public.order_refund_attempts
       where request_id = p_request_id
    )
    select case
      when not exists (select 1 from a) then 'building'
      when exists (select 1 from a where state in ('manual_pending','manual_review')) then 'blocked'
      when not exists (select 1 from a where state <> 'committed') then 'completed'
      when not exists (select 1 from a where state <> 'released') then
        case when not exists (select 1 from a where release_reason <> 'admin_cancelled_before_pg')
             then 'cancelled' else 'failed' end
      when not exists (select 1 from a where state not in ('committed','released')) then 'partial'
      when not exists (select 1 from a where state <> 'prepared') then 'prepared'
      else 'processing'
    end
  );
end;
$$;
revoke all on function public.derive_refund_request_state(uuid) from public, anon, authenticated, service_role;

create or replace function public.enforce_request_state_derive()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_state text;
  v_row record;
begin
  -- 주의: 두 테이블(order_refund_attempts·refund_requests)이 같은 함수를 쓰므로 필드 접근을
  -- 문장 단위로 분기한다 — 단일 CASE 식은 파싱 시 양 분기 필드를 모두 해석해
  -- refund_requests 행에서 42703(old.request_id 없음)으로 죽는다(deferred 발화 = 커밋 시점).
  if tg_table_name = 'order_refund_attempts' then
    if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
    v_request_id := v_row.request_id;
  else
    v_row := new;
    v_request_id := v_row.id;
  end if;
  select state into v_state from public.refund_requests where id = v_request_id;
  if v_state is null then
    return null;
  end if;
  if v_state <> public.derive_refund_request_state(v_request_id) then
    raise exception 'refund_request_state_derive_mismatch: request=% stored=% derived=%',
      v_request_id, v_state, public.derive_refund_request_state(v_request_id) using errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke all on function public.enforce_request_state_derive() from public, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.3 order_refund_attempts — 주문×로트 단위 환불 시도
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.order_refund_attempts (
  id uuid primary key,
  request_id uuid not null,
  sequence int not null check (sequence >= 1),
  order_uuid uuid not null,
  user_id uuid not null references public.profiles(id),
  credit_lot_id uuid not null,
  admin_user_id uuid not null references public.profiles(id),
  reason text not null check (char_length(reason) between 5 and 500),
  qty int not null check (qty > 0),
  amount bigint not null check (amount > 0),
  rail text not null check (rail in ('portone_cancel', 'manual_transfer')),
  state text not null default 'prepared'
    check (state in ('prepared', 'pg_requested', 'pg_pending', 'pg_succeeded',
                     'manual_pending', 'manual_review', 'committed', 'released')),
  -- 정책 스냅샷(생성 시 확정·불변)
  rate_bps int not null check (rate_bps in (9000, 10000)),
  policy_as_of timestamptz not null,
  refund_deadline timestamptz not null,
  paid_at_snapshot timestamptz not null,
  order_amount_snapshot bigint not null check (order_amount_snapshot > 0),
  order_credits_snapshot int not null check (order_credits_snapshot > 0),
  expected_refunded_credits_before int not null check (expected_refunded_credits_before >= 0),
  expected_refunded_amount_before bigint not null check (expected_refunded_amount_before >= 0),
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  plan_hash_version smallint not null default 1,
  -- PG preflight 관측(5필드 all-or-none)
  pg_total_before bigint,
  pg_cancelled_before bigint,
  pg_cancellable_before bigint,
  pg_cancellation_ids_before jsonb,
  pg_preflight_at timestamptz,
  -- PG 실행
  pg_idempotency_key text unique,
  pg_requested_at timestamptz,
  pg_request_body jsonb,
  pg_cancel_id text unique,
  pg_cancel_status text,
  pg_raw jsonb,
  cancellation_receipt_url text,
  last_reconciled_at timestamptz,
  -- manual rail
  external_payout_ref text,
  paid_out_at timestamptz,
  payout_evidence jsonb,
  manual_commit_payload_hash text
    check (manual_commit_payload_hash is null or manual_commit_payload_hash ~ '^[0-9a-f]{64}$'),
  manual_commit_payload_hash_version smallint,
  manual_commit_reason text
    check (manual_commit_reason is null or char_length(manual_commit_reason) between 5 and 500),
  -- release
  release_reason text
    check (release_reason in ('admin_cancelled_before_pg', 'replanned_before_pg',
                              'replanned_before_pg_external', 'replanned_after_pg_reconciliation')),
  -- 무이동 확정 증빙
  reconciliation_verified_at timestamptz,
  reconciliation_result text check (reconciliation_result in ('no_movement')),
  observed_cancelled_amount bigint check (observed_cancelled_amount >= 0),
  observed_cancellation_ids jsonb
    check (observed_cancellation_ids is null or jsonb_typeof(observed_cancellation_ids) = 'array'),
  verification_source text
    check (verification_source in ('pg_failed_response', 'admin_reconcile', 'resolver')),
  verified_by uuid references public.profiles(id),
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_hash_version smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  -- external_payout_ref: 명시 named unique + 형식 CHECK(§2.1)
  constraint uq_refund_attempts_external_payout_ref unique (external_payout_ref),
  constraint refund_attempts_external_payout_ref_format_check
    check (external_payout_ref is null
           or external_payout_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  constraint refund_attempts_receipt_url_check
    check (cancellation_receipt_url is null
           or (cancellation_receipt_url ~ '^https://'
               and octet_length(cancellation_receipt_url) <= 2048)),
  constraint refund_attempts_payout_evidence_check
    check ( payout_evidence is null
         or ( jsonb_typeof(payout_evidence) = 'object'
              and payout_evidence ? 'method'
              and jsonb_typeof(payout_evidence->'method') = 'string'
              and payout_evidence->>'method' = 'bank_transfer'
              and payout_evidence - array['method','evidence_object_id'] = '{}'::jsonb
              and payout_evidence ? 'evidence_object_id'
              and jsonb_typeof(payout_evidence->'evidence_object_id') = 'string'
              and (payout_evidence->>'evidence_object_id')
                    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ) ),
  constraint refund_attempts_json_size_check
    check ( (pg_request_body is null or octet_length(pg_request_body::text) <= 32768)
        and (pg_raw is null or octet_length(pg_raw::text) <= 32768)
        and (pg_cancellation_ids_before is null or octet_length(pg_cancellation_ids_before::text) <= 32768)
        and (observed_cancellation_ids is null or octet_length(observed_cancellation_ids::text) <= 32768)
        and (payout_evidence is null or octet_length(payout_evidence::text) <= 32768) ),
  constraint refund_attempts_seq_unique unique (request_id, sequence),
  constraint refund_attempts_request_user_fkey
    foreign key (request_id, user_id) references public.refund_requests (id, user_id),
  constraint refund_attempts_order_user_fkey
    foreign key (order_uuid, user_id) references public.orders (order_uuid, user_id),
  constraint refund_attempts_lot_order_user_fkey
    foreign key (credit_lot_id, order_uuid, user_id)
    references public.credit_lots (id, order_uuid, user_id),
  constraint refund_attempts_release_coupling_check
    check ((state = 'released') = (release_reason is not null)),
  constraint refund_attempts_manual_commit_coupling_check
    check ( ((manual_commit_payload_hash is null) = (manual_commit_reason is null))
        and ((manual_commit_payload_hash is null) = (manual_commit_payload_hash_version is null))
        and (manual_commit_payload_hash is null or rail = 'manual_transfer') ),
  constraint refund_attempts_manual_committed_coupling_check
    check ( not (state = 'committed' and rail = 'manual_transfer')
         or (external_payout_ref is not null and paid_out_at is not null
             and payout_evidence is not null and manual_commit_payload_hash is not null
             and manual_commit_reason is not null) ),
  constraint refund_attempts_evidence_coupling_check
    check ( (reconciliation_verified_at is null and reconciliation_result is null
             and observed_cancelled_amount is null and observed_cancellation_ids is null
             and verification_source is null and verified_by is null and evidence_hash is null)
         or (reconciliation_verified_at is not null and reconciliation_result is not null
             and observed_cancelled_amount is not null and observed_cancellation_ids is not null
             and verification_source is not null and evidence_hash is not null
             and (verified_by is not null or verification_source = 'pg_failed_response')) ),
  constraint refund_attempts_evidence_hash_version_check
    check ((evidence_hash is null) = (evidence_hash_version is null)),
  constraint refund_attempts_preflight_coupling_check
    check ( (pg_total_before is null and pg_cancelled_before is null
             and pg_cancellable_before is null and pg_cancellation_ids_before is null
             and pg_preflight_at is null)
         or (pg_total_before is not null and pg_cancelled_before is not null
             and pg_cancellable_before is not null and pg_cancellation_ids_before is not null
             and pg_preflight_at is not null) ),
  constraint refund_attempts_preflight_range_check
    check ( pg_total_before is null
         or (pg_total_before >= 0 and pg_cancelled_before >= 0 and pg_cancellable_before >= 0
             and pg_cancelled_before + pg_cancellable_before <= pg_total_before) ),
  constraint refund_attempts_preflight_ids_type_check
    check ( pg_cancellation_ids_before is null
         or jsonb_typeof(pg_cancellation_ids_before) = 'array' )
);

comment on table public.order_refund_attempts is
  '환불 시도(주문×로트) — id=PortOne Idempotency-Key(RPC 채번). 전이는 트리거 화이트리스트, 쓰기는 RPC 만.';

alter table public.order_refund_attempts
  add constraint uq_refund_attempts_id_order unique (id, order_uuid);

create unique index uq_refund_attempts_order_open
  on public.order_refund_attempts (order_uuid)
  where state in ('prepared', 'pg_requested', 'pg_pending', 'pg_succeeded',
                  'manual_pending', 'manual_review');
create index idx_refund_attempts_request on public.order_refund_attempts (request_id, sequence);
create index idx_refund_attempts_lot on public.order_refund_attempts (credit_lot_id);
create index idx_refund_attempts_open_scan
  on public.order_refund_attempts (state, last_reconciled_at)
  where state in ('prepared', 'pg_requested', 'pg_pending', 'pg_succeeded',
                  'manual_pending', 'manual_review');

drop trigger if exists trg_refund_attempts_audit on public.order_refund_attempts;
create trigger trg_refund_attempts_audit before update on public.order_refund_attempts
  for each row execute function public.set_updated_at_and_version();

-- INSERT/DELETE 게이트(§4.2)
create or replace function public.refund_attempts_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r public.refund_requests;
  v_maxseq int;
begin
  if tg_op = 'DELETE' then
    select * into r from public.refund_requests where id = old.request_id;
    if r.id is not null and r.state <> 'building' then
      raise exception 'refund_attempts_delete_only_building' using errcode = 'P0001';
    end if;
    return old;
  end if;
  -- INSERT
  select * into r from public.refund_requests where id = new.request_id;
  if r.id is null then
    raise exception 'refund_attempts_request_missing' using errcode = 'P0001';
  end if;
  if r.state <> 'building' then
    raise exception 'refund_attempts_insert_only_building' using errcode = 'P0001';
  end if;
  if new.user_id <> r.user_id then
    raise exception 'refund_attempts_user_mismatch' using errcode = 'P0001';
  end if;
  if new.admin_user_id <> r.admin_user_id then
    raise exception 'refund_attempts_admin_mismatch' using errcode = 'P0001';
  end if;
  if new.reason <> r.reason then
    raise exception 'refund_attempts_reason_mismatch' using errcode = 'P0001';
  end if;
  if r.origin = 'cancel_intent' and new.order_uuid <> r.scope_order_uuid then
    raise exception 'refund_attempts_scope_mismatch' using errcode = 'P0001';
  end if;
  select coalesce(max(sequence), 0) into v_maxseq
    from public.order_refund_attempts where request_id = new.request_id;
  if new.sequence <> v_maxseq + 1 then
    raise exception 'refund_attempts_sequence_gap' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.refund_attempts_lifecycle() from public, anon, authenticated, service_role;

drop trigger if exists trg_refund_attempts_lifecycle on public.order_refund_attempts;
create trigger trg_refund_attempts_lifecycle before insert or delete on public.order_refund_attempts
  for each row execute function public.refund_attempts_lifecycle();

-- 전이 게이트(§7·§8.2·§8.3) — OLD→NEW 조합 검증
create or replace function public.refund_attempts_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pair text;
  v_elem jsonb;
  v_seen text[] := array[]::text[];
  v_sum_qty int;
  v_sum_amt bigint;
begin
  -- 0. 불변 필드
  if new.id <> old.id or new.request_id <> old.request_id or new.sequence <> old.sequence
     or new.order_uuid <> old.order_uuid or new.user_id <> old.user_id
     or new.credit_lot_id <> old.credit_lot_id or new.admin_user_id <> old.admin_user_id
     or new.reason <> old.reason or new.qty <> old.qty or new.amount <> old.amount
     or new.rate_bps <> old.rate_bps or new.policy_as_of <> old.policy_as_of
     or new.refund_deadline <> old.refund_deadline or new.paid_at_snapshot <> old.paid_at_snapshot
     or new.order_amount_snapshot <> old.order_amount_snapshot
     or new.order_credits_snapshot <> old.order_credits_snapshot
     or new.expected_refunded_credits_before <> old.expected_refunded_credits_before
     or new.expected_refunded_amount_before <> old.expected_refunded_amount_before
     or new.plan_hash <> old.plan_hash or new.plan_hash_version <> old.plan_hash_version
     or new.created_at <> old.created_at then
    raise exception 'refund_attempts_immutable_field' using errcode = 'P0001';
  end if;
  -- set-once(null→값 만)
  if (old.pg_total_before is not null and new.pg_total_before is distinct from old.pg_total_before)
     or (old.pg_cancelled_before is not null and new.pg_cancelled_before is distinct from old.pg_cancelled_before)
     or (old.pg_cancellable_before is not null and new.pg_cancellable_before is distinct from old.pg_cancellable_before)
     or (old.pg_cancellation_ids_before is not null and new.pg_cancellation_ids_before is distinct from old.pg_cancellation_ids_before)
     or (old.pg_preflight_at is not null and new.pg_preflight_at is distinct from old.pg_preflight_at)
     or (old.pg_requested_at is not null and new.pg_requested_at is distinct from old.pg_requested_at)
     or (old.pg_request_body is not null and new.pg_request_body is distinct from old.pg_request_body)
     or (old.pg_idempotency_key is not null and new.pg_idempotency_key is distinct from old.pg_idempotency_key)
     or (old.external_payout_ref is not null and new.external_payout_ref is distinct from old.external_payout_ref)
     or (old.paid_out_at is not null and new.paid_out_at is distinct from old.paid_out_at)
     or (old.payout_evidence is not null and new.payout_evidence is distinct from old.payout_evidence)
     or (old.manual_commit_payload_hash is not null and new.manual_commit_payload_hash is distinct from old.manual_commit_payload_hash)
     or (old.manual_commit_reason is not null and new.manual_commit_reason is distinct from old.manual_commit_reason)
     or (old.reconciliation_verified_at is not null and new.reconciliation_verified_at is distinct from old.reconciliation_verified_at)
     or (old.reconciliation_result is not null and new.reconciliation_result is distinct from old.reconciliation_result)
     or (old.observed_cancelled_amount is not null and new.observed_cancelled_amount is distinct from old.observed_cancelled_amount)
     or (old.observed_cancellation_ids is not null and new.observed_cancellation_ids is distinct from old.observed_cancellation_ids)
     or (old.verification_source is not null and new.verification_source is distinct from old.verification_source)
     or (old.verified_by is not null and new.verified_by is distinct from old.verified_by)
     or (old.evidence_hash is not null and new.evidence_hash is distinct from old.evidence_hash) then
    raise exception 'refund_attempts_set_once_violation' using errcode = 'P0001';
  end if;
  -- 0b. PII
  if public.jsonb_has_sensitive_key(new.pg_request_body) or public.jsonb_has_sensitive_key(new.pg_raw)
     or public.jsonb_has_sensitive_key(new.payout_evidence)
     or public.jsonb_has_sensitive_key(new.observed_cancellation_ids)
     or public.jsonb_has_sensitive_key(new.pg_cancellation_ids_before) then
    raise exception 'refund_attempts_pii_in_json' using errcode = 'P0001';
  end if;
  -- 0c. preflight ids 원소 규약(string·len>=1·중복 0)
  if new.pg_cancellation_ids_before is not null then
    for v_elem in select value from jsonb_array_elements(new.pg_cancellation_ids_before) loop
      if jsonb_typeof(v_elem) <> 'string' or char_length(v_elem #>> '{}') < 1
         or (v_elem #>> '{}') = any (v_seen) then
        raise exception 'refund_attempts_preflight_ids_invalid' using errcode = 'P0001';
      end if;
      v_seen := v_seen || (v_elem #>> '{}');
    end loop;
  end if;

  if new.state = old.state then
    return new;   -- 상태 불변 UPDATE(evidence/raw/receipt/last_reconciled 갱신)는 위 검사만
  end if;

  -- 1. 전이 화이트리스트(16종)
  v_pair := old.state || '->' || new.state;
  if v_pair not in (
       'prepared->pg_requested','prepared->manual_pending','prepared->manual_review','prepared->released',
       'pg_requested->pg_pending','pg_requested->pg_succeeded','pg_requested->manual_pending','pg_requested->manual_review',
       'pg_pending->pg_succeeded','pg_pending->manual_pending','pg_pending->manual_review',
       'manual_review->manual_pending','manual_review->pg_requested','manual_review->released',
       'pg_succeeded->committed','manual_pending->committed') then
    raise exception 'refund_attempts_bad_transition: %', v_pair using errcode = 'P0001';
  end if;

  -- 2. released 진입·release_reason 커플링
  if new.state = 'released' then
    if old.state not in ('prepared','manual_review') then
      raise exception 'refund_attempts_bad_release_origin' using errcode = 'P0001';
    end if;
    if new.release_reason = 'admin_cancelled_before_pg' then
      if old.state <> 'prepared' then
        raise exception 'refund_attempts_release_reason_mismatch' using errcode = 'P0001';
      end if;
    elsif new.release_reason in ('replanned_before_pg','replanned_before_pg_external') then
      if not (old.state in ('prepared','manual_review') and old.pg_requested_at is null) then
        raise exception 'refund_attempts_release_reason_mismatch' using errcode = 'P0001';
      end if;
    elsif new.release_reason = 'replanned_after_pg_reconciliation' then
      if not (old.state = 'manual_review' and old.pg_requested_at is not null) then
        raise exception 'refund_attempts_release_reason_mismatch' using errcode = 'P0001';
      end if;
    else
      raise exception 'refund_attempts_release_reason_mismatch' using errcode = 'P0001';
    end if;
  end if;

  -- 3·4. manual_pending 진입(무이동 확정 증빙 존재) — manual_review·pg_requested·pg_pending 발 공통
  if new.state = 'manual_pending' and old.state in ('manual_review','pg_requested','pg_pending') then
    if not (new.reconciliation_verified_at is not null and new.reconciliation_result is not null
            and new.observed_cancelled_amount is not null and new.observed_cancellation_ids is not null
            and new.verification_source is not null and new.evidence_hash is not null
            and (new.verified_by is not null or new.verification_source = 'pg_failed_response')) then
      raise exception 'refund_attempts_manual_needs_evidence' using errcode = 'P0001';
    end if;
  end if;

  -- 5. rail 전이(단방향)
  if new.rail <> old.rail then
    if not (old.rail = 'portone_cancel' and new.rail = 'manual_transfer'
            and new.state = 'manual_pending'
            and old.state in ('prepared','pg_requested','pg_pending','manual_review')) then
      raise exception 'refund_attempts_rail_locked' using errcode = 'P0001';
    end if;
  end if;

  -- 6. manual 확정 5필드 + 시간 상한
  if new.state = 'committed' and new.rail = 'manual_transfer' then
    if new.external_payout_ref is null or new.paid_out_at is null or new.payout_evidence is null
       or new.manual_commit_payload_hash is null or new.manual_commit_reason is null then
      raise exception 'refund_attempts_manual_commit_incomplete' using errcode = 'P0001';
    end if;
    if new.paid_out_at > clock_timestamp() + interval '5 minutes' then
      raise exception 'refund_attempts_paid_out_future' using errcode = 'P0001';
    end if;
  end if;

  -- 7. pg_requested 진입
  if new.state = 'pg_requested' then
    if new.pg_requested_at is null or new.pg_request_body is null or new.pg_idempotency_key is null
       or new.pg_total_before is null or new.pg_cancelled_before is null
       or new.pg_cancellable_before is null or new.pg_cancellation_ids_before is null
       or new.pg_preflight_at is null then
      raise exception 'refund_attempts_pg_request_incomplete' using errcode = 'P0001';
    end if;
  end if;

  -- 8. committed 진입 시 request 누계 재검증
  if new.state = 'committed' then
    select coalesce(sum(qty), 0), coalesce(sum(amount), 0)
      into v_sum_qty, v_sum_amt
      from public.order_refund_attempts
     where request_id = new.request_id and state = 'committed' and id <> new.id;
    v_sum_qty := v_sum_qty + new.qty;
    v_sum_amt := v_sum_amt + new.amount;
    if v_sum_qty > (select requested_qty from public.refund_requests where id = new.request_id)
       or v_sum_amt > coalesce((select approved_amount from public.refund_requests where id = new.request_id), 0) then
      raise exception 'refund_attempts_commit_overrun' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.refund_attempts_transition() from public, anon, authenticated, service_role;

drop trigger if exists trg_refund_attempts_transition on public.order_refund_attempts;
create trigger trg_refund_attempts_transition before update on public.order_refund_attempts
  for each row execute function public.refund_attempts_transition();

alter table public.order_refund_attempts enable row level security;
revoke all on table public.order_refund_attempts from public, anon, authenticated, service_role;
grant select on table public.order_refund_attempts to service_role;

-- DEFERRABLE 종단 불변식 트리거(§4.10) — attempts·requests 변경 시 tx 종료에서 state=derive 강제
create constraint trigger trg_refund_requests_state_derive
  after insert or update or delete on public.order_refund_attempts
  deferrable initially deferred
  for each row execute function public.enforce_request_state_derive();

create constraint trigger trg_refund_requests_state_derive_self
  after update on public.refund_requests
  deferrable initially deferred
  for each row execute function public.enforce_request_state_derive();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- §14 cancellation_resolution_batches — system auto-full 전액 자동 종결 배치(events 보다 먼저 생성)
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.cancellation_resolution_batches (
  id uuid primary key default gen_random_uuid(),
  order_uuid uuid not null references public.orders(order_uuid),
  order_amount_snapshot bigint not null check (order_amount_snapshot > 0),
  order_credits_snapshot int not null check (order_credits_snapshot > 0),
  pre_refunded_amount bigint not null check (pre_refunded_amount >= 0),
  pre_refunded_credits int not null check (pre_refunded_credits >= 0),
  pre_committed_count int not null check (pre_committed_count >= 0),
  pre_legacy_contribution int not null check (pre_legacy_contribution >= 0),
  had_cancel_intent boolean not null,
  total_succeeded_amount bigint not null check (total_succeeded_amount >= 0),
  cancellation_projection jsonb not null,       -- {cancellation_id, amount} 원소의 JSON 배열(allowlist projection)
  eligibility_result text not null check (eligibility_result in ('eligible', 'ineligible')),
  eligibility_hash text not null check (eligibility_hash ~ '^[0-9a-f]{64}$'),
  eligibility_hash_version smallint not null default 1,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint crb_projection_size_check
    check (octet_length(cancellation_projection::text) <= 32768),
  constraint crb_projection_type_check
    check (jsonb_typeof(cancellation_projection) = 'array')
);

comment on table public.cancellation_resolution_batches is
  'system auto-full 전액 자동 종결 배치 — pre-state eligibility 스냅샷·불변. 성공 batch+events 같은 트랜잭션 연결(§14).';

create index idx_crb_order on public.cancellation_resolution_batches (order_uuid, created_at desc);

-- 불변(frozen) + INSERT PII/시간 가드
create or replace function public.crb_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.jsonb_has_sensitive_key(new.cancellation_projection) then
      raise exception 'crb_pii_in_projection' using errcode = 'P0001';
    end if;
    if new.resolved_at is not null and new.resolved_at > clock_timestamp() + interval '5 minutes' then
      raise exception 'crb_resolved_future' using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'crb_immutable' using errcode = 'P0001';   -- UPDATE/DELETE 전면 차단
end;
$$;
revoke all on function public.crb_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_crb_insert_guard on public.cancellation_resolution_batches;
create trigger trg_crb_insert_guard before insert on public.cancellation_resolution_batches
  for each row execute function public.crb_guard();
drop trigger if exists trg_crb_freeze on public.cancellation_resolution_batches;
create trigger trg_crb_freeze before update or delete on public.cancellation_resolution_batches
  for each row execute function public.crb_guard();

alter table public.cancellation_resolution_batches enable row level security;
revoke all on table public.cancellation_resolution_batches from public, anon, authenticated, service_role;
grant select on table public.cancellation_resolution_batches to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.4 payment_cancellation_events — PG 취소 관측 원장
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.payment_cancellation_events (
  cancellation_id text primary key,
  order_uuid uuid not null references public.orders(order_uuid),
  status text not null check (status in ('REQUESTED', 'SUCCEEDED', 'FAILED')),
  amount bigint not null check (amount > 0),
  requested_at timestamptz,
  cancelled_at timestamptz,
  origin text not null default 'live' check (origin in ('live', 'legacy_backfill')),
  matched_attempt_id uuid,
  resolution_state text not null default 'unmatched'
    check (resolution_state in ('matched', 'unmatched', 'resolved', 'ignored')),
  resolution_batch_id uuid references public.cancellation_resolution_batches(id),
  observed_raw jsonb,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_source text check (resolution_source in ('admin', 'system')),
  resolved_economic_qty int check (resolved_economic_qty >= 0),
  resolved_lot_mappings jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint cancellation_events_json_size_check
    check (observed_raw is null or octet_length(observed_raw::text) <= 32768),
  constraint cancellation_events_mappings_size_check
    check (resolved_lot_mappings is null or octet_length(resolved_lot_mappings::text) <= 32768),
  constraint cancellation_events_time_order_check
    check (cancelled_at is null or requested_at is null or cancelled_at >= requested_at),
  constraint cancellation_events_resolved_coupling_check
    check ( (resolution_state in ('resolved', 'ignored'))
            = (resolved_at is not null and resolution_source is not null) ),
  constraint cancellation_events_source_actor_check
    check ( (resolution_source is null and resolved_by is null)
         or (resolution_source = 'admin' and resolved_by is not null)
         or (resolution_source = 'system' and resolved_by is null) ),
  constraint cancellation_events_matched_coupling_check
    check ((resolution_state = 'matched') = (matched_attempt_id is not null)),
  constraint cancellation_events_matched_order_fkey
    foreign key (matched_attempt_id, order_uuid)
    references public.order_refund_attempts (id, order_uuid),
  constraint cancellation_events_economic_coupling_check
    check ((resolution_state = 'resolved') = (resolved_economic_qty is not null)),
  constraint cancellation_events_mappings_presence_check
    check ((resolution_state = 'resolved') = (resolved_lot_mappings is not null)),
  constraint cancellation_events_mappings_array_check
    check (resolved_lot_mappings is null or jsonb_typeof(resolved_lot_mappings) = 'array'),
  constraint cancellation_events_status_resolution_check
    check ( resolution_state = 'unmatched'
         or (resolution_state in ('matched', 'resolved') and status = 'SUCCEEDED')
         or (resolution_state = 'ignored' and status = 'FAILED') ),
  -- §6·§14: batch 는 system 이 확정한 live resolved 에만 부착.
  constraint cancellation_events_batch_coupling_check
    check ( resolution_batch_id is null
         or (resolution_state = 'resolved' and origin = 'live' and resolution_source = 'system') )
);

comment on table public.payment_cancellation_events is
  'PG 취소 관측 원장 — 미인식 status 는 행 삽입 금지(issue/manual_review 에 원문). RPC-only write.';

alter table public.payment_cancellation_events
  add constraint uq_cancellation_events_id_order unique (cancellation_id, order_uuid);

-- 복합 FK ② — attempts.pg_cancel_id 역방향 귀속(events·uq 직후에만 추가 가능)
alter table public.order_refund_attempts
  add constraint refund_attempts_pg_cancel_fkey
  foreign key (pg_cancel_id, order_uuid)
  references public.payment_cancellation_events (cancellation_id, order_uuid);

create unique index uq_cancellation_events_attempt
  on public.payment_cancellation_events (matched_attempt_id)
  where matched_attempt_id is not null;
create index idx_cancellation_events_order
  on public.payment_cancellation_events (order_uuid, status);
create index idx_cancellation_events_unmatched
  on public.payment_cancellation_events (resolution_state, created_at)
  where resolution_state = 'unmatched';

drop trigger if exists trg_cancellation_events_audit on public.payment_cancellation_events;
create trigger trg_cancellation_events_audit before update on public.payment_cancellation_events
  for each row execute function public.set_updated_at_and_version();

create or replace function public.cancellation_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare a public.order_refund_attempts;
begin
  -- 공통: 시간 sanity(D6)
  if new.requested_at is not null and new.requested_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'cancellation_events_future_time' using errcode = 'P0001';
  end if;
  if new.cancelled_at is not null and new.cancelled_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'cancellation_events_future_time' using errcode = 'P0001';
  end if;
  -- 공통: PII
  if public.jsonb_has_sensitive_key(new.observed_raw)
     or public.jsonb_has_sensitive_key(new.resolved_lot_mappings) then
    raise exception 'cancellation_events_pii_in_json' using errcode = 'P0001';
  end if;
  -- 공통: matched 귀속 3등식
  if new.matched_attempt_id is not null then
    select * into a from public.order_refund_attempts where id = new.matched_attempt_id;
    if a.id is null or a.order_uuid <> new.order_uuid or a.amount <> new.amount
       or a.pg_cancel_id is distinct from new.cancellation_id then
      raise exception 'cancellation_events_match_mismatch' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  -- UPDATE
  -- 1. 불변
  if new.cancellation_id <> old.cancellation_id or new.order_uuid <> old.order_uuid
     or new.amount <> old.amount or new.origin <> old.origin or new.created_at <> old.created_at then
    raise exception 'cancellation_events_immutable_field' using errcode = 'P0001';
  end if;
  -- 2. status 단조
  if new.status <> old.status then
    if not (old.status = 'REQUESTED' and new.status in ('SUCCEEDED','FAILED')) then
      raise exception 'cancellation_events_status_locked' using errcode = 'P0001';
    end if;
  end if;
  -- 3. resolution_state 단조
  if new.resolution_state <> old.resolution_state then
    if not (old.resolution_state = 'unmatched'
            and new.resolution_state in ('matched','resolved','ignored')) then
      raise exception 'cancellation_events_resolution_locked' using errcode = 'P0001';
    end if;
  end if;
  -- 4. matched_attempt_id set-once
  if old.matched_attempt_id is not null and new.matched_attempt_id is distinct from old.matched_attempt_id then
    raise exception 'cancellation_events_matched_immutable' using errcode = 'P0001';
  end if;
  -- 5. requested_at·cancelled_at set-once
  if (old.requested_at is not null and new.requested_at is distinct from old.requested_at)
     or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at) then
    raise exception 'cancellation_events_time_immutable' using errcode = 'P0001';
  end if;
  -- 6. resolved_economic_qty·resolved_lot_mappings·resolution_batch_id set-once
  if (old.resolved_economic_qty is not null and new.resolved_economic_qty is distinct from old.resolved_economic_qty)
     or (old.resolved_lot_mappings is not null and new.resolved_lot_mappings is distinct from old.resolved_lot_mappings)
     or (old.resolution_batch_id is not null and new.resolution_batch_id is distinct from old.resolution_batch_id) then
    raise exception 'cancellation_events_resolution_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.cancellation_events_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_cancellation_events_guard on public.payment_cancellation_events;
create trigger trg_cancellation_events_guard before insert or update on public.payment_cancellation_events
  for each row execute function public.cancellation_events_guard();
drop trigger if exists trg_cancellation_events_nodelete on public.payment_cancellation_events;
create trigger trg_cancellation_events_nodelete before delete on public.payment_cancellation_events
  for each row execute function public.bp_forbid_delete();

alter table public.payment_cancellation_events enable row level security;
revoke all on table public.payment_cancellation_events from public, anon, authenticated, service_role;
grant select on table public.payment_cancellation_events to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.5 reconciliation_issues — 대사 이슈 큐
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  type text not null
    check (type in ('economic_over_refund', 'manual_pg_cancel', 'late_paid',
                    'unmatched_cancellation', 'cancellation_discrepancy')),
  order_uuid uuid not null,
  user_id uuid not null references public.profiles(id),
  cancellation_id text,
  detail jsonb,
  state text not null default 'open' check (state in ('open', 'resolved', 'ignored')),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_source text check (resolution_source in ('admin', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint recon_issues_json_size_check
    check (detail is null or octet_length(detail::text) <= 32768),
  constraint recon_issues_state_coupling_check
    check ( (state = 'open' and resolved_at is null and resolved_by is null
             and resolution_source is null)
         or (state in ('resolved', 'ignored') and resolved_at is not null
             and resolution_source is not null) ),
  constraint recon_issues_source_actor_check
    check ( (resolution_source is null and resolved_by is null)
         or (resolution_source = 'admin' and resolved_by is not null)
         or (resolution_source = 'system' and resolved_by is null) ),
  constraint recon_issues_order_user_fkey
    foreign key (order_uuid, user_id) references public.orders (order_uuid, user_id),
  constraint recon_issues_cancellation_order_fkey
    foreign key (cancellation_id, order_uuid)
    references public.payment_cancellation_events (cancellation_id, order_uuid)
);

comment on table public.reconciliation_issues is
  '대사 이슈 — idempotent upsert(open 중복 0). business block 은 RAISE 대신 issue 저장+정상 JSON 반환.';

create unique index uq_recon_issues_open
  on public.reconciliation_issues (type, order_uuid, coalesce(cancellation_id, ''))
  where state = 'open';
create index idx_recon_issues_open_created
  on public.reconciliation_issues (created_at desc) where state = 'open';

drop trigger if exists trg_recon_issues_audit on public.reconciliation_issues;
create trigger trg_recon_issues_audit before update on public.reconciliation_issues
  for each row execute function public.set_updated_at_and_version();

create or replace function public.recon_issues_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.jsonb_has_sensitive_key(new.detail) then
    raise exception 'recon_issues_pii_in_detail' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.id <> old.id or new.type <> old.type or new.order_uuid <> old.order_uuid
     or new.user_id <> old.user_id or new.cancellation_id is distinct from old.cancellation_id
     or new.created_at <> old.created_at then
    raise exception 'recon_issues_immutable_field' using errcode = 'P0001';
  end if;
  if new.state <> old.state and not (old.state = 'open' and new.state in ('resolved','ignored')) then
    raise exception 'recon_issues_state_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.recon_issues_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_recon_issues_guard on public.reconciliation_issues;
create trigger trg_recon_issues_guard before insert or update on public.reconciliation_issues
  for each row execute function public.recon_issues_guard();
drop trigger if exists trg_recon_issues_nodelete on public.reconciliation_issues;
create trigger trg_recon_issues_nodelete before delete on public.reconciliation_issues
  for each row execute function public.bp_forbid_delete();

alter table public.reconciliation_issues enable row level security;
revoke all on table public.reconciliation_issues from public, anon, authenticated, service_role;
grant select on table public.reconciliation_issues to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.6 credit_refund_shortfalls — 미회수 소비분 추적
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.credit_refund_shortfalls (
  id uuid primary key default gen_random_uuid(),
  source_type text not null
    check (source_type in ('external_cancellation', 'policy_cap', 'legacy_backfill')),
  source_attempt_id uuid,
  source_cancellation_id text,
  order_uuid uuid not null references public.orders(order_uuid),
  lot_id uuid not null,
  mapped_qty int not null check (mapped_qty > 0),
  recovered_qty int not null default 0 check (recovered_qty >= 0),
  initial_shortfall_qty int not null check (initial_shortfall_qty >= 0),
  remaining_shortfall_qty int not null,
  state text not null default 'open' check (state in ('open', 'resolved')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint shortfalls_source_xor_check
    check ( (source_type = 'external_cancellation'
             and source_cancellation_id is not null and source_attempt_id is null)
         or (source_type = 'policy_cap'
             and source_attempt_id is not null and source_cancellation_id is null)
         or (source_type = 'legacy_backfill'
             and source_attempt_id is null and source_cancellation_id is null) ),
  constraint shortfalls_qty_range_check
    check (remaining_shortfall_qty >= 0 and remaining_shortfall_qty <= initial_shortfall_qty),
  constraint shortfalls_qty_sum_check
    check (recovered_qty + remaining_shortfall_qty = initial_shortfall_qty),
  constraint shortfalls_initial_le_mapped_check
    check (initial_shortfall_qty <= mapped_qty),
  constraint shortfalls_state_coupling_check
    check ((state = 'resolved') = (remaining_shortfall_qty = 0)),
  constraint shortfalls_resolved_at_check
    check ((state = 'resolved') = (resolved_at is not null)),
  constraint shortfalls_lot_order_fkey
    foreign key (lot_id, order_uuid) references public.credit_lots (id, order_uuid),
  constraint shortfalls_attempt_order_fkey
    foreign key (source_attempt_id, order_uuid)
    references public.order_refund_attempts (id, order_uuid),
  constraint shortfalls_cancellation_order_fkey
    foreign key (source_cancellation_id, order_uuid)
    references public.payment_cancellation_events (cancellation_id, order_uuid)
);

comment on table public.credit_refund_shortfalls is
  '소비 후 환불분 추적 — remaining>0 open 행이 생성 실패 환급 시 oldest-first 흡수. RPC-only write.';

create unique index uq_shortfalls_attempt_lot
  on public.credit_refund_shortfalls (source_attempt_id, lot_id)
  where source_attempt_id is not null;
create unique index uq_shortfalls_cancellation_lot
  on public.credit_refund_shortfalls (source_cancellation_id, lot_id)
  where source_cancellation_id is not null;
create index idx_shortfalls_lot_open
  on public.credit_refund_shortfalls (lot_id, created_at, id) where state = 'open';

drop trigger if exists trg_shortfalls_audit on public.credit_refund_shortfalls;
create trigger trg_shortfalls_audit before update on public.credit_refund_shortfalls
  for each row execute function public.set_updated_at_and_version();

create or replace function public.shortfalls_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.source_type <> old.source_type
     or new.source_attempt_id is distinct from old.source_attempt_id
     or new.source_cancellation_id is distinct from old.source_cancellation_id
     or new.order_uuid <> old.order_uuid or new.lot_id <> old.lot_id
     or new.mapped_qty <> old.mapped_qty or new.initial_shortfall_qty <> old.initial_shortfall_qty
     or new.created_at <> old.created_at then
    raise exception 'shortfalls_immutable_field' using errcode = 'P0001';
  end if;
  if new.recovered_qty < old.recovered_qty then
    raise exception 'shortfalls_recovered_monotonic' using errcode = 'P0001';
  end if;
  if new.remaining_shortfall_qty > old.remaining_shortfall_qty then
    raise exception 'shortfalls_remaining_monotonic' using errcode = 'P0001';
  end if;
  if new.state <> old.state and not (old.state = 'open' and new.state = 'resolved') then
    raise exception 'shortfalls_state_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.shortfalls_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_shortfalls_guard on public.credit_refund_shortfalls;
create trigger trg_shortfalls_guard before update on public.credit_refund_shortfalls
  for each row execute function public.shortfalls_guard();
drop trigger if exists trg_shortfalls_nodelete on public.credit_refund_shortfalls;
create trigger trg_shortfalls_nodelete before delete on public.credit_refund_shortfalls
  for each row execute function public.bp_forbid_delete();

alter table public.credit_refund_shortfalls enable row level security;
revoke all on table public.credit_refund_shortfalls from public, anon, authenticated, service_role;
grant select on table public.credit_refund_shortfalls to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A.3.7 legacy_refund_backfill_evidence — 레거시 백필 증빙(영구·불변)
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.legacy_refund_backfill_evidence (
  id uuid primary key default gen_random_uuid(),
  order_uuid uuid not null references public.orders(order_uuid),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  classification text not null
    check (classification in ('pg_refunded_full', 'pg_refunded_partial', 'local_only_canceled')),
  refunded_amount bigint not null check (refunded_amount >= 0),
  refunded_credits int not null check (refunded_credits >= 0),
  recovered_qty int not null check (recovered_qty >= 0),
  consumed_qty int not null check (consumed_qty >= 0),
  cancellation_evidence jsonb not null,
  ledger_evidence jsonb not null,
  applied_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint legacy_evidence_json_size_check
    check (octet_length(cancellation_evidence::text) <= 32768
       and octet_length(ledger_evidence::text) <= 32768),
  constraint legacy_evidence_qty_sum_check
    check (refunded_credits = recovered_qty + consumed_qty)
);

comment on table public.legacy_refund_backfill_evidence is
  '0062 레거시 백필(canceled 주문 한정)의 영구 증빙 — 불변식 3(경제 수량) 재계산 레거시 소스. 전 행 불변.';

create unique index uq_legacy_evidence_order
  on public.legacy_refund_backfill_evidence (order_uuid);

create or replace function public.legacy_evidence_freeze()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'legacy_evidence_immutable' using errcode = 'P0001';
end;
$$;
revoke all on function public.legacy_evidence_freeze() from public, anon, authenticated, service_role;

drop trigger if exists trg_legacy_evidence_freeze on public.legacy_refund_backfill_evidence;
create trigger trg_legacy_evidence_freeze before update or delete on public.legacy_refund_backfill_evidence
  for each row execute function public.legacy_evidence_freeze();

alter table public.legacy_refund_backfill_evidence enable row level security;
revoke all on table public.legacy_refund_backfill_evidence from public, anon, authenticated, service_role;
grant select on table public.legacy_refund_backfill_evidence to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- §29 ops_cron_heartbeats — cron 실행 심박(credit-expire·reconcile). RPC-only write.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table public.ops_cron_heartbeats (
  job_name text primary key check (job_name in ('credit-expire', 'reconcile')),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error_code text,
  run_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  version int not null default 1
);

comment on table public.ops_cron_heartbeats is
  'cron 실행 심박 — SLA: reconcile 성공 ≤15분·credit-expire 성공 ≤26h(G-47). RPC-only write.';

drop trigger if exists trg_ops_cron_heartbeats_audit on public.ops_cron_heartbeats;
create trigger trg_ops_cron_heartbeats_audit before update on public.ops_cron_heartbeats
  for each row execute function public.set_updated_at_and_version();

alter table public.ops_cron_heartbeats enable row level security;
revoke all on table public.ops_cron_heartbeats from public, anon, authenticated, service_role;
grant select on table public.ops_cron_heartbeats to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S3. 기존 2원장 확장(credit_ledger·admin_actions_ledger) + append-only 가드 + 권한 회수(SELECT-only).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── A.4.3 credit_ledger ──
alter table public.credit_ledger add column if not exists ref_attempt_id uuid
  references public.order_refund_attempts(id);
alter table public.credit_ledger add column if not exists ref_cancellation_id text
  references public.payment_cancellation_events(cancellation_id);
alter table public.credit_ledger add column if not exists ref_lot_id uuid
  references public.credit_lots(id);
alter table public.credit_ledger add column if not exists metadata jsonb;
alter table public.credit_ledger add column if not exists schema_version int not null default 1;

alter table public.credit_ledger add constraint credit_ledger_metadata_size_check
  check (metadata is null or octet_length(metadata::text) <= 32768);

alter table public.credit_ledger drop constraint if exists credit_ledger_event_type_check;
alter table public.credit_ledger add constraint credit_ledger_event_type_check
  check (event_type in ('gen_consume', 'gen_refund', 'purchase',
                        'expire', 'refund_reserve', 'refund_release',
                        'refund_commit', 'refund_policy_close'));

create unique index uq_credit_ledger_attempt_reserve
  on public.credit_ledger (ref_attempt_id) where event_type = 'refund_reserve';
create unique index uq_credit_ledger_attempt_settle
  on public.credit_ledger (ref_attempt_id) where event_type in ('refund_commit', 'refund_release');
create unique index uq_credit_ledger_attempt_policy_close
  on public.credit_ledger (ref_attempt_id) where event_type = 'refund_policy_close';
create unique index uq_credit_ledger_cancellation
  on public.credit_ledger (ref_cancellation_id) where ref_cancellation_id is not null;
create unique index uq_credit_ledger_gen_v2
  on public.credit_ledger (ref_gen_id, event_type) where schema_version = 2;
create unique index uq_credit_ledger_purchase_v2
  on public.credit_ledger (ref_order_uuid) where event_type = 'purchase' and schema_version = 2;
create unique index uq_credit_ledger_lot_expire_v2
  on public.credit_ledger (ref_lot_id) where event_type = 'expire' and schema_version = 2;

drop trigger if exists trg_credit_ledger_freeze on public.credit_ledger;
create trigger trg_credit_ledger_freeze before update or delete on public.credit_ledger
  for each row execute function public.ledger_append_only_guard();

create or replace function public.credit_ledger_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
  v_balance int;
  v_ev public.payment_cancellation_events;
begin
  -- 0. v2 필수
  if new.schema_version <> 2 then
    raise exception 'credit_ledger_v2_only' using errcode = 'P0001';
  end if;
  -- 0b. PII
  if public.jsonb_has_sensitive_key(new.metadata) then
    raise exception 'credit_ledger_pii_in_metadata' using errcode = 'P0001';
  end if;
  -- 1. event 별 ref 배타
  if new.event_type in ('refund_reserve','refund_release','refund_policy_close') then
    if new.ref_attempt_id is null or new.ref_cancellation_id is not null
       or new.ref_lot_id is not null or new.ref_gen_id is not null or new.ref_order_uuid is not null then
      raise exception 'credit_ledger_ref_shape' using errcode = 'P0001';
    end if;
  elsif new.event_type = 'refund_commit' then
    if (new.ref_attempt_id is not null) = (new.ref_cancellation_id is not null)
       or new.ref_lot_id is not null or new.ref_gen_id is not null or new.ref_order_uuid is not null then
      raise exception 'credit_ledger_ref_shape' using errcode = 'P0001';
    end if;
  elsif new.event_type = 'expire' then
    if new.ref_lot_id is null or new.ref_attempt_id is not null or new.ref_cancellation_id is not null
       or new.ref_gen_id is not null or new.ref_order_uuid is not null then
      raise exception 'credit_ledger_ref_shape' using errcode = 'P0001';
    end if;
  elsif new.event_type in ('gen_consume','gen_refund') then
    if new.ref_gen_id is null or new.ref_attempt_id is not null or new.ref_cancellation_id is not null
       or new.ref_lot_id is not null or new.ref_order_uuid is not null then
      raise exception 'credit_ledger_ref_shape' using errcode = 'P0001';
    end if;
  elsif new.event_type = 'purchase' then
    if new.ref_order_uuid is null or new.ref_attempt_id is not null or new.ref_cancellation_id is not null
       or new.ref_lot_id is not null or new.ref_gen_id is not null then
      raise exception 'credit_ledger_ref_shape' using errcode = 'P0001';
    end if;
  end if;
  -- 2. 소유권 일치
  if new.ref_attempt_id is not null then
    select user_id into v_owner from public.order_refund_attempts where id = new.ref_attempt_id;
    if v_owner is distinct from new.user_id then raise exception 'credit_ledger_owner_mismatch' using errcode = 'P0001'; end if;
  end if;
  if new.ref_cancellation_id is not null then
    select ev.* into v_ev from public.payment_cancellation_events ev where ev.cancellation_id = new.ref_cancellation_id;
    select user_id into v_owner from public.orders where order_uuid = v_ev.order_uuid;
    if v_owner is distinct from new.user_id then raise exception 'credit_ledger_owner_mismatch' using errcode = 'P0001'; end if;
  end if;
  if new.ref_lot_id is not null then
    select user_id into v_owner from public.credit_lots where id = new.ref_lot_id;
    if v_owner is distinct from new.user_id then raise exception 'credit_ledger_owner_mismatch' using errcode = 'P0001'; end if;
  end if;
  if new.ref_gen_id is not null then
    select owner_id into v_owner from public.ai_generations where id = new.ref_gen_id;
    if v_owner is not null and v_owner is distinct from new.user_id then raise exception 'credit_ledger_owner_mismatch' using errcode = 'P0001'; end if;
  end if;
  if new.ref_order_uuid is not null then
    select user_id into v_owner from public.orders where order_uuid = new.ref_order_uuid;
    if v_owner is distinct from new.user_id then raise exception 'credit_ledger_owner_mismatch' using errcode = 'P0001'; end if;
  end if;
  -- 3. balance_after not null + = 현재 member 캐시
  if new.balance_after is null then
    raise exception 'credit_ledger_balance_null' using errcode = 'P0001';
  end if;
  select gen_credits into v_balance from public.member_accounts where user_id = new.user_id;
  if v_balance is distinct from new.balance_after then
    raise exception 'credit_ledger_balance_mismatch' using errcode = 'P0001';
  end if;
  -- 4. delta 부호
  if (new.event_type = 'refund_reserve' and new.delta > 0)
     or (new.event_type = 'refund_release' and new.delta < 0)
     or (new.event_type = 'refund_commit' and new.ref_attempt_id is not null and new.delta <> 0)
     or (new.event_type = 'refund_commit' and new.ref_cancellation_id is not null and new.delta > 0)
     or (new.event_type = 'refund_policy_close' and new.delta > 0)
     or (new.event_type = 'expire' and new.delta > 0)
     or (new.event_type = 'purchase' and new.delta < 0)
     or (new.event_type = 'gen_consume' and new.delta > 0)
     or (new.event_type = 'gen_refund' and new.delta < 0) then
    raise exception 'credit_ledger_delta_sign' using errcode = 'P0001';
  end if;
  -- 5. metadata 스키마(policy_close·외부취소형 refund_commit)
  if new.event_type = 'refund_policy_close' then
    if not ( jsonb_typeof(new.metadata) = 'object'
             and (select count(*) from jsonb_object_keys(new.metadata)) = 7
             and new.metadata ?& array['closure_qty','recovered_qty','shortfall_qty','lot_was_live',
                                       'cache_effect_qty','rate_bps','refunded_amount_total']
             and jsonb_typeof(new.metadata->'closure_qty') = 'number'
             and jsonb_typeof(new.metadata->'recovered_qty') = 'number'
             and jsonb_typeof(new.metadata->'shortfall_qty') = 'number'
             and jsonb_typeof(new.metadata->'cache_effect_qty') = 'number'
             and jsonb_typeof(new.metadata->'lot_was_live') = 'boolean'
             and (new.metadata->>'recovered_qty')::int + (new.metadata->>'shortfall_qty')::int
                   <= (new.metadata->>'closure_qty')::int
             and (new.metadata->>'cache_effect_qty')::int
                   = case when (new.metadata->>'lot_was_live')::boolean
                          then (new.metadata->>'recovered_qty')::int else 0 end
             and new.delta = -((new.metadata->>'cache_effect_qty')::int)
             and (new.metadata->>'refunded_amount_total')::numeric >= 0 ) then
      raise exception 'credit_ledger_metadata_invalid' using errcode = 'P0001';
    end if;
  elsif new.event_type = 'refund_commit' and new.ref_cancellation_id is not null then
    if not ( jsonb_typeof(new.metadata) = 'object'
             and (select count(*) from jsonb_object_keys(new.metadata)) = 4
             and new.metadata ?& array['mapped_qty','immediate_recovered_qty','shortfall_qty','live_recovered_qty']
             and jsonb_typeof(new.metadata->'mapped_qty') = 'number'
             and jsonb_typeof(new.metadata->'immediate_recovered_qty') = 'number'
             and jsonb_typeof(new.metadata->'shortfall_qty') = 'number'
             and jsonb_typeof(new.metadata->'live_recovered_qty') = 'number'
             and (new.metadata->>'mapped_qty')::int
                   = (new.metadata->>'immediate_recovered_qty')::int + (new.metadata->>'shortfall_qty')::int
             and (new.metadata->>'live_recovered_qty')::int <= (new.metadata->>'immediate_recovered_qty')::int
             and new.delta = -((new.metadata->>'live_recovered_qty')::int) ) then
      raise exception 'credit_ledger_metadata_invalid' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.credit_ledger_insert_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_credit_ledger_insert_guard on public.credit_ledger;
create trigger trg_credit_ledger_insert_guard before insert on public.credit_ledger
  for each row execute function public.credit_ledger_insert_guard();

-- ── A.4.4 admin_actions_ledger — §2.2 실 컬럼(ref_attempt_id·ref_cancellation_id·payload_hash) ──
alter table public.admin_actions_ledger add column if not exists ref_attempt_id uuid;
alter table public.admin_actions_ledger add column if not exists ref_cancellation_id text;
alter table public.admin_actions_ledger add column if not exists payload_hash text;
alter table public.admin_actions_ledger add column if not exists payload_hash_version smallint;
-- order_amount int → bigint 안전 확장(§2.2)
alter table public.admin_actions_ledger alter column order_amount type bigint;

alter table public.admin_actions_ledger
  add constraint admin_ledger_payload_hash_check
  check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$');

alter table public.admin_actions_ledger drop constraint if exists admin_actions_ledger_action_type_check;
alter table public.admin_actions_ledger add constraint admin_actions_ledger_action_type_check
  check (action_type in ('settle_stuck', 'cancel_refund', 'cs_adjust',
                         'partial_refund', 'refund_release', 'refund_switch_manual',
                         'refund_replan', 'cancel_intent', 'resolve_external_cancellation'));

alter table public.admin_actions_ledger add constraint admin_ledger_metadata_size_check
  check (metadata is null or octet_length(metadata::text) <= 32768);

-- §2.2 복합 소유권 FK — ref_attempt_id/ref_cancellation_id 를 order_uuid 와 함께 참조.
alter table public.admin_actions_ledger
  add constraint admin_ledger_attempt_order_fkey
  foreign key (ref_attempt_id, order_uuid)
  references public.order_refund_attempts (id, order_uuid);
alter table public.admin_actions_ledger
  add constraint admin_ledger_cancellation_order_fkey
  foreign key (ref_cancellation_id, order_uuid)
  references public.payment_cancellation_events (cancellation_id, order_uuid);

-- §3.5 멱등 유니크(실 컬럼)
create unique index uq_admin_ledger_attempt_action
  on public.admin_actions_ledger (action_type, ref_attempt_id)
  where action_type in ('partial_refund', 'refund_release', 'refund_switch_manual', 'refund_replan');
create unique index uq_admin_ledger_resolve_cancellation
  on public.admin_actions_ledger (ref_cancellation_id)
  where action_type = 'resolve_external_cancellation';
create unique index uq_admin_ledger_cancel_intent
  on public.admin_actions_ledger (order_uuid)
  where action_type = 'cancel_intent';

drop trigger if exists trg_admin_ledger_freeze on public.admin_actions_ledger;
create trigger trg_admin_ledger_freeze before update or delete on public.admin_actions_ledger
  for each row execute function public.ledger_append_only_guard();

create or replace function public.admin_ledger_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_admin boolean;
  v_owner uuid;
  a public.order_refund_attempts;
  ev public.payment_cancellation_events;
begin
  -- 0. PII
  if public.jsonb_has_sensitive_key(new.metadata) then
    raise exception 'admin_ledger_pii_in_metadata' using errcode = 'P0001';
  end if;
  -- 1. credit_delta 정합
  if new.credit_delta <> new.after_credits - new.before_credits then
    raise exception 'admin_ledger_delta_mismatch' using errcode = 'P0001';
  end if;
  -- 2. 관리자 실재
  select is_admin into v_is_admin from public.member_accounts where user_id = new.admin_user_id;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_ledger_not_admin' using errcode = 'P0001';
  end if;
  -- 3. order 소유권
  if new.order_uuid is not null then
    select user_id into v_owner from public.orders where order_uuid = new.order_uuid;
    if v_owner is distinct from new.target_user_id then
      raise exception 'admin_ledger_order_owner_mismatch' using errcode = 'P0001';
    end if;
  end if;
  -- 4. action 별 필수 ref·소유권·metadata
  if new.action_type in ('partial_refund','refund_release','refund_switch_manual','refund_replan') then
    if new.ref_attempt_id is null then
      raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
    end if;
    select * into a from public.order_refund_attempts where id = new.ref_attempt_id;
    if a.id is null or a.order_uuid is distinct from new.order_uuid
       or a.user_id is distinct from new.target_user_id then
      raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
    end if;
    -- §3.1·§3.3: partial_refund(manual rail)만 external_payout_ref 필수. switch 는 미지급이라 불요.
    if new.action_type = 'partial_refund' and new.metadata->>'rail' = 'manual_transfer' then
      if coalesce(new.metadata->>'external_payout_ref', '') !~ '^[A-Za-z0-9._:-]{1,128}$' then
        raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
      end if;
    end if;
    if new.action_type = 'refund_replan'
       and coalesce(new.metadata->>'phase', '') not in ('pre_pg', 'post_pg') then
      raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
    end if;
  elsif new.action_type = 'resolve_external_cancellation' then
    if new.ref_cancellation_id is null then
      raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
    end if;
    select * into ev from public.payment_cancellation_events where cancellation_id = new.ref_cancellation_id;
    if ev.cancellation_id is null or ev.order_uuid is distinct from new.order_uuid then
      raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
    end if;
  elsif new.action_type = 'cancel_intent' then
    if new.order_uuid is null or new.ref_attempt_id is not null or new.ref_cancellation_id is not null
       or new.metadata->>'customer_requested_at' is null
       or new.metadata->>'cancel_intent_created_at' is null then
      raise exception 'admin_ledger_action_metadata_invalid' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.admin_ledger_insert_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_admin_ledger_insert_guard on public.admin_actions_ledger;
create trigger trg_admin_ledger_insert_guard before insert on public.admin_actions_ledger
  for each row execute function public.admin_ledger_insert_guard();

-- ── 기존 2원장 grant 회수 → SELECT-only(0020·0047 의 grant all 회수, §5.1) ──
revoke all on table public.credit_ledger from public, anon, authenticated, service_role;
grant select on table public.credit_ledger to service_role;
revoke all on table public.admin_actions_ledger from public, anon, authenticated, service_role;
grant select on table public.admin_actions_ledger to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S4. ① 잔액 백필 — 현 캐시(member_accounts.gen_credits)를 legacy_free 로트로 1:1 캡처.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  m record;
  v_members int := 0; v_credits int := 0;
begin
  for m in
    select ma.user_id, ma.gen_credits, ma.member_since
      from public.member_accounts ma
     where ma.gen_credits > 0
     order by ma.user_id
     for update
  loop
    insert into public.credit_lots (user_id, source, order_uuid, qty, granted_at, expires_at)
    values (m.user_id, 'legacy_free', null, m.gen_credits, m.member_since,
            greatest(m.member_since + interval '1 year', timestamptz '2027-06-26 00:00:00+09'));
    v_members := v_members + 1; v_credits := v_credits + m.gen_credits;
  end loop;
  raise notice 'legacy_free backfill: % members, % credits', v_members, v_credits;
end $$;

do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.member_accounts ma
    left join (
      select user_id, sum(qty - consumed - refunded - refund_reserved) as remain
        from public.credit_lots where expired_at is null group by user_id
    ) l on l.user_id = ma.user_id
   where ma.gen_credits <> coalesce(l.remain, 0);
  if v_bad > 0 then
    raise exception 'backfill_balance_mismatch: % members', v_bad using errcode = 'P0001';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S5. ② 컬럼 추가 — orders 금융/취소 컬럼·범위/커플링 CHECK·strict CHECK(NOT VALID) + ai_generations 확장.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── orders 컬럼(A.4.1(b)) ──
alter table public.orders add column if not exists refunded_credits int not null default 0;
alter table public.orders add column if not exists refunded_amount bigint not null default 0;
alter table public.orders add column if not exists receipt_url text;
alter table public.orders add column if not exists cancel_requested_at timestamptz;
alter table public.orders add column if not exists cancel_requested_by uuid references public.profiles(id);
alter table public.orders add column if not exists cancel_intent_created_at timestamptz;
alter table public.orders add column if not exists cancel_intent_reason text;

alter table public.orders add constraint orders_refunded_credits_range_check
  check (refunded_credits >= 0 and refunded_credits <= credits);
alter table public.orders add constraint orders_refunded_amount_range_check
  check (refunded_amount >= 0 and refunded_amount <= amount);
alter table public.orders add constraint orders_cancel_intent_coupling_check
  check ( (cancel_requested_at is null and cancel_requested_by is null
           and cancel_intent_created_at is null and cancel_intent_reason is null)
       or (cancel_requested_at is not null and cancel_requested_by is not null
           and cancel_intent_created_at is not null and cancel_intent_reason is not null) );
alter table public.orders add constraint orders_cancel_intent_reason_len_check
  check (cancel_intent_reason is null or char_length(cancel_intent_reason) between 5 and 500);
alter table public.orders add constraint orders_receipt_url_check
  check (receipt_url is null or (receipt_url ~ '^https://' and octet_length(receipt_url) <= 2048));

-- strict CHECK — NOT VALID 로만(S9 에서 VALIDATE)
alter table public.orders add constraint orders_canceled_paid_refunded_check
  check (status <> 'canceled' or paid_at is null
         or (refunded_amount = amount and refunded_credits = credits)) not valid;

-- idx_orders_refund_state predicate 수정(0022 predicate 의 'payapp_done' → 'pg_done' 사망 해소)
drop index if exists public.idx_orders_refund_state;
create index idx_orders_refund_state
  on public.orders (refund_state, updated_at)
  where refund_state in ('in_progress', 'pg_done');

-- refund_state legacy 화 — 값 CHECK 제거·주석
alter table public.orders drop constraint if exists orders_refund_state_check;
comment on column public.orders.refund_state is
  'legacy — 구 환불 모델(in_progress/pg_done/done CAS) 폐지(0062). 과거 데이터 보존용 잔존, 신규 쓰기 금지. 상태 정본은 refund_requests/order_refund_attempts.';

-- orders INSERT 게이트(§13 — pending/zero-financial 만)
create or replace function public.orders_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'pending' then
    raise exception 'orders_insert_must_be_pending' using errcode = 'P0001';
  end if;
  if new.paid_at is not null or new.canceled_at is not null then
    raise exception 'orders_insert_no_financial_time' using errcode = 'P0001';
  end if;
  if new.refunded_credits <> 0 or new.refunded_amount <> 0 then
    raise exception 'orders_insert_no_refund' using errcode = 'P0001';
  end if;
  if new.receipt_url is not null then
    raise exception 'orders_insert_no_receipt' using errcode = 'P0001';
  end if;
  if new.cancel_requested_at is not null or new.cancel_requested_by is not null
     or new.cancel_intent_created_at is not null or new.cancel_intent_reason is not null then
    raise exception 'orders_insert_no_cancel_intent' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.orders_insert_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_orders_insert_guard on public.orders;
create trigger trg_orders_insert_guard before insert on public.orders
  for each row execute function public.orders_insert_guard();

-- ── ai_generations 확장(A.4.2) ──
alter table public.ai_generations add column if not exists credit_lot_id uuid;
alter table public.ai_generations add column if not exists consumed_at timestamptz;
alter table public.ai_generations add column if not exists refunded_at timestamptz;

alter table public.ai_generations add constraint ai_generations_lot_owner_fkey
  foreign key (credit_lot_id, owner_id) references public.credit_lots (id, user_id);
alter table public.ai_generations add constraint ai_generations_lot_consume_check
  check ((credit_lot_id is null) = (consumed_at is null));
alter table public.ai_generations add constraint ai_generations_refund_needs_consume_check
  check (refunded_at is null or consumed_at is not null);
alter table public.ai_generations add constraint ai_generations_refund_time_order_check
  check (refunded_at is null or refunded_at >= consumed_at);
alter table public.ai_generations add constraint ai_generations_refund_failed_only_check
  check (refunded_at is null or status = 'failed');

create index if not exists idx_ai_generations_refund_pending
  on public.ai_generations (created_at)
  where status = 'failed' and credit_lot_id is not null and refunded_at is null;

-- §20 금융 이력 보존: profiles hard-delete 방어심화 — member_accounts.user_id·ai_generations.owner_id
-- 의 profiles(id) FK 를 cascade→restrict 로 전환(soft-delete 만 정상 경로; 앵커 FK orders·credit_lots
-- 는 이미 restrict, 이 둘은 방어심화). 기존 제약명(PostgreSQL 관용 <table>_<col>_fkey)을 drop 후 restrict 재생성.
alter table public.member_accounts drop constraint if exists member_accounts_user_id_fkey;
alter table public.member_accounts add constraint member_accounts_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete restrict;
alter table public.ai_generations drop constraint if exists ai_generations_owner_id_fkey;
alter table public.ai_generations add constraint ai_generations_owner_id_fkey
  foreign key (owner_id) references public.profiles (id) on delete restrict;

-- 멱등 재확인(§36 — updated_at·version·감사 트리거는 0007 기존): add column if not exists·drop if exists
alter table public.ai_generations add column if not exists updated_at timestamptz not null default now();
alter table public.ai_generations add column if not exists version int not null default 1;
drop trigger if exists trg_ai_generations_audit on public.ai_generations;
create trigger trg_ai_generations_audit before update on public.ai_generations
  for each row execute function public.set_updated_at_and_version();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S6. ③ manifest 임시 테이블(header §25 + detail) + preflight(A.8 — 실패 시 전체 롤백).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
create temp table refund_backfill_manifest_header (
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  row_count int not null check (row_count >= 0),
  generated_at timestamptz not null,
  source_env text not null,
  script_version text not null
) on commit drop;

create temp table refund_backfill_manifest (
  order_uuid uuid primary key,
  manifest_hash text not null,
  classification text not null
    check (classification in ('pg_refunded_full', 'pg_refunded_partial', 'local_only_canceled')),
  refunded_amount bigint not null check (refunded_amount >= 0),
  refunded_credits int not null check (refunded_credits >= 0),
  recovered_qty int not null check (recovered_qty >= 0),
  consumed_qty int not null check (consumed_qty >= 0),
  cancellations jsonb not null,
  ledger_evidence jsonb not null
) on commit drop;

-- ┌─────────────────────────────────────────────────────────────────────────────────────────┐
-- │ >>> Node preflight 주입점 <<<                                                              │
-- │   0062 적용 직전 scripts/refund/paid-credit-allocation-manifest.mjs 가 DB status='canceled'│
-- │   주문 전수로 (1) refund_backfill_manifest_header 1행 (2) refund_backfill_manifest 0+행의   │
-- │   리터럴 insert 문을 이 위치에 주입한다(§24·§25). 분류 불명확 canceled-paid 1건이라도 있으면 │
-- │   스크립트가 파일 생성을 거부한다.                                                          │
-- └─────────────────────────────────────────────────────────────────────────────────────────┘

-- 실행 가능 기본값(Node 미주입 시): empty manifest header 1행(§25 — 0-row detail 도 header 유효).
insert into refund_backfill_manifest_header (manifest_hash, row_count, generated_at, source_env, script_version)
select public.bp_sha256_hex('boss-paegi:refund_backfill_manifest:v1:empty'), 0, now(), 'unset', 'inline-default'
 where not exists (select 1 from refund_backfill_manifest_header);

do $$
declare v int; v_hdr int; v_rowcount int; v_hdr_hash text;
begin
  -- P0. header 정확히 1행·row_count=detail count·detail hash 단일(§25 empty 지원).
  select count(*) into v_hdr from refund_backfill_manifest_header;
  if v_hdr <> 1 then raise exception 'preflight_P0_header_not_single: %', v_hdr using errcode = 'P0001'; end if;
  select row_count, manifest_hash into v_rowcount, v_hdr_hash from refund_backfill_manifest_header;
  if v_rowcount <> (select count(*) from refund_backfill_manifest) then
    raise exception 'preflight_P0_header_rowcount_mismatch' using errcode = 'P0001';
  end if;
  if exists (select 1 from refund_backfill_manifest) then
    select count(distinct manifest_hash) into v from refund_backfill_manifest;
    if v <> 1 then raise exception 'preflight_P2_hash_not_single: %', v using errcode = 'P0001'; end if;
    if exists (select 1 from refund_backfill_manifest where manifest_hash <> v_hdr_hash) then
      raise exception 'preflight_P2_detail_header_hash_mismatch' using errcode = 'P0001';
    end if;
  end if;

  -- P1. universe=canceled 만 — 양방향 exact equality.
  select count(*) into v
    from public.orders o
   where o.status = 'canceled'
     and not exists (select 1 from refund_backfill_manifest m where m.order_uuid = o.order_uuid);
  if v > 0 then raise exception 'preflight_P1_missing_manifest_rows: %', v using errcode = 'P0001'; end if;
  select count(*) into v
    from refund_backfill_manifest m
   where not exists (select 1 from public.orders o
                      where o.order_uuid = m.order_uuid and o.status = 'canceled');
  if v > 0 then raise exception 'preflight_P1_orphan_manifest_rows: %', v using errcode = 'P0001'; end if;

  -- P3. 분류 명확성.
  select count(*) into v
    from refund_backfill_manifest m
    join public.orders o on o.order_uuid = m.order_uuid
   where (o.paid_at is not null and m.classification <> 'pg_refunded_full')
      or (o.paid_at is null    and m.classification <> 'local_only_canceled');
  if v > 0 then raise exception 'preflight_P3_unclear_classification: %', v using errcode = 'P0001'; end if;

  -- P4. 상한.
  select count(*) into v
    from refund_backfill_manifest m
    join public.orders o on o.order_uuid = m.order_uuid
   where m.refunded_amount > o.amount or m.refunded_credits > o.credits;
  if v > 0 then raise exception 'preflight_P4_over_cap: %', v using errcode = 'P0001'; end if;

  -- P5. 경제 수량 = 실회수 + 소비.
  select count(*) into v
    from refund_backfill_manifest m
    join public.orders o on o.order_uuid = m.order_uuid
   where (m.refunded_credits <> m.recovered_qty + m.consumed_qty)
      or (m.classification = 'pg_refunded_full'
          and (m.refunded_amount <> o.amount or m.refunded_credits <> o.credits))
      or (m.classification = 'local_only_canceled'
          and (m.refunded_amount <> 0 or m.refunded_credits <> 0
               or m.recovered_qty <> 0 or m.consumed_qty <> 0));
  if v > 0 then raise exception 'preflight_P5_economy_mismatch: %', v using errcode = 'P0001'; end if;

  -- P6. 중복 집계 0.
  select count(*) into v
    from public.payment_cancellation_events ev
    join refund_backfill_manifest m on m.order_uuid = ev.order_uuid
   where ev.origin = 'live';
  if v > 0 then raise exception 'preflight_P6_live_event_overlap: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.legacy_refund_backfill_evidence e
   where exists (select 1 from refund_backfill_manifest m where m.order_uuid = e.order_uuid);
  if v > 0 then raise exception 'preflight_P6_evidence_exists: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.credit_lots l
   where l.source = 'purchase'
     and exists (select 1 from refund_backfill_manifest m where m.order_uuid = l.order_uuid);
  if v > 0 then raise exception 'preflight_P6_lot_exists: %', v using errcode = 'P0001'; end if;

  -- P7. §12.5 유료 재구성 가드.
  select count(*) into v
    from public.orders o
    join refund_backfill_manifest m on m.order_uuid = o.order_uuid
   where o.status <> 'canceled';
  if v > 0 then raise exception 'preflight_P7_noncanceled_in_manifest: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.credit_lots where source = 'purchase';
  if v > 0 then raise exception 'preflight_P7_premature_purchase_lot: %', v using errcode = 'P0001'; end if;

  -- P8. cancellation 원소 정합.
  select count(*) into v
    from refund_backfill_manifest m
   cross join lateral jsonb_array_elements(m.cancellations) c
   where c->>'cancellation_id' is null
      or c->>'status' not in ('SUCCEEDED', 'FAILED')
      or coalesce((c->>'amount')::bigint, 0) <= 0;
  if v > 0 then raise exception 'preflight_P8_bad_cancellation_rows: %', v using errcode = 'P0001'; end if;
  select count(*) into v from (
    select c->>'cancellation_id' cid
      from refund_backfill_manifest m cross join lateral jsonb_array_elements(m.cancellations) c
     group by c->>'cancellation_id' having count(*) > 1) q;
  if v > 0 then raise exception 'preflight_P8_manifest_cancellation_dup: %', v using errcode = 'P0001'; end if;
  select count(*) into v from (
    select c->>'cancellation_id' cid
      from refund_backfill_manifest m cross join lateral jsonb_array_elements(m.cancellations) c
     group by c->>'cancellation_id' having count(distinct m.order_uuid) > 1) q;
  if v > 0 then raise exception 'preflight_P8_cancellation_multi_order: %', v using errcode = 'P0001'; end if;
  select count(*) into v
    from refund_backfill_manifest m cross join lateral jsonb_array_elements(m.cancellations) c
   where exists (select 1 from public.payment_cancellation_events ev
                  where ev.cancellation_id = c->>'cancellation_id');
  if v > 0 then raise exception 'preflight_P8_cancellation_db_conflict: %', v using errcode = 'P0001'; end if;

  -- P9. SUCCEEDED 취소 누계 = 확인된 현금 환불액.
  select count(*) into v
    from refund_backfill_manifest m
   where m.classification <> 'local_only_canceled'
     and m.refunded_amount <> coalesce((
          select sum((c->>'amount')::bigint)
            from jsonb_array_elements(m.cancellations) c
           where c->>'status' = 'SUCCEEDED'), 0);
  if v > 0 then raise exception 'preflight_P9_pg_amount_mismatch: %', v using errcode = 'P0001'; end if;

  -- P10. pgcrypto assert(§12.1 — 설치는 P0 트랜잭션 밖 선행).
  select count(*) into v
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto' and n.nspname = 'extensions';
  if v <> 1 then raise exception 'preflight_P10_pgcrypto_schema' using errcode = 'P0001'; end if;
  perform pg_catalog.encode(extensions.digest('preflight', 'sha256'), 'hex');

  -- P11. evidence allowlist·크기·PII.
  select count(*) into v
    from refund_backfill_manifest m
   where octet_length(m.cancellations::text) > 32768
      or octet_length(m.ledger_evidence::text) > 32768
      or public.jsonb_has_sensitive_key(m.cancellations)
      or public.jsonb_has_sensitive_key(m.ledger_evidence);
  if v > 0 then raise exception 'preflight_P11_evidence_shape: %', v using errcode = 'P0001'; end if;

  raise notice 'preflight OK: % manifest rows', (select count(*) from refund_backfill_manifest);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S7. ④ canceled-paid 백필 (금융 트리거 미생성 상태 — S10 이 이 뒤).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
update public.orders o
   set refunded_amount  = m.refunded_amount,
       refunded_credits = m.refunded_credits
  from refund_backfill_manifest m
 where m.order_uuid = o.order_uuid;

insert into public.credit_lots
  (user_id, source, order_uuid, qty, consumed, refunded, refund_reserved,
   granted_at, expires_at, expired_at, expiration_reason)
select o.user_id, 'purchase', o.order_uuid, o.credits,
       m.consumed_qty, m.recovered_qty, 0,
       o.paid_at, o.paid_at + interval '1 year',
       coalesce(o.canceled_at, o.updated_at), 'order_canceled'
  from refund_backfill_manifest m
  join public.orders o on o.order_uuid = m.order_uuid
 where o.paid_at is not null;

insert into public.payment_cancellation_events
  (cancellation_id, order_uuid, status, amount, requested_at, cancelled_at,
   origin, resolution_state, resolved_at, resolution_source,
   resolved_economic_qty, resolved_lot_mappings, observed_raw)
select c->>'cancellation_id', m.order_uuid, c->>'status', (c->>'amount')::bigint,
       nullif(c->>'requested_at', '')::timestamptz, nullif(c->>'cancelled_at', '')::timestamptz,
       'legacy_backfill',
       case c->>'status' when 'SUCCEEDED' then 'resolved' else 'ignored' end,
       now(), 'system',
       case c->>'status' when 'SUCCEEDED' then 0 end,
       case c->>'status' when 'SUCCEEDED' then '[]'::jsonb end,
       c
  from refund_backfill_manifest m
 cross join lateral jsonb_array_elements(m.cancellations) c;

insert into public.credit_refund_shortfalls
  (source_type, source_attempt_id, source_cancellation_id, order_uuid, lot_id,
   mapped_qty, recovered_qty, initial_shortfall_qty, remaining_shortfall_qty,
   state, resolved_at)
select 'legacy_backfill', null, null, m.order_uuid, l.id,
       m.consumed_qty, m.consumed_qty, m.consumed_qty, 0,
       'resolved', now()
  from refund_backfill_manifest m
  join public.credit_lots l on l.order_uuid = m.order_uuid and l.source = 'purchase'
 where m.classification = 'pg_refunded_full' and m.consumed_qty > 0;

insert into public.legacy_refund_backfill_evidence
  (order_uuid, manifest_hash, classification, refunded_amount, refunded_credits,
   recovered_qty, consumed_qty, cancellation_evidence, ledger_evidence)
select m.order_uuid, m.manifest_hash, m.classification, m.refunded_amount,
       m.refunded_credits, m.recovered_qty, m.consumed_qty, m.cancellations, m.ledger_evidence
  from refund_backfill_manifest m;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S8. ⑤ 백필 검증 (VALIDATE 직전).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
do $$
declare v int;
begin
  select count(*) into v
    from public.orders o
   where o.status = 'canceled' and o.paid_at is not null
     and (o.refunded_amount <> o.amount or o.refunded_credits <> o.credits);
  if v > 0 then raise exception 'postbackfill_V1_strict_check_would_fail: %', v using errcode = 'P0001'; end if;

  select count(*) into v
    from public.orders o
   where o.status = 'canceled' and o.paid_at is not null
     and (select count(*) from public.legacy_refund_backfill_evidence e
           where e.order_uuid = o.order_uuid) <> 1;
  if v > 0 then raise exception 'postbackfill_V2_evidence_count: %', v using errcode = 'P0001'; end if;
  select count(*) into v
    from public.orders o
   where o.status = 'canceled' and o.paid_at is not null and o.refunded_credits <> o.credits;
  if v > 0 then raise exception 'postbackfill_V2_credits_not_closed: %', v using errcode = 'P0001'; end if;

  select count(*) into v
    from public.orders o
    left join public.credit_lots l on l.order_uuid = o.order_uuid and l.source = 'purchase'
   where o.status = 'canceled' and o.paid_at is not null
     and (l.id is null or l.expired_at is null or l.expiration_reason <> 'order_canceled'
          or l.consumed + l.refunded <> l.qty or l.refund_reserved <> 0);
  if v > 0 then raise exception 'postbackfill_V3_lot_mismatch: %', v using errcode = 'P0001'; end if;

  select count(*) into v
    from public.credit_lots l
    join public.orders o on o.order_uuid = l.order_uuid
   where o.paid_at is null;
  if v > 0 then raise exception 'postbackfill_V4_lot_without_payment: %', v using errcode = 'P0001'; end if;

  select count(*) into v
    from public.member_accounts ma
    left join (select user_id, sum(qty - consumed - refunded - refund_reserved) as remain
                 from public.credit_lots where expired_at is null group by user_id) l
      on l.user_id = ma.user_id
   where ma.gen_credits <> coalesce(l.remain, 0);
  if v > 0 then raise exception 'postbackfill_V5_balance_drift: %', v using errcode = 'P0001'; end if;

  select count(*) into v
    from public.credit_refund_shortfalls s
    join public.credit_lots l on l.id = s.lot_id
   where s.source_type = 'legacy_backfill'
     and (s.state <> 'resolved' or s.remaining_shortfall_qty <> 0
          or s.initial_shortfall_qty <> l.consumed);
  if v > 0 then raise exception 'postbackfill_V6_shortfall_mismatch: %', v using errcode = 'P0001'; end if;

  select count(*) into v
    from public.credit_lots l
    join public.orders o on o.order_uuid = l.order_uuid
   where l.source = 'purchase' and o.status <> 'canceled';
  if v > 0 then raise exception 'postbackfill_V7_noncanceled_purchase_lot: %', v using errcode = 'P0001'; end if;

  raise notice 'post-backfill checks OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S9. ⑥ strict CHECK VALIDATE.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
alter table public.orders validate constraint orders_canceled_paid_refunded_check;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S10. ⑦ orders 금융 스냅샷 트리거 활성화(백필 UPDATE 종료 후).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.orders_financial_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.paid_at is null then
    return new;   -- paid 전 행은 기존 RPC 흐름 유지
  end if;
  -- 1. 결제 확정 후 불변 필드
  if new.order_uuid <> old.order_uuid or new.user_id <> old.user_id
     or new.amount <> old.amount or new.credits <> old.credits
     or new.product_id <> old.product_id or new.provider <> old.provider
     or new.payment_id is distinct from old.payment_id or new.pg_tx_id is distinct from old.pg_tx_id
     or new.paid_at is distinct from old.paid_at or new.is_test <> old.is_test
     or new.pay_channel is distinct from old.pay_channel then
    raise exception 'orders_financial_immutable' using errcode = 'P0001';
  end if;
  -- 2. refunded_* 단조 증가
  if new.refunded_credits < old.refunded_credits or new.refunded_amount < old.refunded_amount then
    raise exception 'orders_refunded_monotonic' using errcode = 'P0001';
  end if;
  -- 4. cancel intent 4필드 set-once
  if (old.cancel_requested_at is not null and new.cancel_requested_at is distinct from old.cancel_requested_at)
     or (old.cancel_requested_by is not null and new.cancel_requested_by is distinct from old.cancel_requested_by)
     or (old.cancel_intent_created_at is not null and new.cancel_intent_created_at is distinct from old.cancel_intent_created_at)
     or (old.cancel_intent_reason is not null and new.cancel_intent_reason is distinct from old.cancel_intent_reason) then
    raise exception 'orders_cancel_intent_immutable' using errcode = 'P0001';
  end if;
  -- 5. receipt_url set-once
  if old.receipt_url is not null and new.receipt_url is distinct from old.receipt_url then
    raise exception 'orders_receipt_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.orders_financial_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_orders_financial_guard on public.orders;
create trigger trg_orders_financial_guard before update on public.orders
  for each row execute function public.orders_financial_guard();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S11. RPC 정의 — core 헬퍼 + 외부 RPC. 전부 security definer·set search_path=''·완전수식.
--   core/helper 는 revoke all(service_role 포함) · 외부 RPC 만 service_role execute grant(§16).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── core: 환불율/금액 산식(§41·A.6.2) ──
create or replace function public.bp_refund_rate_bps(p_cra timestamptz, p_paid_at timestamptz)
returns int
language sql
immutable
set search_path = ''
as $$
  select case when p_cra <= p_paid_at + interval '7 days' then 10000 else 9000 end;
$$;
revoke all on function public.bp_refund_rate_bps(timestamptz, timestamptz) from public, anon, authenticated, service_role;

create or replace function public.bp_refund_amount(
  p_order_amount bigint, p_order_credits int, p_qty int, p_rate_bps int, p_remaining_cash bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select least(
    ceil(p_order_amount::numeric * p_qty * p_rate_bps / (p_order_credits::numeric * 10000))::bigint,
    p_remaining_cash);
$$;
revoke all on function public.bp_refund_amount(bigint, int, int, int, bigint) from public, anon, authenticated, service_role;

-- ── core: v2 credit_ledger 기록(BEFORE INSERT 가드가 독립 검증) ──
create or replace function public.bp_credit_ledger_write(
  p_user uuid, p_delta int, p_event text,
  p_ref_attempt uuid, p_ref_cancellation text, p_ref_lot uuid, p_ref_gen uuid, p_ref_order uuid,
  p_metadata jsonb, p_note text)
returns void
language plpgsql
set search_path = ''
as $$
declare v_bal int;
begin
  select gen_credits into v_bal from public.member_accounts where user_id = p_user;
  insert into public.credit_ledger
    (user_id, delta, event_type, balance_after, ref_gen_id, ref_order_uuid, note,
     ref_attempt_id, ref_cancellation_id, ref_lot_id, metadata, schema_version)
  values (p_user, p_delta, p_event, v_bal, p_ref_gen, p_ref_order, p_note,
          p_ref_attempt, p_ref_cancellation, p_ref_lot, p_metadata, 2);
end;
$$;
revoke all on function public.bp_credit_ledger_write(uuid, int, text, uuid, text, uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;

-- ── 외부 RPC: create_pending_order(§18) — 서버 canonical allowlist 로만 amount/credits 결정 ──
create or replace function public.create_pending_order(
  p_user uuid, p_order_uuid uuid, p_product_id text, p_amount int, p_credits int,
  p_payment_id text, p_provider text, p_pay_channel text, p_is_test boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amt int; v_cr int; v_deleted boolean; v_existing public.orders;
begin
  -- 내부 immutable allowlist(§18 — 클라 amount/credits 자유입력 금지)
  select amount, credits into v_amt, v_cr from (values
    ('credits_3', 1000, 3), ('credits_10', 3000, 10),
    ('credits_20', 5500, 20), ('credits_40', 10000, 40)
  ) as p(product_id, amount, credits) where p.product_id = p_product_id;
  if v_amt is null then raise exception 'invalid_product' using errcode = 'P0001'; end if;
  if p_amount <> v_amt or p_credits <> v_cr then raise exception 'product_amount_mismatch' using errcode = 'P0001'; end if;
  if p_provider <> 'portone' then raise exception 'invalid_provider' using errcode = 'P0001'; end if;
  if p_pay_channel not in ('card', 'tosspay', 'kakaopay') then raise exception 'invalid_channel' using errcode = 'P0001'; end if;
  if p_payment_id <> pg_catalog.replace(p_order_uuid::text, '-', '') then
    raise exception 'payment_id_format' using errcode = 'P0001';
  end if;
  select (p.deleted_at is not null) into v_deleted from public.profiles p where p.id = p_user;
  if coalesce(v_deleted, false) then raise exception 'account_deleted' using errcode = 'P0001'; end if;

  -- 멱등: 동일 payment_id 재호출은 기존 pending 반환(다른 소유자면 conflict)
  select * into v_existing from public.orders where payment_id = p_payment_id;
  if v_existing.order_uuid is not null then
    if v_existing.user_id <> p_user or v_existing.amount <> p_amount or v_existing.credits <> p_credits then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return v_existing.order_uuid;
  end if;

  insert into public.orders
    (order_uuid, user_id, product_id, amount, credits, status, provider, payment_id, is_test, pay_channel)
  values (p_order_uuid, p_user, p_product_id, p_amount, p_credits, 'pending', p_provider,
          p_payment_id, coalesce(p_is_test, false), p_pay_channel);
  return p_order_uuid;
end;
$$;
revoke all on function public.create_pending_order(uuid, uuid, text, int, int, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.create_pending_order(uuid, uuid, text, int, int, text, text, text, boolean) to service_role;

-- ── 외부 RPC: mark_paid_and_grant 6-arg(§12.4·§40) — paid_at fallback 제거·purchase 로트 생성 ──
--   §40 상태표 분기: active PAID(live 지급) / deleted PAID(quarantine·late_paid issue) /
--   organic late PAID(canceled 주문 — status='paid' 전환·quarantine order_canceled·late_paid issue) /
--   cancel intent 후 PAID(지급 0·quarantine order_canceled·late_paid issue — 실취소는 intent resolve→scoped saga).
create or replace function public.mark_paid_and_grant(
  p_order_uuid uuid, p_pg_tx_id text, p_price int, p_raw jsonb,
  p_paid_at timestamptz, p_receipt_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  v_deleted boolean;
  v_paid_at timestamptz;
  v_balance int;
  v_lot uuid;
begin
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then return false; end if;
  if o.amount <> p_price then return false; end if;
  -- 이미 지급 처리된 주문(어느 분기든 paid_at 기록)은 재처리 금지 — 멱등 false(v1 semantics 유지).
  if o.paid_at is not null then return false; end if;
  if o.status <> 'pending' and o.status <> 'failed' and o.status <> 'canceled' then return false; end if;

  -- paid_at 결정: explicit 우선 → p_raw.paid_at → 둘 다 없으면 실패(now() fallback 폐기, §12.4)
  v_paid_at := coalesce(p_paid_at, nullif(p_raw->>'paid_at', '')::timestamptz);
  if v_paid_at is null then raise exception 'paid_at_required' using errcode = 'P0001'; end if;
  if v_paid_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'paid_at_future' using errcode = 'P0001';
  end if;

  select (p.deleted_at is not null) into v_deleted from public.profiles p where p.id = o.user_id;

  if o.status = 'canceled' then
    -- organic 늦은 PAID(§17·§40): 로컬 취소(무결제) 주문에 뒤늦은 PAID 확정.
    -- canceled 유지 금지(strict CHECK 충돌) — status='paid' 전환 + 지급 0 + quarantine 로트 + late_paid issue.
    update public.orders
       set status = 'paid', pg_status = 'PAID', paid_at = v_paid_at, raw = p_raw,
           pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id),
           receipt_url = coalesce(receipt_url, p_receipt_url),
           error_message = 'late_paid_no_grant'
     where order_uuid = p_order_uuid;
    insert into public.credit_lots
      (user_id, source, order_uuid, qty, granted_at, expires_at, expired_at, expiration_reason)
    values (o.user_id, 'purchase', o.order_uuid, o.credits, v_paid_at, v_paid_at + interval '1 year',
            v_paid_at, 'order_canceled');
    insert into public.reconciliation_issues (type, order_uuid, user_id, cancellation_id, detail)
    values ('late_paid', o.order_uuid, o.user_id, null,
            pg_catalog.jsonb_build_object('case', 'organic_late_paid', 'paid_at', v_paid_at,
              'amount', o.amount, 'credits', o.credits, 'account_deleted', coalesce(v_deleted, false)))
    on conflict (type, order_uuid, coalesce(cancellation_id, '')) where state = 'open' do nothing;
    return true;
  end if;

  if coalesce(v_deleted, false) then
    -- 탈퇴자: 결제 기록 보존·크레딧 미지급·quarantine purchase 로트(account_deleted) + late_paid issue(§40).
    update public.orders
       set status = 'paid', pg_status = 'PAID', paid_at = v_paid_at, raw = p_raw,
           pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id),
           receipt_url = coalesce(receipt_url, p_receipt_url),
           error_message = 'account_deleted_no_grant'
     where order_uuid = p_order_uuid;
    insert into public.credit_lots
      (user_id, source, order_uuid, qty, granted_at, expires_at, expired_at, expiration_reason)
    values (o.user_id, 'purchase', o.order_uuid, o.credits, v_paid_at, v_paid_at + interval '1 year',
            v_paid_at, 'account_deleted');
    insert into public.reconciliation_issues (type, order_uuid, user_id, cancellation_id, detail)
    values ('late_paid', o.order_uuid, o.user_id, null,
            pg_catalog.jsonb_build_object('case', 'deleted_paid', 'paid_at', v_paid_at,
              'amount', o.amount, 'credits', o.credits))
    on conflict (type, order_uuid, coalesce(cancellation_id, '')) where state = 'open' do nothing;
    return true;
  end if;

  if o.cancel_intent_created_at is not null then
    -- 취소 의도 후 PAID(§40): 지급 0 + quarantine(order_canceled) + late_paid issue.
    -- 실취소·환불은 cancel_intent_resolve 가 만드는 scoped request(quarantine 로트도 예약 가능)가 담당.
    update public.orders
       set status = 'paid', pg_status = 'PAID', paid_at = v_paid_at, raw = p_raw,
           pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id),
           receipt_url = coalesce(receipt_url, p_receipt_url),
           error_message = 'cancel_intent_no_grant'
     where order_uuid = p_order_uuid;
    insert into public.credit_lots
      (user_id, source, order_uuid, qty, granted_at, expires_at, expired_at, expiration_reason)
    values (o.user_id, 'purchase', o.order_uuid, o.credits, v_paid_at, v_paid_at + interval '1 year',
            v_paid_at, 'order_canceled');
    insert into public.reconciliation_issues (type, order_uuid, user_id, cancellation_id, detail)
    values ('late_paid', o.order_uuid, o.user_id, null,
            pg_catalog.jsonb_build_object('case', 'paid_after_cancel_intent', 'paid_at', v_paid_at,
              'amount', o.amount, 'credits', o.credits))
    on conflict (type, order_uuid, coalesce(cancellation_id, '')) where state = 'open' do nothing;
    return true;
  end if;

  update public.orders
     set status = 'paid', pg_status = 'PAID', paid_at = v_paid_at, raw = p_raw,
         pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id),
         receipt_url = coalesce(receipt_url, p_receipt_url),
         error_message = null
   where order_uuid = p_order_uuid;

  insert into public.member_accounts (user_id, gen_credits)
  values (o.user_id, o.credits)
  on conflict (user_id) do update
    set gen_credits = member_accounts.gen_credits + excluded.gen_credits
  returning gen_credits into v_balance;

  -- live purchase 로트 생성.
  insert into public.credit_lots (user_id, source, order_uuid, qty, granted_at, expires_at)
  values (o.user_id, 'purchase', o.order_uuid, o.credits, v_paid_at, v_paid_at + interval '1 year')
  returning id into v_lot;

  -- v2 원장(purchase — ref_order_uuid).
  perform public.bp_credit_ledger_write(o.user_id, o.credits, 'purchase',
    null, null, null, null, p_order_uuid, null, o.product_id);
  return true;
end;
$$;
revoke all on function public.mark_paid_and_grant(uuid, text, int, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.mark_paid_and_grant(uuid, text, int, jsonb, timestamptz, text) to service_role;

-- ── core: 로트 소비(FIFO — 만료 임박 우선) ──
create or replace function public.consume_gen_credit_v2(p_user uuid, p_gen_id uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_lot public.credit_lots;
  v_balance int;
begin
  select * into v_lot from public.credit_lots
   where user_id = p_user and expired_at is null
     and (qty - consumed - refunded - refund_reserved) > 0
   order by expires_at asc, granted_at asc, id asc
   for update
   limit 1;
  if not found then
    return null;   -- 소비 가능 로트 없음(잔액 0)
  end if;

  update public.credit_lots set consumed = consumed + 1 where id = v_lot.id;
  update public.member_accounts set gen_credits = gen_credits - 1
    where user_id = p_user and gen_credits >= 1
    returning gen_credits into v_balance;
  if v_balance is null then
    raise exception 'consume_cache_underflow' using errcode = 'P0001';
  end if;

  update public.ai_generations set credit_lot_id = v_lot.id, consumed_at = now()
    where id = p_gen_id and owner_id = p_user;

  perform public.bp_credit_ledger_write(p_user, -1, 'gen_consume',
    null, null, null, p_gen_id, null, null, null);
  return v_balance;
end;
$$;
revoke all on function public.consume_gen_credit_v2(uuid, uuid) from public, anon, authenticated, service_role;

-- ── core: 로트 환급(§13·§19 — normal / shortfall 흡수) ──
create or replace function public.refund_gen_credit_v2(p_gen_id uuid, p_expected_version int)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  g public.ai_generations;
  v_lot public.credit_lots;
  v_sf public.credit_refund_shortfalls;
  v_balance int;
begin
  select * into g from public.ai_generations where id = p_gen_id for update;
  if not found then raise exception 'generation_not_found' using errcode = 'P0001'; end if;
  if g.refunded_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if g.status <> 'failed' then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if g.credit_lot_id is null or g.consumed_at is null then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and g.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  select * into v_lot from public.credit_lots where id = g.credit_lot_id for update;

  -- 이 로트의 oldest open shortfall(remaining>0) 흡수 우선.
  select * into v_sf from public.credit_refund_shortfalls
   where lot_id = v_lot.id and state = 'open' and remaining_shortfall_qty > 0
   order by created_at asc, id asc for update limit 1;

  if found then
    -- shortfall 흡수: consumed −1·refunded +1 동량·shortfall recovered +1. 캐시 불변(delta 0).
    update public.credit_lots set consumed = consumed - 1, refunded = refunded + 1 where id = v_lot.id;
    update public.credit_refund_shortfalls
       set recovered_qty = recovered_qty + 1,
           remaining_shortfall_qty = remaining_shortfall_qty - 1,
           state = case when remaining_shortfall_qty - 1 = 0 then 'resolved' else 'open' end,
           resolved_at = case when remaining_shortfall_qty - 1 = 0 then now() else resolved_at end
     where id = v_sf.id;
    update public.ai_generations set refunded_at = now() where id = p_gen_id;
    perform public.bp_credit_ledger_write(g.owner_id, 0, 'gen_refund',
      null, null, null, p_gen_id, null, null, 'shortfall_absorb:' || v_sf.id::text);
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'shortfall_absorbed', 'shortfall_id', v_sf.id);
  end if;

  -- normal 환급: live 로트면 consumed −1·캐시 +1(delta +1), expired 로트면 consumed −1·캐시 불변(delta 0).
  update public.credit_lots set consumed = consumed - 1 where id = v_lot.id;
  if v_lot.expired_at is null then
    update public.member_accounts set gen_credits = gen_credits + 1
      where user_id = g.owner_id returning gen_credits into v_balance;
    update public.ai_generations set refunded_at = now() where id = p_gen_id;
    perform public.bp_credit_ledger_write(g.owner_id, 1, 'gen_refund',
      null, null, null, p_gen_id, null, null, 'live_refund');
  else
    update public.ai_generations set refunded_at = now() where id = p_gen_id;
    perform public.bp_credit_ledger_write(g.owner_id, 0, 'gen_refund',
      null, null, null, p_gen_id, null, null, 'expired_no_cache');
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'refunded');
end;
$$;
revoke all on function public.refund_gen_credit_v2(uuid, int) from public, anon, authenticated, service_role;

-- ── 외부 RPC: create_generation_and_consume(§19 — 원자: queued row + lot consume + ledger) ──
create or replace function public.create_generation_and_consume(p_user uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gen uuid;
  v_remaining int;
begin
  insert into public.ai_generations (owner_id, status, role)
  values (p_user, 'queued', p_role)
  returning id into v_gen;

  v_remaining := public.consume_gen_credit_v2(p_user, v_gen);
  if v_remaining is null then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'generation_id', v_gen, 'remaining', v_remaining);
end;
$$;
revoke all on function public.create_generation_and_consume(uuid, text) from public, anon, authenticated;
grant execute on function public.create_generation_and_consume(uuid, text) to service_role;

-- ── 외부 RPC: create_generation_row — 소비 없는 queued 행 생성(운영 무제한 계정 전용 경로) ──
--   §13: 0063 이 ai_generations INSERT 를 회수하므로, 크레딧 소비가 없는 ops 생성도 RPC 경유.
create or replace function public.create_generation_row(p_user uuid, p_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_gen uuid;
begin
  insert into public.ai_generations (owner_id, status, role)
  values (p_user, 'queued', p_role)
  returning id into v_gen;
  return v_gen;
end;
$$;
revoke all on function public.create_generation_row(uuid, text) from public, anon, authenticated;
grant execute on function public.create_generation_row(uuid, text) to service_role;

-- ── 외부 RPC: mark_generation_failed_and_refund(§19 — 원자: failed + lot refund/absorb + ledger) ──
create or replace function public.mark_generation_failed_and_refund(
  p_gen_id uuid, p_fail_reason text, p_expected_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare g public.ai_generations;
begin
  select * into g from public.ai_generations where id = p_gen_id for update;
  if not found then raise exception 'generation_not_found' using errcode = 'P0001'; end if;
  if g.status in ('done', 'picked') then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if g.refunded_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if g.status <> 'failed' then
    update public.ai_generations set status = 'failed', fail_reason = p_fail_reason where id = p_gen_id;
  end if;
  if g.credit_lot_id is null then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_consume');
  end if;
  return public.refund_gen_credit_v2(p_gen_id, p_expected_version);
end;
$$;
revoke all on function public.mark_generation_failed_and_refund(uuid, text, int) from public, anon, authenticated;
grant execute on function public.mark_generation_failed_and_refund(uuid, text, int) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 환불 saga RPC
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 외부 RPC: admin_refund_begin — request(building)+attempt(prepared)+로트 예약, prepared 전이 ──
create or replace function public.admin_refund_begin(
  p_request_id uuid, p_admin uuid, p_user uuid, p_order_uuid uuid,
  p_qty int, p_reason text, p_customer_requested_at timestamptz, p_rail text default 'portone_cancel')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  lot public.credit_lots;
  v_avail int;
  v_rate int;
  v_amount bigint;
  v_remaining_cash bigint;
  v_attempt uuid := gen_random_uuid();
  v_payload_hash text;
  v_plan_hash text;
  v_approved_hash text;
  r_existing public.refund_requests;
  v_live boolean;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_qty <= 0 then raise exception 'qty_invalid' using errcode = 'P0001'; end if;
  if p_rail not in ('portone_cancel', 'manual_transfer') then raise exception 'rail_invalid' using errcode = 'P0001'; end if;
  if p_customer_requested_at > clock_timestamp() + interval '5 minutes' then raise exception 'cra_future' using errcode = 'P0001'; end if;

  v_payload_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'op', 'admin_refund_begin', 'order_uuid', p_order_uuid::text, 'user_id', p_user::text,
    'qty', p_qty, 'reason', p_reason, 'customer_requested_at', p_customer_requested_at,
    'rail', p_rail), 1);

  -- 멱등(§9): 동일 request_id 재호출 → payload 동일이면 no_op, 상이면 request_conflict.
  select * into r_existing from public.refund_requests where id = p_request_id;
  if r_existing.id is not null then
    if r_existing.payload_hash <> v_payload_hash then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true,
      'request_id', p_request_id);
  end if;

  select * into o from public.orders where order_uuid = p_order_uuid and user_id = p_user for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.paid_at is null then raise exception 'order_not_paid' using errcode = 'P0001'; end if;

  perform 1 from public.member_accounts where user_id = p_user for update;
  select * into lot from public.credit_lots
   where order_uuid = p_order_uuid and source = 'purchase' for update;
  if not found then raise exception 'purchase_lot_not_found' using errcode = 'P0001'; end if;

  v_live := (lot.expired_at is null);
  v_avail := lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
  if p_qty > v_avail then raise exception 'qty_exceeds_available' using errcode = 'P0001'; end if;
  if p_qty > (o.credits - o.refunded_credits) then raise exception 'qty_exceeds_order_remaining' using errcode = 'P0001'; end if;

  v_remaining_cash := o.amount - o.refunded_amount;
  if v_remaining_cash <= 0 then raise exception 'nothing_to_refund' using errcode = 'P0001'; end if;
  v_rate := public.bp_refund_rate_bps(p_customer_requested_at, o.paid_at);
  v_amount := public.bp_refund_amount(o.amount, o.credits, p_qty, v_rate, v_remaining_cash);
  if v_amount <= 0 then raise exception 'amount_nonpositive' using errcode = 'P0001'; end if;

  v_plan_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid::text, 'lot_id', lot.id::text, 'qty', p_qty, 'amount', v_amount,
    'rate_bps', v_rate, 'paid_at_snapshot', o.paid_at,
    'order_amount_snapshot', o.amount, 'order_credits_snapshot', o.credits,
    'expected_refunded_credits_before', o.refunded_credits,
    'expected_refunded_amount_before', o.refunded_amount), 1);
  v_approved_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'requested_qty', p_qty, 'approved_amount', v_amount, 'plan_hash', v_plan_hash), 1);

  -- request(building)
  insert into public.refund_requests
    (id, user_id, admin_user_id, origin, scope_order_uuid, requested_qty,
     customer_requested_at, reason, payload_hash, payload_hash_version, state)
  values (p_request_id, p_user, p_admin, 'admin_manual', null, p_qty,
          p_customer_requested_at, p_reason, v_payload_hash, 1, 'building');

  -- attempt(prepared)
  begin
    insert into public.order_refund_attempts
      (id, request_id, sequence, order_uuid, user_id, credit_lot_id, admin_user_id, reason, qty, amount,
       rail, state, rate_bps, policy_as_of, refund_deadline, paid_at_snapshot,
       order_amount_snapshot, order_credits_snapshot, expected_refunded_credits_before,
       expected_refunded_amount_before, plan_hash, plan_hash_version)
    values (v_attempt, p_request_id, 1, p_order_uuid, p_user, lot.id, p_admin, p_reason, p_qty, v_amount,
            p_rail, 'prepared', v_rate, clock_timestamp(), o.paid_at + interval '5 years', o.paid_at,
            o.amount, o.credits, o.refunded_credits, o.refunded_amount, v_plan_hash, 1);
  exception when unique_violation then
    raise exception 'order_has_open_refund' using errcode = 'P0001';
  end;

  -- 로트 예약 + 캐시 차감(live) + refund_reserve 원장
  update public.credit_lots set refund_reserved = refund_reserved + p_qty where id = lot.id;
  if v_live then
    update public.member_accounts set gen_credits = gen_credits - p_qty where user_id = p_user;
    perform public.bp_credit_ledger_write(p_user, -p_qty, 'refund_reserve',
      v_attempt, null, null, null, null, null, null);
  else
    perform public.bp_credit_ledger_write(p_user, 0, 'refund_reserve',
      v_attempt, null, null, null, null, null, null);
  end if;

  -- request building→prepared
  update public.refund_requests
     set state = 'prepared', approved_plan_hash = v_approved_hash,
         approved_plan_hash_version = 1, approved_amount = v_amount
   where id = p_request_id;

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'prepared', 'request_id', p_request_id,
    'attempt_id', v_attempt, 'qty', p_qty, 'amount', v_amount, 'rate_bps', v_rate);
end;
$$;
revoke all on function public.admin_refund_begin(uuid, uuid, uuid, uuid, int, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.admin_refund_begin(uuid, uuid, uuid, uuid, int, text, timestamptz, text) to service_role;

-- ── 외부 RPC: admin_refund_mark_pg_requested — prepared/manual_review(pre-PG)→pg_requested ──
create or replace function public.admin_refund_mark_pg_requested(
  p_attempt_id uuid, p_total_before bigint, p_cancelled_before bigint, p_cancellable_before bigint,
  p_cancellation_ids_before jsonb, p_request_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a public.order_refund_attempts;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  -- 멱등: 이미 pg_requested 이고 저장 body/preflight 동일이면 no_op.
  if a.state in ('pg_requested', 'pg_pending', 'pg_succeeded') then
    if a.pg_request_body = p_request_body and a.pg_total_before = p_total_before then
      return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state not in ('prepared', 'manual_review') then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if a.rail <> 'portone_cancel' then raise exception 'rail_not_pg' using errcode = 'P0001'; end if;

  update public.order_refund_attempts
     set state = 'pg_requested',
         pg_total_before = p_total_before, pg_cancelled_before = p_cancelled_before,
         pg_cancellable_before = p_cancellable_before, pg_cancellation_ids_before = p_cancellation_ids_before,
         pg_preflight_at = clock_timestamp(),
         pg_idempotency_key = a.id::text, pg_requested_at = clock_timestamp(),
         pg_request_body = p_request_body
   where id = p_attempt_id;
  update public.refund_requests set state = 'processing'
    where id = a.request_id and state = 'prepared';
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'pg_requested', 'attempt_id', p_attempt_id);
end;
$$;
revoke all on function public.admin_refund_mark_pg_requested(uuid, bigint, bigint, bigint, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_refund_mark_pg_requested(uuid, bigint, bigint, bigint, jsonb, jsonb) to service_role;

-- ── 외부 RPC: admin_refund_record_pg_result — PG 응답 반영(succeeded/pending/failed) ──
create or replace function public.admin_refund_record_pg_result(
  p_attempt_id uuid, p_result text, p_cancel_id text, p_cancel_status text,
  p_cancelled_amount bigint, p_receipt_url text, p_raw jsonb,
  p_requested_at timestamptz default null, p_cancelled_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a public.order_refund_attempts;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if p_result not in ('succeeded', 'pending', 'failed') then raise exception 'result_invalid' using errcode = 'P0001'; end if;

  -- 멱등: 이미 pg_succeeded 이고 동일 cancel_id/SUCCEEDED 면 no_op, 상이면 conflict.
  if a.state = 'pg_succeeded' then
    if p_result = 'succeeded' and a.pg_cancel_id = p_cancel_id and a.pg_cancel_status = 'SUCCEEDED' then
      return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state not in ('pg_requested', 'pg_pending') then raise exception 'invalid_state' using errcode = 'P0001'; end if;

  if p_result = 'pending' then
    if a.state = 'pg_requested' then
      update public.order_refund_attempts set state = 'pg_pending', pg_cancel_status = 'REQUESTED',
             pg_raw = p_raw, last_reconciled_at = clock_timestamp() where id = p_attempt_id;
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'pending');

  elsif p_result = 'succeeded' then
    if p_cancel_id is null then raise exception 'cancel_id_required' using errcode = 'P0001'; end if;
    -- ① event SUCCEEDED+unmatched upsert  ② attempt.pg_cancel_id  ③ event→matched
    insert into public.payment_cancellation_events
      (cancellation_id, order_uuid, status, amount, requested_at, cancelled_at, origin, resolution_state, observed_raw)
    values (p_cancel_id, a.order_uuid, 'SUCCEEDED', a.amount, p_requested_at, p_cancelled_at, 'live', 'unmatched', p_raw)
    on conflict (cancellation_id) do nothing;
    update public.order_refund_attempts
       set state = 'pg_succeeded', pg_cancel_id = p_cancel_id, pg_cancel_status = 'SUCCEEDED',
           pg_raw = p_raw, cancellation_receipt_url = p_receipt_url,
           last_reconciled_at = clock_timestamp()
     where id = p_attempt_id;
    update public.payment_cancellation_events
       set resolution_state = 'matched', matched_attempt_id = p_attempt_id
     where cancellation_id = p_cancel_id;
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'pg_succeeded', 'cancellation_id', p_cancel_id);

  else  -- failed → manual_review(운영자 화해 필요). FAILED event 는 검증 후 switch_to_manual 이 종결.
    update public.order_refund_attempts
       set state = 'manual_review', pg_cancel_status = coalesce(p_cancel_status, 'FAILED'),
           pg_raw = p_raw, last_reconciled_at = clock_timestamp()
     where id = p_attempt_id;
    update public.refund_requests set state = 'blocked'
      where id = a.request_id and state <> 'blocked';
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'manual_review');
  end if;
end;
$$;
revoke all on function public.admin_refund_record_pg_result(uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_refund_record_pg_result(uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz) to service_role;

-- ── core: attempt commit 적용(lot rr→refunded·orders 갱신·policy-cap closure·원장). PG/manual 공용. ──
create or replace function public.bp_apply_attempt_commit(
  p_attempt_id uuid, p_admin uuid, p_reason text, p_action_metadata jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  a public.order_refund_attempts;
  o public.orders;
  lot public.credit_lots;
  v_before int; v_after int;
  v_new_refunded_credits int; v_new_refunded_amount bigint;
  v_closure int; v_avail int; v_recoverable int; v_new_shortfall int; v_existing_covered int;
  v_cache_effect int; v_existing_remaining int; v_lot_live boolean;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  select * into o from public.orders where order_uuid = a.order_uuid for update;
  select * into lot from public.credit_lots where id = a.credit_lot_id for update;
  select gen_credits into v_before from public.member_accounts where user_id = a.user_id for update;

  -- 1. lot rr→refunded(동량) + attempt committed.
  update public.credit_lots
     set refund_reserved = refund_reserved - a.qty, refunded = refunded + a.qty
   where id = lot.id;
  update public.order_refund_attempts set state = 'committed' where id = p_attempt_id;

  -- 2. orders 갱신.
  v_new_refunded_credits := o.refunded_credits + a.qty;
  v_new_refunded_amount := o.refunded_amount + a.amount;
  update public.orders
     set refunded_credits = v_new_refunded_credits, refunded_amount = v_new_refunded_amount,
         receipt_url = coalesce(o.receipt_url, a.cancellation_receipt_url)
   where order_uuid = o.order_uuid;

  -- 3. refund_commit(attempt) 원장 delta 0.
  perform public.bp_credit_ledger_write(a.user_id, 0, 'refund_commit',
    p_attempt_id, null, null, null, null, null, null);

  -- 4. policy-cap closure — 전액 현금 환불(refunded_amount = amount) 도달 시 잔여 credit 종결(§41·A.6.3).
  if v_new_refunded_amount = o.amount and v_new_refunded_credits < o.credits then
    select * into lot from public.credit_lots where id = a.credit_lot_id for update;
    v_lot_live := (lot.expired_at is null);
    v_closure := o.credits - v_new_refunded_credits;
    v_avail := lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
    v_recoverable := least(v_closure, v_avail);
    -- §41 3분해: closure = recoverable + existing_covered + new_shortfall (clamp 금지).
    --   existing_covered = 잔여 closure 중 이미 shortfall 로 추적 중인 소비분(신규 shortfall 불요·미저장 파생).
    select coalesce(sum(remaining_shortfall_qty), 0) into v_existing_remaining
      from public.credit_refund_shortfalls where lot_id = lot.id;
    v_existing_covered := least(v_closure - v_recoverable, v_existing_remaining);
    v_new_shortfall := v_closure - v_recoverable - v_existing_covered;
    v_cache_effect := case when v_lot_live then v_recoverable else 0 end;
    -- 불변식(§41): new_shortfall <= consumed − 기존 remaining(초과=데이터 모순 → RAISE·Sentry fatal)
    if v_new_shortfall > lot.consumed - v_existing_remaining then
      raise exception 'invariant_violation' using errcode = 'P0001';
    end if;

    if v_recoverable > 0 then
      update public.credit_lots set refunded = refunded + v_recoverable where id = lot.id;
    end if;
    update public.orders set refunded_credits = o.credits where order_uuid = o.order_uuid;
    if v_cache_effect > 0 then
      update public.member_accounts set gen_credits = gen_credits - v_cache_effect where user_id = a.user_id;
    end if;
    perform public.bp_credit_ledger_write(a.user_id, -v_cache_effect, 'refund_policy_close',
      p_attempt_id, null, null, null, null,
      pg_catalog.jsonb_build_object('closure_qty', v_closure, 'recovered_qty', v_recoverable,
        'shortfall_qty', v_new_shortfall, 'lot_was_live', v_lot_live,
        'cache_effect_qty', v_cache_effect, 'rate_bps', a.rate_bps, 'refunded_amount_total', 0),
      null);
    if v_new_shortfall > 0 then
      insert into public.credit_refund_shortfalls
        (source_type, source_attempt_id, source_cancellation_id, order_uuid, lot_id,
         mapped_qty, recovered_qty, initial_shortfall_qty, remaining_shortfall_qty, state)
      values ('policy_cap', p_attempt_id, null, o.order_uuid, lot.id,
              v_closure, 0, v_new_shortfall, v_new_shortfall, 'open');
    end if;
    -- 사후검증(D2 재확인)
    select coalesce(sum(remaining_shortfall_qty), 0) into v_existing_remaining
      from public.credit_refund_shortfalls where lot_id = lot.id;
    select consumed into v_avail from public.credit_lots where id = lot.id;
    if v_existing_remaining > v_avail then
      raise exception 'shortfall_exceeds_consumed' using errcode = 'P0001';
    end if;
  end if;

  -- 5. admin 감사 원장(partial_refund).
  select gen_credits into v_after from public.member_accounts where user_id = a.user_id;
  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
  values (p_admin, 'partial_refund', a.user_id, a.order_uuid, v_after - v_before, a.amount,
          v_before, v_after, p_reason, p_action_metadata, p_attempt_id,
          public.bp_versioned_hash(p_action_metadata || pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text), 1), 1);
end;
$$;
revoke all on function public.bp_apply_attempt_commit(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

-- ── 외부 RPC: admin_refund_commit (PG rail) — pg_succeeded→committed ──
create or replace function public.admin_refund_commit(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a public.order_refund_attempts; r public.refund_requests;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if a.state = 'committed' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if a.state <> 'pg_succeeded' then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if a.rail <> 'portone_cancel' then raise exception 'rail_not_pg' using errcode = 'P0001'; end if;
  select * into r from public.refund_requests where id = a.request_id;

  perform public.bp_apply_attempt_commit(p_attempt_id, r.admin_user_id, r.reason,
    pg_catalog.jsonb_build_object('rail', 'portone_cancel', 'pg_cancel_id', a.pg_cancel_id));

  update public.refund_requests set state = public.derive_refund_request_state(a.request_id)
    where id = a.request_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'committed', 'attempt_id', p_attempt_id);
end;
$$;
revoke all on function public.admin_refund_commit(uuid) from public, anon, authenticated;
grant execute on function public.admin_refund_commit(uuid) to service_role;

-- ── 외부 RPC: admin_refund_switch_to_manual — →manual_pending(rail switch + 무이동 증빙) ──
create or replace function public.admin_refund_switch_to_manual(
  p_attempt_id uuid, p_admin uuid, p_reason text,
  p_observed_cancelled_amount bigint, p_observed_cancellation_ids jsonb, p_verification_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.order_refund_attempts;
  v_evhash text; v_verified_by uuid;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if a.state = 'manual_pending' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if a.state not in ('prepared', 'pg_requested', 'pg_pending', 'manual_review') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_verification_source not in ('pg_failed_response', 'admin_reconcile', 'resolver') then
    raise exception 'verification_source_invalid' using errcode = 'P0001';
  end if;

  v_verified_by := case when p_verification_source = 'pg_failed_response' then null else p_admin end;
  v_evhash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'attempt_id', p_attempt_id::text, 'observed_cancelled_amount', p_observed_cancelled_amount,
    'observed_cancellation_ids', p_observed_cancellation_ids, 'verification_source', p_verification_source), 1);

  update public.order_refund_attempts
     set rail = 'manual_transfer', state = 'manual_pending',
         reconciliation_verified_at = clock_timestamp(), reconciliation_result = 'no_movement',
         observed_cancelled_amount = p_observed_cancelled_amount,
         observed_cancellation_ids = coalesce(p_observed_cancellation_ids, '[]'::jsonb),
         verification_source = p_verification_source, verified_by = v_verified_by,
         evidence_hash = v_evhash, evidence_hash_version = 1,
         last_reconciled_at = clock_timestamp()
   where id = p_attempt_id;

  -- 검증된 FAILED event 는 같은 트랜잭션에서 system-ignore 종결(관측된 것이 있으면).
  update public.payment_cancellation_events
     set resolution_state = 'ignored', resolved_at = now(), resolution_source = 'system', resolved_by = null
   where order_uuid = a.order_uuid and status = 'FAILED' and resolution_state = 'unmatched';

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
  select p_admin, 'refund_switch_manual', a.user_id, a.order_uuid, 0, a.amount,
         ma.gen_credits, ma.gen_credits, p_reason,
         pg_catalog.jsonb_build_object('from_state', a.state, 'from_rail', a.rail,
           'to_rail', 'manual_transfer', 'evidence_hash', v_evhash),
         p_attempt_id,
         public.bp_versioned_hash(pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text, 'op', 'switch_manual'), 1), 1
    from public.member_accounts ma where ma.user_id = a.user_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'manual_pending', 'attempt_id', p_attempt_id);
end;
$$;
revoke all on function public.admin_refund_switch_to_manual(uuid, uuid, text, bigint, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.admin_refund_switch_to_manual(uuid, uuid, text, bigint, jsonb, text) to service_role;

-- ── 외부 RPC: admin_refund_commit_manual — manual_pending→committed(manual rail 5필드) ──
create or replace function public.admin_refund_commit_manual(
  p_attempt_id uuid, p_admin uuid, p_reason text, p_external_payout_ref text, p_evidence_object_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.order_refund_attempts; r public.refund_requests;
  v_evidence jsonb; v_hash text;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_external_payout_ref !~ '^[A-Za-z0-9._:-]{1,128}$' then raise exception 'payout_ref_invalid' using errcode = 'P0001'; end if;

  v_evidence := pg_catalog.jsonb_build_object('method', 'bank_transfer', 'evidence_object_id', p_evidence_object_id::text);
  v_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'attempt_id', p_attempt_id::text, 'external_payout_ref', p_external_payout_ref,
    'evidence', v_evidence, 'reason', p_reason), 1);

  if a.state = 'committed' then
    if a.manual_commit_payload_hash = v_hash then
      return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state <> 'manual_pending' then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if a.rail <> 'manual_transfer' then raise exception 'rail_not_manual' using errcode = 'P0001'; end if;

  -- committed 진입 5필드 세팅 + rr→refunded/closure(core).
  update public.order_refund_attempts
     set external_payout_ref = p_external_payout_ref, paid_out_at = clock_timestamp(),
         payout_evidence = v_evidence, manual_commit_payload_hash = v_hash,
         manual_commit_payload_hash_version = 1, manual_commit_reason = p_reason
   where id = p_attempt_id;

  perform public.bp_apply_attempt_commit(p_attempt_id, p_admin, p_reason,
    pg_catalog.jsonb_build_object('rail', 'manual_transfer', 'external_payout_ref', p_external_payout_ref));

  select * into r from public.refund_requests where id = a.request_id;
  update public.refund_requests set state = public.derive_refund_request_state(a.request_id)
    where id = a.request_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'committed', 'attempt_id', p_attempt_id);
end;
$$;
revoke all on function public.admin_refund_commit_manual(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_refund_commit_manual(uuid, uuid, text, text, uuid) to service_role;

-- ── core: attempt 해제(예약 복원·refund_release 원장·admin 감사). release_reason 별 게이트는 호출자. ──
create or replace function public.bp_apply_attempt_release(
  p_attempt_id uuid, p_admin uuid, p_reason text, p_release_reason text, p_record_admin boolean)
returns void
language plpgsql
set search_path = ''
as $$
declare
  a public.order_refund_attempts; lot public.credit_lots; v_before int; v_after int; v_live boolean;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  select * into lot from public.credit_lots where id = a.credit_lot_id for update;
  v_live := (lot.expired_at is null);
  select gen_credits into v_before from public.member_accounts where user_id = a.user_id for update;

  update public.order_refund_attempts set state = 'released', release_reason = p_release_reason
   where id = p_attempt_id;
  update public.credit_lots set refund_reserved = refund_reserved - a.qty where id = lot.id;
  if v_live then
    update public.member_accounts set gen_credits = gen_credits + a.qty where user_id = a.user_id;
    perform public.bp_credit_ledger_write(a.user_id, a.qty, 'refund_release',
      p_attempt_id, null, null, null, null, null, p_release_reason);
  else
    perform public.bp_credit_ledger_write(a.user_id, 0, 'refund_release',
      p_attempt_id, null, null, null, null, null, p_release_reason);
  end if;

  if p_record_admin then
    select gen_credits into v_after from public.member_accounts where user_id = a.user_id;
    insert into public.admin_actions_ledger
      (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
       before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
    values (p_admin, 'refund_release', a.user_id, a.order_uuid, v_after - v_before, a.amount,
            v_before, v_after, p_reason,
            pg_catalog.jsonb_build_object('release_reason', p_release_reason), p_attempt_id,
            public.bp_versioned_hash(pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text,
              'release_reason', p_release_reason), 1), 1);
  end if;
end;
$$;
revoke all on function public.bp_apply_attempt_release(uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role;

-- ── 외부 RPC: admin_refund_release — prepared/manual_review(pre-PG)→released(admin_cancelled_before_pg) ──
create or replace function public.admin_refund_release(p_attempt_id uuid, p_admin uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a public.order_refund_attempts;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if a.state = 'released' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if a.state <> 'prepared' then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;

  perform public.bp_apply_attempt_release(p_attempt_id, p_admin, p_reason, 'admin_cancelled_before_pg', true);
  update public.refund_requests set state = public.derive_refund_request_state(a.request_id)
    where id = a.request_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'released', 'attempt_id', p_attempt_id);
end;
$$;
revoke all on function public.admin_refund_release(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_refund_release(uuid, uuid, text) to service_role;

-- ── 외부 RPC: admin_refund_replan_pre_pg — pre-PG 해제(별도 새 request 로 재계획, §8.2) ──
create or replace function public.admin_refund_replan_pre_pg(
  p_attempt_id uuid, p_admin uuid, p_reason text, p_external boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a public.order_refund_attempts; v_reason text;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if a.state = 'released' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if a.state not in ('prepared', 'manual_review') or a.pg_requested_at is not null then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  v_reason := case when p_external then 'replanned_before_pg_external' else 'replanned_before_pg' end;

  -- 예약 복원(감사는 refund_replan 으로 별도 기록 — bp_apply_attempt_release 의 refund_release 미기록).
  perform public.bp_apply_attempt_release(p_attempt_id, p_admin, p_reason, v_reason, false);
  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
  select p_admin, 'refund_replan', a.user_id, a.order_uuid, 0, a.amount,
         ma.gen_credits, ma.gen_credits, p_reason,
         pg_catalog.jsonb_build_object('phase', 'pre_pg', 'release_reason', v_reason),
         p_attempt_id,
         public.bp_versioned_hash(pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text,
           'phase', 'pre_pg'), 1), 1
    from public.member_accounts ma where ma.user_id = a.user_id;
  update public.refund_requests set state = public.derive_refund_request_state(a.request_id)
    where id = a.request_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'released', 'release_reason', v_reason);
end;
$$;
revoke all on function public.admin_refund_replan_pre_pg(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_refund_replan_pre_pg(uuid, uuid, text, boolean) to service_role;

-- ── 외부 RPC: admin_refund_replan_after_pg — post-PG manual_review→released(fresh 증빙, §8.3) ──
create or replace function public.admin_refund_replan_after_pg(
  p_attempt_id uuid, p_admin uuid, p_reason text,
  p_observed_cancelled_amount bigint, p_observed_cancellation_ids jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a public.order_refund_attempts; v_evhash text;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if a.state = 'released' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if a.state <> 'manual_review' or a.pg_requested_at is null then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;

  v_evhash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'attempt_id', p_attempt_id::text, 'observed_cancelled_amount', p_observed_cancelled_amount,
    'observed_cancellation_ids', p_observed_cancellation_ids, 'op', 'replan_after_pg'), 1);
  -- fresh reconciliation 증빙 7필드(§8.3·G-41) — 해제 전 same UPDATE.
  update public.order_refund_attempts
     set reconciliation_verified_at = clock_timestamp(), reconciliation_result = 'no_movement',
         observed_cancelled_amount = p_observed_cancelled_amount,
         observed_cancellation_ids = coalesce(p_observed_cancellation_ids, '[]'::jsonb),
         verification_source = 'admin_reconcile', verified_by = p_admin,
         evidence_hash = v_evhash, evidence_hash_version = 1, last_reconciled_at = clock_timestamp()
   where id = p_attempt_id;

  update public.payment_cancellation_events
     set resolution_state = 'ignored', resolved_at = now(), resolution_source = 'system', resolved_by = null
   where order_uuid = a.order_uuid and status = 'FAILED' and resolution_state = 'unmatched';

  perform public.bp_apply_attempt_release(p_attempt_id, p_admin, p_reason,
    'replanned_after_pg_reconciliation', false);

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
  select p_admin, 'refund_replan', a.user_id, a.order_uuid, 0, a.amount,
         ma.gen_credits, ma.gen_credits, p_reason,
         pg_catalog.jsonb_build_object('phase', 'post_pg', 'evidence_hash', v_evhash),
         p_attempt_id,
         public.bp_versioned_hash(pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text,
           'phase', 'post_pg'), 1), 1
    from public.member_accounts ma where ma.user_id = a.user_id;

  update public.refund_requests set state = public.derive_refund_request_state(a.request_id)
    where id = a.request_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'released',
    'release_reason', 'replanned_after_pg_reconciliation');
end;
$$;
revoke all on function public.admin_refund_replan_after_pg(uuid, uuid, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_refund_replan_after_pg(uuid, uuid, text, bigint, jsonb) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- cancel intent(§4.8·§4.9)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 외부 RPC: cancel_intent_begin — orders 4필드 set-once 기록 + cancel_intent 감사(멱등) ──
create or replace function public.cancel_intent_begin(
  p_admin uuid, p_order_uuid uuid, p_customer_requested_at timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare o public.orders; v_created timestamptz;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_customer_requested_at > clock_timestamp() + interval '5 minutes' then raise exception 'cra_future' using errcode = 'P0001'; end if;
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;

  if o.cancel_intent_created_at is not null then
    -- 멱등(§4.9): 이미 기록됨 → UPDATE 생략(no-op version 증가 회피).
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true,
      'order_version', o.version);
  end if;

  v_created := clock_timestamp();
  update public.orders
     set cancel_requested_at = p_customer_requested_at, cancel_requested_by = o.user_id,
         cancel_intent_created_at = v_created, cancel_intent_reason = p_reason
   where order_uuid = p_order_uuid;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, payload_hash, payload_hash_version)
  select p_admin, 'cancel_intent', o.user_id, p_order_uuid, 0, o.amount,
         ma.gen_credits, ma.gen_credits, p_reason,
         pg_catalog.jsonb_build_object('customer_requested_at', p_customer_requested_at,
           'cancel_intent_created_at', v_created),
         public.bp_versioned_hash(pg_catalog.jsonb_build_object('order_uuid', p_order_uuid::text,
           'op', 'cancel_intent'), 1), 1
    from public.member_accounts ma where ma.user_id = o.user_id;

  select version into o.version from public.orders where order_uuid = p_order_uuid;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'intent_recorded', 'order_version', o.version);
end;
$$;
revoke all on function public.cancel_intent_begin(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.cancel_intent_begin(uuid, uuid, timestamptz, text) to service_role;

-- ── 외부 RPC: cancel_intent_resolve — intent → scoped cancel_intent-origin 환불 request+attempt 개시 ──
create or replace function public.cancel_intent_resolve(p_admin uuid, p_order_uuid uuid, p_qty int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders; lot public.credit_lots;
  v_request uuid := gen_random_uuid(); v_attempt uuid := gen_random_uuid();
  v_avail int; v_rate int; v_amount bigint; v_remaining_cash bigint; v_live boolean;
  v_payload_hash text; v_plan_hash text; v_approved_hash text;
begin
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.cancel_intent_created_at is null then raise exception 'no_cancel_intent' using errcode = 'P0001'; end if;
  if o.paid_at is null then raise exception 'order_not_paid' using errcode = 'P0001'; end if;

  perform 1 from public.member_accounts where user_id = o.user_id for update;
  select * into lot from public.credit_lots where order_uuid = p_order_uuid and source = 'purchase' for update;
  if not found then raise exception 'purchase_lot_not_found' using errcode = 'P0001'; end if;
  v_live := (lot.expired_at is null);
  v_avail := lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
  if p_qty <= 0 or p_qty > v_avail then raise exception 'qty_exceeds_available' using errcode = 'P0001'; end if;
  if p_qty > (o.credits - o.refunded_credits) then raise exception 'qty_exceeds_order_remaining' using errcode = 'P0001'; end if;

  v_remaining_cash := o.amount - o.refunded_amount;
  if v_remaining_cash <= 0 then raise exception 'nothing_to_refund' using errcode = 'P0001'; end if;
  v_rate := public.bp_refund_rate_bps(o.cancel_requested_at, o.paid_at);
  v_amount := public.bp_refund_amount(o.amount, o.credits, p_qty, v_rate, v_remaining_cash);
  if v_amount <= 0 then raise exception 'amount_nonpositive' using errcode = 'P0001'; end if;

  v_payload_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'op', 'cancel_intent_resolve', 'order_uuid', p_order_uuid::text, 'qty', p_qty), 1);
  v_plan_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid::text, 'lot_id', lot.id::text, 'qty', p_qty, 'amount', v_amount,
    'rate_bps', v_rate, 'paid_at_snapshot', o.paid_at, 'order_amount_snapshot', o.amount,
    'order_credits_snapshot', o.credits, 'expected_refunded_credits_before', o.refunded_credits,
    'expected_refunded_amount_before', o.refunded_amount), 1);
  v_approved_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'requested_qty', p_qty, 'approved_amount', v_amount, 'plan_hash', v_plan_hash), 1);

  insert into public.refund_requests
    (id, user_id, admin_user_id, origin, scope_order_uuid, requested_qty,
     customer_requested_at, reason, payload_hash, payload_hash_version, state)
  values (v_request, o.user_id, p_admin, 'cancel_intent', p_order_uuid, p_qty,
          o.cancel_requested_at, o.cancel_intent_reason, v_payload_hash, 1, 'building');

  begin
    insert into public.order_refund_attempts
      (id, request_id, sequence, order_uuid, user_id, credit_lot_id, admin_user_id, reason, qty, amount,
       rail, state, rate_bps, policy_as_of, refund_deadline, paid_at_snapshot,
       order_amount_snapshot, order_credits_snapshot, expected_refunded_credits_before,
       expected_refunded_amount_before, plan_hash, plan_hash_version)
    values (v_attempt, v_request, 1, p_order_uuid, o.user_id, lot.id, p_admin, o.cancel_intent_reason,
            p_qty, v_amount, 'portone_cancel', 'prepared', v_rate, clock_timestamp(),
            o.paid_at + interval '5 years', o.paid_at, o.amount, o.credits, o.refunded_credits,
            o.refunded_amount, v_plan_hash, 1);
  exception when unique_violation then
    raise exception 'order_has_open_refund' using errcode = 'P0001';
  end;

  update public.credit_lots set refund_reserved = refund_reserved + p_qty where id = lot.id;
  if v_live then
    update public.member_accounts set gen_credits = gen_credits - p_qty where user_id = o.user_id;
    perform public.bp_credit_ledger_write(o.user_id, -p_qty, 'refund_reserve', v_attempt, null, null, null, null, null, null);
  else
    perform public.bp_credit_ledger_write(o.user_id, 0, 'refund_reserve', v_attempt, null, null, null, null, null, null);
  end if;

  update public.refund_requests
     set state = 'prepared', approved_plan_hash = v_approved_hash, approved_plan_hash_version = 1,
         approved_amount = v_amount
   where id = v_request;

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'prepared', 'request_id', v_request,
    'attempt_id', v_attempt, 'qty', p_qty, 'amount', v_amount);
end;
$$;
revoke all on function public.cancel_intent_resolve(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.cancel_intent_resolve(uuid, uuid, int) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 외부취소 resolver(§9·§14)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── core: 단일 event 화해 적용(회수·shortfall·원장·event resolution). mapping 은 로트 상태로 산출. ──
create or replace function public.bp_apply_external_resolution(
  p_cancellation_id text, p_resolved_by uuid, p_economic_qty int, p_batch_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  ev public.payment_cancellation_events;
  o public.orders; lot public.credit_lots;
  v_avail int; v_immediate int; v_shortfall int; v_live_recovered int; v_lot_live boolean;
  v_mapping jsonb;
begin
  select * into ev from public.payment_cancellation_events where cancellation_id = p_cancellation_id for update;
  if ev.cancellation_id is null then raise exception 'event_not_found' using errcode = 'P0001'; end if;
  if ev.resolution_state <> 'unmatched' or ev.status <> 'SUCCEEDED' or ev.origin <> 'live' then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  select * into o from public.orders where order_uuid = ev.order_uuid for update;
  perform 1 from public.member_accounts where user_id = o.user_id for update;
  select * into lot from public.credit_lots where order_uuid = ev.order_uuid and source = 'purchase' for update;
  if lot.id is null then raise exception 'purchase_lot_not_found' using errcode = 'P0001'; end if;

  v_lot_live := (lot.expired_at is null);
  v_avail := lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
  if p_economic_qty > (o.credits - o.refunded_credits) then
    raise exception 'economic_exceeds_remaining' using errcode = 'P0001';
  end if;
  v_immediate := least(p_economic_qty, v_avail);
  v_shortfall := p_economic_qty - v_immediate;
  v_live_recovered := case when v_lot_live then v_immediate else 0 end;

  -- 회수 반영: lot.refunded += immediate, live 면 캐시 −live_recovered.
  if v_immediate > 0 then
    update public.credit_lots set refunded = refunded + v_immediate where id = lot.id;
  end if;
  if v_live_recovered > 0 then
    update public.member_accounts set gen_credits = gen_credits - v_live_recovered where user_id = o.user_id;
  end if;
  -- shortfall 행(부족 > 0 만).
  if v_shortfall > 0 then
    insert into public.credit_refund_shortfalls
      (source_type, source_attempt_id, source_cancellation_id, order_uuid, lot_id,
       mapped_qty, recovered_qty, initial_shortfall_qty, remaining_shortfall_qty, state)
    values ('external_cancellation', null, p_cancellation_id, ev.order_uuid, lot.id,
            p_economic_qty, 0, v_shortfall, v_shortfall, 'open');
  end if;

  -- orders 갱신(수량+금액).
  update public.orders
     set refunded_credits = o.refunded_credits + p_economic_qty,
         refunded_amount = o.refunded_amount + ev.amount
   where order_uuid = o.order_uuid;

  -- refund_commit(외부취소형) 원장.
  perform public.bp_credit_ledger_write(o.user_id, -v_live_recovered, 'refund_commit',
    null, p_cancellation_id, null, null, null,
    pg_catalog.jsonb_build_object('mapped_qty', p_economic_qty, 'immediate_recovered_qty', v_immediate,
      'shortfall_qty', v_shortfall, 'live_recovered_qty', v_live_recovered), null);

  -- event resolution(set-once 매핑·경제수량·batch).
  v_mapping := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'lot_id', lot.id::text, 'mapped_qty', p_economic_qty, 'immediate_recovered_qty', v_immediate,
    'shortfall_qty', v_shortfall, 'lot_was_live', v_lot_live));
  update public.payment_cancellation_events
     set resolution_state = 'resolved', resolved_at = now(),
         resolution_source = case when p_resolved_by is null then 'system' else 'admin' end,
         resolved_by = p_resolved_by, resolved_economic_qty = p_economic_qty,
         resolved_lot_mappings = v_mapping, resolution_batch_id = p_batch_id
   where cancellation_id = p_cancellation_id;

  return pg_catalog.jsonb_build_object('economic_qty', p_economic_qty, 'immediate', v_immediate,
    'shortfall', v_shortfall, 'live_recovered', v_live_recovered);
end;
$$;
revoke all on function public.bp_apply_external_resolution(text, uuid, int, uuid)
  from public, anon, authenticated, service_role;

-- ── 외부 RPC: resolve_external_cancellation — 관리자/시스템 단건 화해 ──
create or replace function public.resolve_external_cancellation(
  p_cancellation_id text, p_resolved_by uuid, p_note text, p_economic_qty int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare ev public.payment_cancellation_events; o public.orders; v_res jsonb; v_econ int;
begin
  select * into ev from public.payment_cancellation_events where cancellation_id = p_cancellation_id;
  if ev.cancellation_id is null then raise exception 'event_not_found' using errcode = 'P0001'; end if;
  -- 멱등: 이미 resolved 면 동일 economic 재요청 no_op, 상이면 conflict.
  if ev.resolution_state = 'resolved' then
    if ev.resolved_economic_qty = p_economic_qty then
      return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  select * into o from public.orders where order_uuid = ev.order_uuid;
  v_econ := coalesce(p_economic_qty,
    least(floor(ev.amount::numeric * o.credits / o.amount)::int, o.credits - o.refunded_credits));

  v_res := public.bp_apply_external_resolution(p_cancellation_id, p_resolved_by, v_econ, null);

  -- admin 화해만 감사 기록(system 은 미기록, §A.4.4).
  if p_resolved_by is not null then
    if char_length(coalesce(p_note, '')) < 5 or char_length(p_note) > 500 then raise exception 'note_invalid' using errcode = 'P0001'; end if;
    insert into public.admin_actions_ledger
      (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
       before_credits, after_credits, reason, metadata, ref_cancellation_id, payload_hash, payload_hash_version)
    select p_resolved_by, 'resolve_external_cancellation', o.user_id, o.order_uuid,
           ma.gen_credits - (ma.gen_credits + (v_res->>'live_recovered')::int), ev.amount,
           ma.gen_credits + (v_res->>'live_recovered')::int, ma.gen_credits, p_note,
           pg_catalog.jsonb_build_object('economic_qty', v_econ,
             'recovered_qty', (v_res->>'immediate')::int, 'shortfall_qty', (v_res->>'shortfall')::int, 'note', p_note),
           p_cancellation_id,
           public.bp_versioned_hash(pg_catalog.jsonb_build_object('cancellation_id', p_cancellation_id,
             'economic_qty', v_econ), 1), 1
      from public.member_accounts ma where ma.user_id = o.user_id;
  end if;

  -- 이 이벤트를 가리키던 open unmatched_cancellation issue 자동 해소(같은 트랜잭션 — 큐 정확성).
  update public.reconciliation_issues i
     set state = 'resolved', resolved_at = now(),
         resolution_source = case when p_resolved_by is null then 'system' else 'admin' end,
         resolved_by = p_resolved_by,
         detail = coalesce(i.detail, '{}'::jsonb)
                  || pg_catalog.jsonb_build_object('resolution_note', 'event_resolved:' || p_cancellation_id)
   where i.cancellation_id = p_cancellation_id and i.type = 'unmatched_cancellation' and i.state = 'open';

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'resolved', 'result', v_res);
end;
$$;
revoke all on function public.resolve_external_cancellation(text, uuid, text, int) from public, anon, authenticated;
grant execute on function public.resolve_external_cancellation(text, uuid, text, int) to service_role;

-- ── 외부 RPC: resolve_external_cancellation_auto_full — §14 system 전액 자동 종결 배치 ──
create or replace function public.resolve_external_cancellation_auto_full(p_order_uuid uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  v_total bigint; v_count int; v_committed int; v_batch uuid;
  v_remaining int; v_alloc int; v_assigned int := 0; ev record; v_hash text;
begin
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;

  -- eligibility(§14·§9.3): 전 event SUCCEEDED·live·unmatched, 합=amount, refunded 0, committed 0, intent 존재.
  select coalesce(sum(amount), 0), count(*) into v_total, v_count
    from public.payment_cancellation_events
   where order_uuid = p_order_uuid and origin = 'live';
  select count(*) into v_committed from public.order_refund_attempts
   where order_uuid = p_order_uuid and state = 'committed';

  if v_count = 0
     or exists (select 1 from public.payment_cancellation_events
                 where order_uuid = p_order_uuid and origin = 'live'
                   and (status <> 'SUCCEEDED' or resolution_state <> 'unmatched'))
     or v_total <> o.amount or o.refunded_amount <> 0 or o.refunded_credits <> 0
     or v_committed <> 0 or o.cancel_intent_created_at is null then
    v_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object('order_uuid', p_order_uuid::text,
      'eligible', false), 1);
    insert into public.cancellation_resolution_batches
      (order_uuid, order_amount_snapshot, order_credits_snapshot, pre_refunded_amount, pre_refunded_credits,
       pre_committed_count, pre_legacy_contribution, had_cancel_intent, total_succeeded_amount,
       cancellation_projection, eligibility_result, eligibility_hash, eligibility_hash_version, resolved_at)
    values (p_order_uuid, o.amount, o.credits, o.refunded_amount, o.refunded_credits, v_committed, 0,
            o.cancel_intent_created_at is not null, v_total, '[]'::jsonb, 'ineligible', v_hash, 1, null);
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'ineligible');
  end if;

  v_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object('order_uuid', p_order_uuid::text,
    'total', v_total, 'credits', o.credits, 'eligible', true), 1);
  insert into public.cancellation_resolution_batches
    (order_uuid, order_amount_snapshot, order_credits_snapshot, pre_refunded_amount, pre_refunded_credits,
     pre_committed_count, pre_legacy_contribution, had_cancel_intent, total_succeeded_amount,
     cancellation_projection, eligibility_result, eligibility_hash, eligibility_hash_version, resolved_at)
  select p_order_uuid, o.amount, o.credits, 0, 0, 0, 0, true, v_total,
         coalesce((select jsonb_agg(jsonb_build_object('cancellation_id', cancellation_id, 'amount', amount))
                     from public.payment_cancellation_events
                    where order_uuid = p_order_uuid and origin = 'live'), '[]'::jsonb),
         'eligible', v_hash, 1, now()
  returning id into v_batch;

  -- 배분: floor(event.amount*credits/total) base 합 → 잔여 credits 를 fractional 내림차순으로 1씩 가산.
  select coalesce(sum(floor(amount::numeric * o.credits / v_total)::int), 0) into v_assigned
    from public.payment_cancellation_events where order_uuid = p_order_uuid and origin = 'live';
  v_remaining := o.credits - v_assigned;   -- 분배할 잔여 credits(fractional 내림차순·requested_at asc·id asc)

  for ev in
    select cancellation_id,
           floor(amount::numeric * o.credits / v_total)::int as base_alloc,
           row_number() over (
             order by (amount::numeric * o.credits / v_total) - floor(amount::numeric * o.credits / v_total) desc,
                      requested_at asc nulls last, cancellation_id asc) as rn
      from public.payment_cancellation_events
     where order_uuid = p_order_uuid and origin = 'live'
     order by rn
  loop
    v_alloc := ev.base_alloc + case when ev.rn <= v_remaining then 1 else 0 end;
    perform public.bp_apply_external_resolution(ev.cancellation_id, null, v_alloc, v_batch);
  end loop;

  -- 전액 자동 종결 완료 — strict CHECK 등식(refunded_amount=amount·refunded_credits=credits) 충족 상태에서
  -- 주문을 canceled 로 종단(§14·§17 CANCELLED 행). 이 전이로 배치 종결이 어드민 목록에서도 종결로 보인다.
  update public.orders
     set status = 'canceled', canceled_at = coalesce(canceled_at, now())
   where order_uuid = p_order_uuid and status <> 'canceled';

  -- 종결된 이벤트들의 open unmatched_cancellation issue 자동 해소(있다면 — system).
  update public.reconciliation_issues i
     set state = 'resolved', resolved_at = now(), resolution_source = 'system', resolved_by = null,
         detail = coalesce(i.detail, '{}'::jsonb)
                  || pg_catalog.jsonb_build_object('resolution_note', 'auto_full_batch:' || v_batch::text)
   where i.order_uuid = p_order_uuid and i.type = 'unmatched_cancellation' and i.state = 'open';

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'resolved_full', 'batch_id', v_batch,
    'events', v_count);
end;
$$;
revoke all on function public.resolve_external_cancellation_auto_full(uuid) from public, anon, authenticated;
grant execute on function public.resolve_external_cancellation_auto_full(uuid) to service_role;

-- ── 외부 RPC: admin_resolve_reconciliation_issue — open→resolved/ignored(관리자/시스템) ──
create or replace function public.admin_resolve_reconciliation_issue(
  p_issue_id uuid, p_admin uuid, p_resolution text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare i public.reconciliation_issues; ev public.payment_cancellation_events;
begin
  if p_resolution not in ('resolved', 'ignored') then raise exception 'resolution_invalid' using errcode = 'P0001'; end if;
  if char_length(coalesce(p_note, '')) < 5 or char_length(p_note) > 500 then
    raise exception 'note_invalid' using errcode = 'P0001';
  end if;
  select * into i from public.reconciliation_issues where id = p_issue_id for update;
  if not found then raise exception 'issue_not_found' using errcode = 'P0001'; end if;
  if i.state <> 'open' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;

  -- ignore 제한(§resolve-issue 계약): 자금 이동 증빙(SUCCEEDED)·진행형(REQUESTED) unmatched event 는
  -- ignore 불가 — 경제 해소(resolve_external_cancellation)가 선행돼야 한다. 확정 무이동(FAILED) event 는
  -- 같은 트랜잭션에서 issue 와 원자 ignored.
  if i.cancellation_id is not null then
    select * into ev from public.payment_cancellation_events
     where cancellation_id = i.cancellation_id for update;
    if ev.cancellation_id is not null and ev.resolution_state = 'unmatched' then
      if p_resolution = 'ignored' then
        if ev.status <> 'FAILED' then
          raise exception 'event_requires_resolution' using errcode = 'P0001';
        end if;
        update public.payment_cancellation_events
           set resolution_state = 'ignored', resolved_at = now(),
               resolution_source = 'admin', resolved_by = p_admin
         where cancellation_id = i.cancellation_id;
      else
        -- resolved 는 이벤트가 이미 종단(resolved/matched/ignored)된 뒤에만 — 미종단이면 순서 위반.
        raise exception 'event_still_unmatched' using errcode = 'P0001';
      end if;
    end if;
  end if;

  update public.reconciliation_issues
     set state = p_resolution, resolved_at = now(), resolved_by = p_admin, resolution_source = 'admin',
         detail = coalesce(i.detail, '{}'::jsonb) || pg_catalog.jsonb_build_object('resolution_note', p_note)
   where id = p_issue_id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', p_resolution);
end;
$$;
revoke all on function public.admin_resolve_reconciliation_issue(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_resolve_reconciliation_issue(uuid, uuid, text, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 관리자 운영·유지보수·조회 RPC (기존 시그니처 v2 재정의 — 로트 정합 유지)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── admin_adjust_credits v2 — 캐시 조정과 로트 동기(양수=cs_grant 로트·음수=live 로트 consumed 가산) ──
create or replace function public.admin_adjust_credits(p_admin uuid, p_target uuid, p_delta int, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before int; v_after int; v_apply int; v_remaining int; v_take int; lot record;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_delta < -100 or p_delta > 100 or p_delta = 0 then raise exception 'delta_invalid' using errcode = 'P0001'; end if;

  select gen_credits into v_before from public.member_accounts where user_id = p_target for update;
  if not found then raise exception 'member_not_found' using errcode = 'P0001'; end if;

  if p_delta > 0 then
    insert into public.credit_lots (user_id, source, order_uuid, qty, granted_at, expires_at)
    values (p_target, 'cs_grant', null, p_delta, now(), now() + interval '1 year');
    update public.member_accounts set gen_credits = gen_credits + p_delta
      where user_id = p_target returning gen_credits into v_after;
  else
    v_apply := least(-p_delta, v_before);   -- 0 클램프
    v_remaining := v_apply;
    for lot in
      select id, (qty - consumed - refunded - refund_reserved) as avail
        from public.credit_lots
       where user_id = p_target and expired_at is null
         and (qty - consumed - refunded - refund_reserved) > 0
       order by expires_at asc, granted_at asc, id asc for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, lot.avail);
      update public.credit_lots set consumed = consumed + v_take where id = lot.id;
      v_remaining := v_remaining - v_take;
    end loop;
    update public.member_accounts set gen_credits = greatest(0, gen_credits - v_apply)
      where user_id = p_target returning gen_credits into v_after;
  end if;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason)
  values (p_admin, 'cs_adjust', p_target, null, v_after - v_before, null, v_before, v_after, p_reason);
  return pg_catalog.jsonb_build_object('ok', true, 'before', v_before, 'after', v_after, 'applied', v_after - v_before);
end;
$$;
revoke all on function public.admin_adjust_credits(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_credits(uuid, uuid, int, text) to service_role;

-- ── admin_cancel_order v2 — pending 만 직접 취소. paid 취소는 환불 saga/외부취소 resolver 로(불변식 보존). ──
create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text, p_pg_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare o public.orders; v_bal int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status = 'failed' then raise exception 'not_cancelable' using errcode = 'P0001'; end if;
  if o.status = 'canceled' then raise exception 'already_canceled' using errcode = 'P0001'; end if;
  if o.paid_at is not null then
    -- v2: paid 주문의 취소·환불은 saga/외부취소 resolver 가 소유(refunded_* 분해 불변식 보존).
    raise exception 'use_refund_saga' using errcode = 'P0001';
  end if;

  update public.orders set status = 'canceled', canceled_at = now() where order_uuid = p_order_uuid;
  select gen_credits into v_bal from public.member_accounts where user_id = o.user_id;
  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata)
  values (p_admin, 'cancel_refund', o.user_id, p_order_uuid, 0, o.amount,
          coalesce(v_bal, 0), coalesce(v_bal, 0), p_reason,
          pg_catalog.jsonb_build_object('pg_done', p_pg_done, 'shortfall', 0, 'reconciled', false));
  return pg_catalog.jsonb_build_object('ok', true, 'clawback', 0, 'shortfall', 0,
    'before', v_bal, 'after', v_bal);
end;
$$;
create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.admin_cancel_order(p_admin, p_order_uuid, p_clawback, p_reason, false);
$$;
revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) to service_role;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text) to service_role;

-- ── admin_soft_delete_account v2(§39) — open refund/issue 차단 → live 로트 quarantine·캐시 0·금융 보존 ──
create or replace function public.admin_soft_delete_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare lot record; v_avail int;
begin
  -- open refund attempt/request → 409.
  if exists (select 1 from public.order_refund_attempts
              where user_id = p_user_id
                and state in ('prepared','pg_requested','pg_pending','pg_succeeded','manual_pending','manual_review')) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.refund_requests
              where user_id = p_user_id and state in ('building','prepared','processing','blocked')) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  -- open 의무 이슈 → 409.
  if exists (select 1 from public.reconciliation_issues i
              where i.user_id = p_user_id and i.state = 'open'
                and i.type in ('economic_over_refund','manual_pg_cancel','unmatched_cancellation')) then
    raise exception 'open_issue_blocks_delete' using errcode = 'P0001';
  end if;

  -- live 로트 quarantine(account_deleted) + 캐시 회수 + expire 원장.
  for lot in
    select id, (qty - consumed - refunded - refund_reserved) as avail
      from public.credit_lots where user_id = p_user_id and expired_at is null for update
  loop
    update public.credit_lots set expired_at = now(), expiration_reason = 'account_deleted' where id = lot.id;
    if lot.avail > 0 then
      update public.member_accounts set gen_credits = gen_credits - lot.avail where user_id = p_user_id;
    end if;
    perform public.bp_credit_ledger_write(p_user_id, -lot.avail, 'expire',
      null, null, lot.id, null, null, null, 'account_deleted');
  end loop;

  update public.profiles
     set deleted_at = coalesce(deleted_at, now()), display_name = '탈퇴한 사용자', avatar_url = null
   where id = p_user_id;
  update public.member_accounts set email = null, gen_credits = 0 where user_id = p_user_id;
  delete from public.dolls where owner_id = p_user_id;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.admin_soft_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.admin_soft_delete_account(uuid) to service_role;

-- ── sweep_expired — 자연 만료 로트 회수(expires_at 경과·live). cron credit-expire 호출. ──
create or replace function public.sweep_expired(p_limit int default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare lot record; v_count int := 0; v_avail int;
begin
  for lot in
    select id, user_id, (qty - consumed - refunded - refund_reserved) as avail
      from public.credit_lots
     where expired_at is null and expires_at <= now()
     order by expires_at asc
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update
  loop
    update public.credit_lots set expired_at = now(), expiration_reason = 'natural' where id = lot.id;
    if lot.avail > 0 then
      update public.member_accounts set gen_credits = gen_credits - lot.avail where user_id = lot.user_id;
    end if;
    perform public.bp_credit_ledger_write(lot.user_id, -lot.avail, 'expire',
      null, null, lot.id, null, null, null, 'natural');
    v_count := v_count + 1;
  end loop;
  return pg_catalog.jsonb_build_object('ok', true, 'expired', v_count);
end;
$$;
revoke all on function public.sweep_expired(int) from public, anon, authenticated;
grant execute on function public.sweep_expired(int) to service_role;

-- ── ops_cron_heartbeat(§29) — cron 실행 심박 기록(start/success/failure) ──
create or replace function public.ops_cron_heartbeat(p_job text, p_phase text, p_error_code text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job not in ('credit-expire', 'reconcile') then raise exception 'invalid_job' using errcode = 'P0001'; end if;
  if p_phase not in ('start', 'success', 'failure') then raise exception 'invalid_phase' using errcode = 'P0001'; end if;
  insert into public.ops_cron_heartbeats (job_name, last_started_at, run_count)
  values (p_job, case when p_phase = 'start' then now() end, case when p_phase = 'start' then 1 else 0 end)
  on conflict (job_name) do update set
    last_started_at   = case when p_phase = 'start'   then now() else public.ops_cron_heartbeats.last_started_at end,
    last_succeeded_at = case when p_phase = 'success' then now() else public.ops_cron_heartbeats.last_succeeded_at end,
    last_failed_at    = case when p_phase = 'failure' then now() else public.ops_cron_heartbeats.last_failed_at end,
    last_error_code   = case when p_phase = 'failure' then p_error_code else public.ops_cron_heartbeats.last_error_code end,
    run_count         = public.ops_cron_heartbeats.run_count + case when p_phase = 'start' then 1 else 0 end;
end;
$$;
revoke all on function public.ops_cron_heartbeat(text, text, text) from public, anon, authenticated;
grant execute on function public.ops_cron_heartbeat(text, text, text) to service_role;

-- ── get_my_credits — 회원 캐시 + live 로트 요약(회원 본인 서버 조회) ──
create or replace function public.get_my_credits(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'gen_credits', coalesce((select gen_credits from public.member_accounts where user_id = p_user), 0),
    'live_lots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lot_id', l.id, 'source', l.source, 'available', l.qty - l.consumed - l.refunded - l.refund_reserved,
        'expires_at', l.expires_at) order by l.expires_at asc)
        from public.credit_lots l
       where l.user_id = p_user and l.expired_at is null
         and (l.qty - l.consumed - l.refunded - l.refund_reserved) > 0), '[]'::jsonb));
$$;
revoke all on function public.get_my_credits(uuid) from public, anon, authenticated;
grant execute on function public.get_my_credits(uuid) to service_role;

-- ── get_admin_order_summary v2 — net revenue = Σ greatest(amount − refunded_amount, 0) ──
create or replace function public.get_admin_order_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with k as (
    select (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as today_start
  )
  select pg_catalog.jsonb_build_object(
    'revenue_today', coalesce((select sum(greatest(amount - refunded_amount, 0)) from public.orders, k
                                where paid_at is not null and not is_test and paid_at >= k.today_start), 0),
    'revenue_7d',    coalesce((select sum(greatest(amount - refunded_amount, 0)) from public.orders, k
                                where paid_at is not null and not is_test and paid_at >= k.today_start - interval '6 days'), 0),
    'revenue_30d',   coalesce((select sum(greatest(amount - refunded_amount, 0)) from public.orders, k
                                where paid_at is not null and not is_test and paid_at >= k.today_start - interval '29 days'), 0),
    'orders_today',  (select count(*) from public.orders, k where created_at >= k.today_start),
    'orders_7d',     (select count(*) from public.orders, k where created_at >= k.today_start - interval '6 days'),
    'orders_30d',    (select count(*) from public.orders, k where created_at >= k.today_start - interval '29 days'),
    'first_purchase', (select count(distinct user_id) from public.orders where paid_at is not null and not is_test),
    'by_status',     coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from public.orders group by status) s), '{}'::jsonb)
  );
$$;
revoke all on function public.get_admin_order_summary() from public, anon, authenticated;
grant execute on function public.get_admin_order_summary() to service_role;

-- ── admin_settle_stuck_order v2 — 수동 지급을 로트 생성 + v2 원장으로(서명 유지). ──
--   (0058 본문은 member 캐시 직접 가산 + schema_version=1 원장이라 v2 가드/불변식에 위배 → 재정의 필수.)
create or replace function public.admin_settle_stuck_order(p_admin uuid, p_order_uuid uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare o public.orders; v_before int; v_after int; v_lot uuid; v_paid_at timestamptz;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status not in ('pending', 'failed') or (o.pg_tx_id is null and o.payment_id is null) then
    raise exception 'not_settleable' using errcode = 'P0001';
  end if;

  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found' using errcode = 'P0001'; end if;

  v_paid_at := now();   -- 수동 복구: 운영자 확인 시각. (financial guard 가 이후 불변 보장.)
  update public.orders set status = 'paid', paid_at = v_paid_at, pg_status = 'PAID', error_message = null
    where order_uuid = p_order_uuid and status = o.status;
  if not found then raise exception 'status_changed' using errcode = 'P0001'; end if;

  update public.member_accounts set gen_credits = gen_credits + o.credits
    where user_id = o.user_id returning gen_credits into v_after;
  insert into public.credit_lots (user_id, source, order_uuid, qty, granted_at, expires_at)
  values (o.user_id, 'purchase', o.order_uuid, o.credits, v_paid_at, v_paid_at + interval '1 year')
  returning id into v_lot;
  perform public.bp_credit_ledger_write(o.user_id, o.credits, 'purchase',
    null, null, null, null, p_order_uuid, null, o.product_id || ' (settle)');

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason)
  values (p_admin, 'settle_stuck', o.user_id, p_order_uuid, o.credits, o.amount, v_before, v_after, p_reason);
  return pg_catalog.jsonb_build_object('ok', true, 'before', v_before, 'after', v_after, 'credits', o.credits);
end;
$$;
revoke all on function public.admin_settle_stuck_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_settle_stuck_order(uuid, uuid, text) to service_role;

-- ── 외부 RPC: create_or_update_member_consent v2(0041 재정의 — 불변식 1 보존) ──
--   신규 회원 insert 의 가입 보너스가 signup_bonus 로트와 원자 동기(캐시 ≡ Σ live 로트, Q1/G-1).
--   시그니처·반환(boolean)·호출부(app/api/account/consent·app/api/admin/reviewers) 불변.
--   credit_ledger 미기록(v1 동작 유지 — cs_grant 와 동일하게 로트·동의 스탬프가 감사 근거).
create or replace function public.create_or_update_member_consent(
  p_user_id     uuid,
  p_bonus       int,
  p_set_age     boolean,
  p_set_terms   boolean,
  p_terms_ver   int,
  p_set_privacy boolean,
  p_privacy_ver int
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now   timestamptz := now();
  v_rows  int;
  v_bonus int := greatest(coalesce(p_bonus, 0), 0);
begin
  -- 검증: 유효·비탈퇴 프로필만(0041 동일).
  if not exists (
    select 1 from public.profiles where id = p_user_id and deleted_at is null
  ) then
    raise exception 'invalid_account';
  end if;

  -- 원자적 신규 insert(보너스 + 필요 항목 stamp). 충돌(기존 회원) 시 아무것도 안 함.
  insert into public.member_accounts (
    user_id, gen_credits,
    age_confirmed_at,
    terms_agreed_at, terms_version,
    privacy_agreed_at, privacy_version
  ) values (
    p_user_id, v_bonus,
    case when p_set_age     then v_now else null end,
    case when p_set_terms   then v_now       else null end,
    case when p_set_terms   then p_terms_ver else null end,
    case when p_set_privacy then v_now        else null end,
    case when p_set_privacy then p_privacy_ver else null end
  )
  on conflict (user_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    -- 신규 insert = 보너스 지급 시점 — signup_bonus 로트를 같은 트랜잭션에서 생성(불변식 1).
    if v_bonus > 0 then
      insert into public.credit_lots (user_id, source, order_uuid, qty, granted_at, expires_at)
      values (p_user_id, 'signup_bonus', null, v_bonus, v_now, v_now + interval '1 year');
    end if;
    return true;  -- 실제 신규 insert(보너스 지급) → 라우트가 익명이전·프로필 시드 수행
  end if;

  -- 기존 row: 필요한 항목만 갱신(보너스·이전 없음, 0041 동일).
  update public.member_accounts set
    age_confirmed_at   = case when p_set_age and age_confirmed_at is null then v_now else age_confirmed_at end,
    terms_agreed_at    = case when p_set_terms   then v_now        else terms_agreed_at end,
    terms_version      = case when p_set_terms   then p_terms_ver  else terms_version end,
    privacy_agreed_at  = case when p_set_privacy then v_now         else privacy_agreed_at end,
    privacy_version    = case when p_set_privacy then p_privacy_ver else privacy_version end,
    reconsent_required = false,
    updated_at         = v_now
  where user_id = p_user_id;

  return false;
end;
$$;
revoke all on function public.create_or_update_member_consent(uuid, int, boolean, boolean, int, boolean, int)
  from public, anon, authenticated;
grant execute on function public.create_or_update_member_consent(uuid, int, boolean, boolean, int, boolean, int)
  to service_role;

-- ── 외부 RPC: record_payment_cancellation_observation — 외부 관측 취소 이벤트 영속(웹훅/폴링/reconcile) ──
--   §5·§11: 종단 status(SUCCEEDED·FAILED)만 행 생성(REQUESTED 는 진행형 — 미영속), 미인식 status 는 행 금지.
--   멱등: 동일 id 재관측(동일 order/amount/status)=no_op. 재관측 불일치=event 형 cancellation_discrepancy issue
--   (가짜 event 생성 금지 — 기존 행 불변). SUCCEEDED 신규 이벤트가 marker(BP_REFUND:<attempt-uuid>)로
--   자기 귀속 가능한 open attempt 가 없으면 unmatched_cancellation issue open(멱등).
create or replace function public.record_payment_cancellation_observation(
  p_order_uuid uuid, p_cancellation_id text, p_status text,
  p_amount bigint, p_requested_at timestamptz, p_cancelled_at timestamptz, p_raw jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  ev public.payment_cancellation_events;
  v_issue uuid;
  v_marker_attempt uuid;
  v_self_attributed boolean := false;
begin
  if p_status not in ('REQUESTED', 'SUCCEEDED', 'FAILED') then
    -- 미인식/진행 외 status 는 이벤트를 만들지 않는다(§5 — fail-closed 관측).
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'unknown_status_ignored');
  end if;
  if p_status = 'REQUESTED' then
    -- 진행형은 미영속(§B.9.3 — event 는 최초 관측 후 불변·REQUESTED 는 종단 불가 상태라 영속 금지).
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'requested_not_persisted');
  end if;
  if p_cancellation_id is null or char_length(p_cancellation_id) < 1 or char_length(p_cancellation_id) > 256 then
    raise exception 'cancellation_id_invalid' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount_invalid' using errcode = 'P0001'; end if;

  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;

  select * into ev from public.payment_cancellation_events where cancellation_id = p_cancellation_id;
  if ev.cancellation_id is not null then
    if ev.order_uuid = p_order_uuid and ev.amount = p_amount and ev.status = p_status then
      return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
    end if;
    -- 재관측 불일치 — 기존 event 불변 유지 + event 형 discrepancy issue(§11, cancellation_id 존재형).
    insert into public.reconciliation_issues (type, order_uuid, user_id, cancellation_id, detail)
    select 'cancellation_discrepancy', ev.order_uuid, o2.user_id, ev.cancellation_id,
           pg_catalog.jsonb_build_object(
             'stored', pg_catalog.jsonb_build_object('order_uuid', ev.order_uuid::text,
               'amount', ev.amount, 'status', ev.status),
             'observed', pg_catalog.jsonb_build_object('order_uuid', p_order_uuid::text,
               'amount', p_amount, 'status', p_status))
      from public.orders o2 where o2.order_uuid = ev.order_uuid
    on conflict (type, order_uuid, coalesce(cancellation_id, '')) where state = 'open' do nothing;
    select id into v_issue from public.reconciliation_issues
     where type = 'cancellation_discrepancy' and order_uuid = ev.order_uuid
       and cancellation_id = ev.cancellation_id and state = 'open';
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'discrepancy', 'issue_id', v_issue);
  end if;

  insert into public.payment_cancellation_events
    (cancellation_id, order_uuid, status, amount, requested_at, cancelled_at, origin, resolution_state, observed_raw)
  values (p_cancellation_id, p_order_uuid, p_status, p_amount, p_requested_at, p_cancelled_at,
          'live', 'unmatched', p_raw);

  if p_status = 'SUCCEEDED' then
    -- marker 자기 귀속 확인(§27): reason 앞머리 BP_REFUND:<attempt-uuid> — open PG attempt 면 saga 가 곧 매칭.
    if coalesce(p_raw->>'reason', '') like 'BP_REFUND:%' then
      begin
        v_marker_attempt := substring(p_raw->>'reason' from 11 for 36)::uuid;
      exception when others then
        v_marker_attempt := null;
      end;
      if v_marker_attempt is not null then
        select true into v_self_attributed
          from public.order_refund_attempts a
         where a.id = v_marker_attempt and a.order_uuid = p_order_uuid
           and a.state in ('pg_requested', 'pg_pending', 'pg_succeeded');
        v_self_attributed := coalesce(v_self_attributed, false);
      end if;
    end if;
    if not v_self_attributed then
      insert into public.reconciliation_issues (type, order_uuid, user_id, cancellation_id, detail)
      values ('unmatched_cancellation', p_order_uuid, o.user_id, p_cancellation_id,
              pg_catalog.jsonb_build_object('amount', p_amount, 'observed_status', p_status))
      on conflict (type, order_uuid, coalesce(cancellation_id, '')) where state = 'open' do nothing;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'recorded',
    'self_attributed', v_self_attributed);
end;
$$;
revoke all on function public.record_payment_cancellation_observation(uuid, text, text, bigint, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_payment_cancellation_observation(uuid, text, text, bigint, timestamptz, timestamptz, jsonb)
  to service_role;

-- ── 외부 RPC: mark_order_failed — pending→failed 종단(금융 delta 0·§13 금융인접 status 는 RPC 경유) ──
create or replace function public.mark_order_failed(
  p_order_uuid uuid, p_pg_status text, p_error_message text, p_raw jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare o public.orders;
begin
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status = 'failed' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if o.status <> 'pending' or o.paid_at is not null then
    -- paid/canceled 관측 경합 — 종단을 덮어쓰지 않는다(멱등·무해).
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'skipped', 'status', o.status);
  end if;
  update public.orders
     set status = 'failed', pg_status = coalesce(p_pg_status, pg_status),
         error_message = p_error_message, raw = coalesce(p_raw, raw)
   where order_uuid = p_order_uuid;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'failed');
end;
$$;
revoke all on function public.mark_order_failed(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_order_failed(uuid, text, text, jsonb) to service_role;

-- ── 외부 RPC: mark_order_canceled_unpaid — 무결제(paid_at null) 주문의 CANCELLED 관측 종단(system) ──
--   paid 주문의 취소는 이벤트 영속 + resolver(auto_full/단건)가 소유 — 여기서는 fail-closed 거부.
create or replace function public.mark_order_canceled_unpaid(
  p_order_uuid uuid, p_pg_status text, p_pg_tx_id text, p_raw jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare o public.orders;
begin
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status = 'canceled' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if o.paid_at is not null then raise exception 'use_refund_saga' using errcode = 'P0001'; end if;
  if o.status not in ('pending', 'failed') then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'skipped', 'status', o.status);
  end if;
  update public.orders
     set status = 'canceled', canceled_at = coalesce(canceled_at, now()),
         pg_status = coalesce(p_pg_status, pg_status),
         pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id), raw = coalesce(p_raw, raw)
   where order_uuid = p_order_uuid;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'canceled');
end;
$$;
revoke all on function public.mark_order_canceled_unpaid(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_order_canceled_unpaid(uuid, text, text, jsonb) to service_role;

-- 참고: search_orders(text,text,int,int)·admin_unreconciled_canceled_orders(int) 는 0058 정의(읽기 전용)를
--   그대로 재사용(반환·권한 불변) — 0062 는 이 둘의 본문을 변경하지 않는다.

-- ══════════════════════════════════════════════════════════════════════════════════════════
-- §12 (A.5.2) 기존 3테이블 금융 컬럼 column-level grant 재구성(operational 컬럼만 남김).
--   additive 안전 범위: service_role 이 이미 grant all 이므로 금융 컬럼 UPDATE 를 회수하고 operational 만 재부여.
-- ══════════════════════════════════════════════════════════════════════════════════════════
revoke update on table public.orders from service_role;
grant update (pg_status, raw, error_message, refund_state) on table public.orders to service_role;

revoke update on table public.member_accounts from service_role;
grant update (email, age_confirmed_at, terms_agreed_at, privacy_agreed_at,
              terms_version, privacy_version, reconsent_required, abuse_status)
  on table public.member_accounts to service_role;

revoke update on table public.ai_generations from service_role;
grant update (status, fal_request_id, cost_cents, candidate_urls,
              picked_doll_id, picked_index, fal_request_ids, fail_reason, role)
  on table public.ai_generations to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════
-- S12. postflight (A.9 — 실패 시 전체 롤백). 컷오버 직후 전용(Q7·Q14·Q16 포함) 전수 검증.
-- ══════════════════════════════════════════════════════════════════════════════════════════
do $$
declare v int;
begin
  -- Q1. 불변식 1: 캐시 ≡ Σ live 로트 잔여.
  select count(*) into v from public.member_accounts ma
    left join (select user_id, sum(qty - consumed - refunded - refund_reserved) as remain
                 from public.credit_lots where expired_at is null group by user_id) l
      on l.user_id = ma.user_id
   where ma.gen_credits <> coalesce(l.remain, 0);
  if v > 0 then raise exception 'postflight_Q1_cash_invariant: %', v using errcode = 'P0001'; end if;

  -- Q2. 불변식 2: lot.refund_reserved ≡ Σ open attempts qty (per lot).
  select count(*) into v from public.credit_lots l
   where l.refund_reserved <> coalesce((
          select sum(a.qty) from public.order_refund_attempts a
           where a.credit_lot_id = l.id
             and a.state in ('prepared','pg_requested','pg_pending','pg_succeeded','manual_pending','manual_review')), 0);
  if v > 0 then raise exception 'postflight_Q2_reserved_invariant: %', v using errcode = 'P0001'; end if;

  -- Q3. 불변식 D1a: orders.refunded_credits 분해.
  select count(*) into v from public.orders o
   where o.paid_at is not null
     and o.refunded_credits <> (
       coalesce((select sum(a.qty) from public.order_refund_attempts a
                  where a.order_uuid = o.order_uuid and a.state = 'committed'), 0)
     + coalesce((select sum(ev.resolved_economic_qty) from public.payment_cancellation_events ev
                 where ev.order_uuid = o.order_uuid and ev.origin = 'live' and ev.resolution_state = 'resolved'), 0)
     + coalesce((select sum((cl.metadata->>'closure_qty')::int) from public.credit_ledger cl
                  join public.order_refund_attempts a2 on a2.id = cl.ref_attempt_id
                 where a2.order_uuid = o.order_uuid and cl.event_type = 'refund_policy_close'), 0)
     + coalesce((select sum(e.refunded_credits) from public.legacy_refund_backfill_evidence e
                 where e.order_uuid = o.order_uuid), 0));
  if v > 0 then raise exception 'postflight_Q3_refunded_credits_decomp: %', v using errcode = 'P0001'; end if;

  -- Q4. 불변식 D1b: orders.refunded_amount 분해.
  select count(*) into v from public.orders o
   where o.paid_at is not null
     and o.refunded_amount <> (
       coalesce((select sum(a.amount) from public.order_refund_attempts a
                  where a.order_uuid = o.order_uuid and a.state = 'committed'), 0)
     + coalesce((select sum(ev.amount) from public.payment_cancellation_events ev
                  where ev.order_uuid = o.order_uuid and ev.origin = 'live'
                    and ev.status = 'SUCCEEDED' and ev.resolution_state = 'resolved'), 0)
     + coalesce((select sum(e.refunded_amount) from public.legacy_refund_backfill_evidence e
                 where e.order_uuid = o.order_uuid), 0));
  if v > 0 then raise exception 'postflight_Q4_refunded_amount_decomp: %', v using errcode = 'P0001'; end if;

  -- Q5. 불변식 D2: per-lot Σ remaining_shortfall_qty <= consumed.
  select count(*) into v from (
    select s.lot_id from public.credit_refund_shortfalls s join public.credit_lots l on l.id = s.lot_id
     group by s.lot_id, l.consumed having sum(s.remaining_shortfall_qty) > l.consumed) q;
  if v > 0 then raise exception 'postflight_Q5_shortfall_over_consumed: %', v using errcode = 'P0001'; end if;

  -- Q6. 불변식 8: canceled-paid 사용가능 purchase credit 0.
  select count(*) into v from public.credit_lots l join public.orders o on o.order_uuid = l.order_uuid
   where l.source = 'purchase' and o.status = 'canceled' and o.paid_at is not null
     and l.expired_at is null and (l.qty - l.consumed - l.refunded - l.refund_reserved) > 0;
  if v > 0 then raise exception 'postflight_Q6_canceled_live_credit: %', v using errcode = 'P0001'; end if;

  -- Q7. 컷오버 잔존 0(open attempt·building request).
  select count(*) into v from public.order_refund_attempts
   where state in ('prepared','pg_requested','pg_pending','pg_succeeded','manual_pending','manual_review');
  if v > 0 then raise exception 'postflight_Q7_open_attempts: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.refund_requests where state = 'building';
  if v > 0 then raise exception 'postflight_Q7_building_requests: %', v using errcode = 'P0001'; end if;

  -- Q8. 불변식 9: amount<=0 attempt 0.
  select count(*) into v from public.order_refund_attempts where amount <= 0;
  if v > 0 then raise exception 'postflight_Q8_zero_amount_attempts: %', v using errcode = 'P0001'; end if;

  -- Q9. legacy 중복 집계 0.
  select count(*) into v from (
    select order_uuid from public.legacy_refund_backfill_evidence group by order_uuid having count(*) > 1) q;
  if v > 0 then raise exception 'postflight_Q9_evidence_dup: %', v using errcode = 'P0001'; end if;
  select count(distinct manifest_hash) into v from public.legacy_refund_backfill_evidence;
  if v > 1 then raise exception 'postflight_Q9_hash_split: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   where ev.origin = 'live'
     and exists (select 1 from public.legacy_refund_backfill_evidence e where e.order_uuid = ev.order_uuid);
  if v > 0 then raise exception 'postflight_Q9_live_event_on_legacy: %', v using errcode = 'P0001'; end if;

  -- Q10. cross-user + lot↔order 정합 0.
  select count(*) into v from (
    select a.id from public.order_refund_attempts a join public.credit_lots l on l.id = a.credit_lot_id
     where l.user_id <> a.user_id or l.order_uuid is distinct from a.order_uuid
    union all
    select g.id from public.ai_generations g join public.credit_lots l on l.id = g.credit_lot_id
     where l.user_id <> g.owner_id) q;
  if v > 0 then raise exception 'postflight_Q10_cross_user_or_order: %', v using errcode = 'P0001'; end if;

  -- Q11. 중복 원장 0(attempt 계열 + gen v2). gen v1 중복은 warning.
  select count(*) into v from (
    select ref_attempt_id, event_type from public.credit_ledger
     where ref_attempt_id is not null
       and event_type in ('refund_reserve','refund_commit','refund_release','refund_policy_close')
     group by ref_attempt_id, event_type having count(*) > 1) q;
  if v > 0 then raise exception 'postflight_Q11_dup_attempt_ledger: %', v using errcode = 'P0001'; end if;
  select count(*) into v from (
    select ref_gen_id, event_type from public.credit_ledger
     where ref_gen_id is not null and ref_attempt_id is null and schema_version = 2
     group by ref_gen_id, event_type having count(*) > 1) q;
  if v > 0 then raise exception 'postflight_Q11_dup_gen_ledger_v2: %', v using errcode = 'P0001'; end if;
  select count(*) into v from (
    select ref_gen_id, event_type from public.credit_ledger
     where ref_gen_id is not null and ref_attempt_id is null and schema_version = 1
     group by ref_gen_id, event_type having count(*) > 1) q;
  if v > 0 then raise warning 'postflight_Q11_dup_gen_ledger_v1(레거시 잔재 — 수동 확인): %', v; end if;

  -- Q12 = G-29. 시간 CHECK 잔존 0.
  select count(*) into v from pg_constraint c
   where c.contype = 'c'
     and c.conrelid in ('public.credit_lots'::regclass, 'public.refund_requests'::regclass,
                        'public.order_refund_attempts'::regclass, 'public.payment_cancellation_events'::regclass,
                        'public.reconciliation_issues'::regclass, 'public.credit_refund_shortfalls'::regclass,
                        'public.legacy_refund_backfill_evidence'::regclass,
                        'public.credit_ledger'::regclass, 'public.admin_actions_ledger'::regclass,
                        'public.orders'::regclass, 'public.ai_generations'::regclass)
     and pg_get_constraintdef(c.oid) ~* '(now\(\)|clock_timestamp|current_timestamp|localtimestamp)';
  if v > 0 then raise exception 'postflight_Q12_time_check_in_table: %', v using errcode = 'P0001'; end if;

  -- Q13. 권한 leak 0.
  select count(*) into v from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('credit_lots','refund_requests','order_refund_attempts',
                          'payment_cancellation_events','reconciliation_issues','credit_refund_shortfalls',
                          'legacy_refund_backfill_evidence','credit_ledger','admin_actions_ledger')
     and ((g.grantee in ('anon','authenticated','PUBLIC'))
          or (g.grantee = 'service_role' and g.privilege_type <> 'SELECT'));
  if v > 0 then raise exception 'postflight_Q13_dml_privilege_leak: %', v using errcode = 'P0001'; end if;

  -- Q14. strict CHECK 유효화.
  if not exists (select 1 from pg_constraint
                  where conname = 'orders_canceled_paid_refunded_check' and convalidated) then
    raise exception 'postflight_Q14_strict_check_not_validated' using errcode = 'P0001';
  end if;

  -- Q15. 부분 유니크·핵심 인덱스 존재.
  select 11 - count(*) into v from pg_indexes
   where schemaname = 'public'
     and indexname in ('uq_credit_lots_purchase_order','uq_refund_requests_intent_active',
                       'uq_refund_attempts_order_open','uq_cancellation_events_attempt',
                       'uq_recon_issues_open','uq_credit_ledger_attempt_reserve',
                       'uq_credit_ledger_attempt_settle','uq_credit_ledger_attempt_policy_close',
                       'uq_credit_ledger_lot_expire_v2','uq_credit_ledger_gen_v2','uq_legacy_evidence_order');
  if v > 0 then raise exception 'postflight_Q15_missing_indexes: %', v using errcode = 'P0001'; end if;

  -- Q16. open issue 0(컷오버 전용).
  select count(*) into v from public.reconciliation_issues where state = 'open';
  if v > 0 then raise exception 'postflight_Q16_open_issues: %', v using errcode = 'P0001'; end if;

  -- Q17 = G-13·G-34. resolved 매핑 ↔ shortfall 장부 8단계(malformed 안전).
  select count(*) into v from public.payment_cancellation_events ev
   where (ev.resolution_state = 'resolved')
     <> (ev.resolved_lot_mappings is not null and jsonb_typeof(ev.resolved_lot_mappings) = 'array');
  if v > 0 then raise exception 'postflight_Q17_s1_mappings_coupling: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   where ev.resolution_state = 'resolved' and jsonb_typeof(mp) <> 'object';
  if v > 0 then raise exception 'postflight_Q17_s2_item_not_object: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   where ev.resolution_state = 'resolved'
     and ( (select count(*) from jsonb_object_keys(mp)) <> 5
        or not (mp ?& array['lot_id','mapped_qty','immediate_recovered_qty','shortfall_qty','lot_was_live'])
        or jsonb_typeof(mp->'lot_id') <> 'string' or jsonb_typeof(mp->'mapped_qty') <> 'number'
        or jsonb_typeof(mp->'immediate_recovered_qty') <> 'number'
        or jsonb_typeof(mp->'shortfall_qty') <> 'number' or jsonb_typeof(mp->'lot_was_live') <> 'boolean' );
  if v > 0 then raise exception 'postflight_Q17_s3_key_type_invalid: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   where ev.resolution_state = 'resolved'
     and (mp->>'lot_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if v > 0 then raise exception 'postflight_Q17_s4_lot_id_not_uuid: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   cross join lateral (values ((mp->>'mapped_qty')::numeric, (mp->>'immediate_recovered_qty')::numeric,
                               (mp->>'shortfall_qty')::numeric)) as n(q, r, s)
   where ev.resolution_state = 'resolved'
     and ( n.q <> trunc(n.q) or n.q < 0 or n.q > 2147483647
        or n.r <> trunc(n.r) or n.r < 0 or n.r > 2147483647
        or n.s <> trunc(n.s) or n.s < 0 or n.s > 2147483647 );
  if v > 0 then raise exception 'postflight_Q17_s5_qty_not_int4_range: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   where ev.resolution_state = 'resolved'
     and ( (mp->>'mapped_qty')::int <= 0
        or (mp->>'mapped_qty')::int <> (mp->>'immediate_recovered_qty')::int + (mp->>'shortfall_qty')::int );
  if v > 0 then raise exception 'postflight_Q17_s6_value_invalid: %', v using errcode = 'P0001'; end if;
  select count(*) into v from (
    select 1 from public.payment_cancellation_events ev
     cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
     where ev.resolution_state = 'resolved'
     group by ev.cancellation_id, mp->>'lot_id' having count(*) > 1) q;
  if v > 0 then raise exception 'postflight_Q17_s6_dup_lot: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   where ev.resolution_state = 'resolved'
     and not exists (select 1 from public.credit_lots l
                      where l.id = (mp->>'lot_id')::uuid and l.order_uuid = ev.order_uuid and l.source = 'purchase');
  if v > 0 then raise exception 'postflight_Q17_s7_lot_not_purchase: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   where ev.resolution_state = 'resolved'
     and ev.resolved_economic_qty <> coalesce((
          select sum((mp->>'mapped_qty')::int) from jsonb_array_elements(ev.resolved_lot_mappings) mp), 0);
  if v > 0 then raise exception 'postflight_Q17_s8_qty_sum: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
   where ev.resolution_state = 'resolved'
     and ( ((mp->>'shortfall_qty')::int > 0
            and (select count(*) from public.credit_refund_shortfalls s
                  where s.source_cancellation_id = ev.cancellation_id and s.lot_id = (mp->>'lot_id')::uuid
                    and s.source_type = 'external_cancellation' and s.mapped_qty = (mp->>'mapped_qty')::int
                    and s.initial_shortfall_qty = (mp->>'shortfall_qty')::int) <> 1)
        or ((mp->>'shortfall_qty')::int = 0
            and exists (select 1 from public.credit_refund_shortfalls s
                         where s.source_cancellation_id = ev.cancellation_id and s.lot_id = (mp->>'lot_id')::uuid)) );
  if v > 0 then raise exception 'postflight_Q17_s8_shortfall_row_mismatch: %', v using errcode = 'P0001'; end if;
  select count(*) into v from public.credit_refund_shortfalls s
   where s.source_type = 'external_cancellation'
     and not exists (select 1 from public.payment_cancellation_events ev
                      cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) mp
                      where ev.cancellation_id = s.source_cancellation_id and ev.resolution_state = 'resolved'
                        and (mp->>'lot_id')::uuid = s.lot_id and (mp->>'shortfall_qty')::int > 0);
  if v > 0 then raise exception 'postflight_Q17_s8_shortfall_row_orphan: %', v using errcode = 'P0001'; end if;

  -- Q18 = G-35(policy). refund_policy_close 등식(two-CTE malformed 안전).
  with cl as (
    select id, delta, metadata from public.credit_ledger where event_type = 'refund_policy_close'
  ), valid as (
    select id, delta, metadata from cl
     where jsonb_typeof(metadata) = 'object'
       and (select count(*) from jsonb_object_keys(metadata)) = 7
       and metadata ?& array['closure_qty','recovered_qty','shortfall_qty','lot_was_live',
                             'cache_effect_qty','rate_bps','refunded_amount_total']
       and jsonb_typeof(metadata->'closure_qty') = 'number' and jsonb_typeof(metadata->'recovered_qty') = 'number'
       and jsonb_typeof(metadata->'shortfall_qty') = 'number' and jsonb_typeof(metadata->'cache_effect_qty') = 'number'
       and jsonb_typeof(metadata->'lot_was_live') = 'boolean'
       and (metadata->>'closure_qty')::numeric = trunc((metadata->>'closure_qty')::numeric)
       and (metadata->>'recovered_qty')::numeric = trunc((metadata->>'recovered_qty')::numeric)
       and (metadata->>'shortfall_qty')::numeric = trunc((metadata->>'shortfall_qty')::numeric)
       and (metadata->>'cache_effect_qty')::numeric = trunc((metadata->>'cache_effect_qty')::numeric)
       and (metadata->>'closure_qty')::numeric between 0 and 2147483647
       and (metadata->>'recovered_qty')::numeric between 0 and 2147483647
       and (metadata->>'shortfall_qty')::numeric between 0 and 2147483647
       and (metadata->>'cache_effect_qty')::numeric between 0 and 2147483647
  )
  select (select count(*) from cl) - (select count(*) from valid)
       + (select count(*) from valid
           where (metadata->>'recovered_qty')::int + (metadata->>'shortfall_qty')::int > (metadata->>'closure_qty')::int
              or (metadata->>'cache_effect_qty')::int
                   <> case when (metadata->>'lot_was_live')::boolean then (metadata->>'recovered_qty')::int else 0 end
              or delta <> -((metadata->>'cache_effect_qty')::int)) into v;
  if v > 0 then raise exception 'postflight_Q18_policy_close_equation: %', v using errcode = 'P0001'; end if;

  -- Q19 = G-35(외부취소). refund_commit(외부취소형) metadata(two-CTE).
  with cl as (
    select id, delta, metadata from public.credit_ledger
     where event_type = 'refund_commit' and ref_cancellation_id is not null
  ), valid as (
    select id, delta, metadata from cl
     where jsonb_typeof(metadata) = 'object'
       and (select count(*) from jsonb_object_keys(metadata)) = 4
       and metadata ?& array['mapped_qty','immediate_recovered_qty','shortfall_qty','live_recovered_qty']
       and jsonb_typeof(metadata->'mapped_qty') = 'number' and jsonb_typeof(metadata->'immediate_recovered_qty') = 'number'
       and jsonb_typeof(metadata->'shortfall_qty') = 'number' and jsonb_typeof(metadata->'live_recovered_qty') = 'number'
       and (metadata->>'mapped_qty')::numeric = trunc((metadata->>'mapped_qty')::numeric)
       and (metadata->>'immediate_recovered_qty')::numeric = trunc((metadata->>'immediate_recovered_qty')::numeric)
       and (metadata->>'shortfall_qty')::numeric = trunc((metadata->>'shortfall_qty')::numeric)
       and (metadata->>'live_recovered_qty')::numeric = trunc((metadata->>'live_recovered_qty')::numeric)
       and (metadata->>'mapped_qty')::numeric between 0 and 2147483647
       and (metadata->>'immediate_recovered_qty')::numeric between 0 and 2147483647
       and (metadata->>'shortfall_qty')::numeric between 0 and 2147483647
       and (metadata->>'live_recovered_qty')::numeric between 0 and 2147483647
  )
  select (select count(*) from cl) - (select count(*) from valid)
       + (select count(*) from valid
           where (metadata->>'mapped_qty')::int
                   <> (metadata->>'immediate_recovered_qty')::int + (metadata->>'shortfall_qty')::int
              or (metadata->>'live_recovered_qty')::int > (metadata->>'immediate_recovered_qty')::int
              or delta <> -((metadata->>'live_recovered_qty')::int)) into v;
  if v > 0 then raise exception 'postflight_Q19_external_commit_metadata: %', v using errcode = 'P0001'; end if;

  raise notice 'postflight OK';
end $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════
-- §22 migration journal — 적용 사실 원자 기록(private·additive·SELECT-only).
-- ══════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.schema_migration_journal (
  version text primary key,
  migration_hash text,
  manifest_hash text,
  applied_at timestamptz not null default now(),
  app_commit text,
  executed_by text not null default current_user
);
alter table public.schema_migration_journal enable row level security;
revoke all on table public.schema_migration_journal from public, anon, authenticated, service_role;
grant select on table public.schema_migration_journal to service_role;

insert into public.schema_migration_journal (version, migration_hash, manifest_hash, app_commit)
select '0062_credit_lots_refund_saga', null,
       (select manifest_hash from refund_backfill_manifest_header limit 1), null
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';













