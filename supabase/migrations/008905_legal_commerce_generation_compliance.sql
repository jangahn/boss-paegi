-- 008905: additive legal-compliance evidence before the 0090 contract phase.
--
--  * Korean E-commerce Act Decree Article 6 display/advertising records:
--    immutable normalized snapshots, retained for a strict minimum six months.
--  * fal.ai end-user flow-down: separate Korean age-19 self-attestation plus
--    explicit ToS/AUP acceptance, stored as immutable versioned evidence.
--
-- This migration installs the checkout withdrawal-evidence contract used by
-- the now-implemented checkout compile fence. fal generation remains
-- compile-time frozen until its independent external/provider blockers close.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $preflight$
begin
  if pg_catalog.to_regclass('public.schema_migration_journal') is null
     or pg_catalog.to_regclass('public.profiles') is null
     or pg_catalog.to_regclass('public.member_accounts') is null
     or pg_catalog.to_regclass('public.legal_documents') is null
     or pg_catalog.to_regprocedure(
          'public.bp_user_mutation_lock(uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_0084_legal_consent_locks(boolean,boolean)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_privacy_retention_delete_authorized()'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'extensions.digest(bytea,text)'
        ) is null then
    raise exception '008905 preflight: compliance dependencies missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.profiles'::regclass
       and a.attname = 'withdrawal_generation'
       and not a.attisdropped
  ) then
    raise exception '008905 preflight: withdrawal generation missing';
  end if;
end;
$preflight$;

-- ── Full 30-day legal notice at the authoritative DB boundary ──────────────
--
-- v2 is the first material/adverse revision, but the invariant is deliberately
-- permanent for every later privacy/terms version.  Without a durable
-- classification column, treating all version >= 2 publications
-- conservatively is the only fail-closed rule.

create or replace function public.bp_legal_full_notice_valid(
  p_effective_date date,
  p_notice_at timestamptz,
  p_minimum_days integer default 30
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_effective_date is not null
     and p_notice_at is not null
     and p_minimum_days between 1 and 365
     and (
       p_effective_date::timestamp at time zone 'Asia/Seoul'
     ) >= p_notice_at + pg_catalog.make_interval(days => p_minimum_days)
$$;
revoke all on function public.bp_legal_full_notice_valid(
  date,timestamptz,integer
) from public, anon, authenticated, service_role;

create or replace function public.bp_legal_full_notice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'published'
     and new.version >= 2
     and new.doc_type in ('privacy', 'terms')
     and (
       tg_op = 'INSERT'
       or (
         tg_op = 'UPDATE'
         and (
           old.status is distinct from new.status
           or old.doc_type is distinct from new.doc_type
           or old.version is distinct from new.version
           or old.effective_date is distinct from new.effective_date
           or old.title is distinct from new.title
           or old.sections is distinct from new.sections
           or old.public_note is distinct from new.public_note
         )
       )
     ) then
    if not public.bp_legal_full_notice_valid(
         new.effective_date,
         clock_timestamp(),
         30
       ) then
      raise exception 'legal_notice_period_too_short'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.bp_legal_full_notice_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_legal_full_notice_guard
  on public.legal_documents;
create trigger trg_legal_full_notice_guard
before insert or update
on public.legal_documents
for each row execute function public.bp_legal_full_notice_guard();

-- ── Six-month display/advertising evidence ─────────────────────────────────

create table public.commerce_display_evidence (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (
    surface in ('credits_offer', 'checkout_withdrawal_limit')
  ),
  snapshot jsonb not null check (
    pg_catalog.jsonb_typeof(snapshot) = 'object'
    and pg_catalog.octet_length(snapshot::text) between 2 and 200000
  ),
  snapshot_sha256 text not null check (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  display_kst_date date not null,
  first_displayed_at timestamptz not null,
  last_displayed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint commerce_display_evidence_clock_check check (
    last_displayed_at >= first_displayed_at
    and display_kst_date =
      (first_displayed_at at time zone 'Asia/Seoul')::date
  ),
  unique (surface, snapshot_sha256, display_kst_date)
);

comment on table public.commerce_display_evidence is
  '전자상거래 표시·광고 내용의 일별 불변 snapshot. 마지막 실제 표시일부터 최소 6개월이 지나기 전에는 파기할 수 없다.';

alter table public.commerce_display_evidence enable row level security;
revoke all on table public.commerce_display_evidence
  from public, anon, authenticated, service_role;
grant select on table public.commerce_display_evidence to service_role;

create index commerce_display_evidence_retention_idx
  on public.commerce_display_evidence(last_displayed_at, id);

create or replace function public.bp_commerce_display_evidence_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_capability text := pg_catalog.current_setting(
    'boss_paegi.commerce_display_evidence',
    true
  );
begin
  if tg_op = 'INSERT' then
    if v_capability = 'record:008905:v1' then
      return new;
    end if;
  elsif tg_op = 'UPDATE' then
    if v_capability = 'record:008905:v1'
       and new.id = old.id
       and new.surface = old.surface
       and new.snapshot = old.snapshot
       and new.snapshot_sha256 = old.snapshot_sha256
       and new.display_kst_date = old.display_kst_date
       and new.first_displayed_at = old.first_displayed_at
       and new.created_at = old.created_at
       and new.last_displayed_at >= old.last_displayed_at then
      return new;
    end if;
  elsif tg_op = 'DELETE' then
    if v_capability = 'prune:008905:v1'
       and old.last_displayed_at <
         clock_timestamp() - interval '6 months' then
      return old;
    end if;
  end if;
  raise exception 'commerce_display_evidence_immutable'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_commerce_display_evidence_guard()
  from public, anon, authenticated, service_role;

create trigger trg_commerce_display_evidence_guard
before insert or update or delete
on public.commerce_display_evidence
for each row execute function public.bp_commerce_display_evidence_guard();

create or replace function public.record_commerce_display_evidence(
  p_surface text,
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_row public.commerce_display_evidence%rowtype;
begin
  if p_surface is null
     or p_surface not in (
       'credits_offer',
       'checkout_withdrawal_limit'
     ) then
    raise exception 'invalid_display_surface' using errcode = 'P0001';
  end if;
  if p_snapshot is null
     or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
     or pg_catalog.octet_length(p_snapshot::text) not between 2 and 200000 then
    raise exception 'invalid_display_snapshot' using errcode = 'P0001';
  end if;
  v_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  perform pg_catalog.set_config(
    'boss_paegi.commerce_display_evidence',
    'record:008905:v1',
    true
  );
  insert into public.commerce_display_evidence(
    surface,
    snapshot,
    snapshot_sha256,
    display_kst_date,
    first_displayed_at,
    last_displayed_at
  )
  values (
    p_surface,
    p_snapshot,
    v_hash,
    (v_now at time zone 'Asia/Seoul')::date,
    v_now,
    v_now
  )
  on conflict (surface, snapshot_sha256, display_kst_date)
  do update
        set last_displayed_at = greatest(
          public.commerce_display_evidence.last_displayed_at,
          excluded.last_displayed_at
        )
  returning * into v_row;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'evidence_id', v_row.id,
    'snapshot_sha256', v_row.snapshot_sha256,
    'first_displayed_at', v_row.first_displayed_at,
    'last_displayed_at', v_row.last_displayed_at,
    'retain_until_at_least',
      v_row.last_displayed_at + interval '6 months'
  );
end;
$$;

create or replace function public.prune_commerce_display_evidence(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed integer := 0;
  v_has_more boolean := false;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_limit' using errcode = 'P0001';
  end if;
  perform pg_catalog.set_config(
    'boss_paegi.commerce_display_evidence',
    'prune:008905:v1',
    true
  );
  with candidates as (
    select e.id
      from public.commerce_display_evidence e
     where e.last_displayed_at <
       clock_timestamp() - interval '6 months'
     order by e.last_displayed_at, e.id
     limit p_limit
     for update skip locked
  ),
  removed as (
    delete from public.commerce_display_evidence e
     using candidates c
     where e.id = c.id
     returning e.id
  )
  select pg_catalog.count(*)::integer into v_processed from removed;

  select exists (
    select 1
      from public.commerce_display_evidence e
     where e.last_displayed_at <
       clock_timestamp() - interval '6 months'
  ) into v_has_more;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'has_more', v_has_more
  );
end;
$$;

revoke all on function public.record_commerce_display_evidence(text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_commerce_display_evidence(text,jsonb)
  to service_role;
revoke all on function public.prune_commerce_display_evidence(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_commerce_display_evidence(integer)
  to service_role;

-- ── Separate affirmative withdrawal-limit evidence ────────────────────────
--
-- Display evidence is an advertising record (six months).  The user's
-- affirmative acknowledgement is transaction evidence and follows the order's
-- five-year retention lifecycle instead.  It is inserted in the exact same
-- transaction as the order receipt; no route can create one side without the
-- other.

alter function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
) rename to bp_008905_create_or_reuse_pending_order_impl;
revoke all on function public.bp_008905_create_or_reuse_pending_order_impl(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
) from public, anon, authenticated, service_role;

-- Expand-only compatibility wrapper. Checkout stays frozen throughout expand;
-- 0092 drops this evidence-free overload after old requests drain.
create or replace function public.create_or_reuse_pending_order(
  p_user uuid,
  p_order_uuid uuid,
  p_product_id text,
  p_amount integer,
  p_credits integer,
  p_payment_id text,
  p_provider text,
  p_pay_channel text,
  p_is_test boolean,
  p_expected_store_id text,
  p_expected_currency text,
  p_expected_channel_key text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.bp_008905_create_or_reuse_pending_order_impl(
    p_user,
    p_order_uuid,
    p_product_id,
    p_amount,
    p_credits,
    p_payment_id,
    p_provider,
    p_pay_channel,
    p_is_test,
    p_expected_store_id,
    p_expected_currency,
    p_expected_channel_key
  )
$$;
revoke all on function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
) to service_role;

create table public.checkout_withdrawal_acceptance_evidence (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  order_uuid uuid not null,
  user_id uuid not null,
  product_id text not null check (
    pg_catalog.char_length(product_id) between 1 and 100
    and product_id = pg_catalog.btrim(product_id)
    and product_id !~ '[[:cntrl:]]'
  ),
  product_name text not null check (
    pg_catalog.char_length(product_name) between 1 and 200
    and product_name = pg_catalog.btrim(product_name)
    and product_name !~ '[[:cntrl:]]'
  ),
  amount integer not null check (amount > 0),
  credits integer not null check (credits > 0),
  pay_mode text not null check (pay_mode in ('test', 'live')),
  pay_channel text not null check (
    pay_channel in ('card', 'tosspay', 'kakaopay')
  ),
  offer_evidence_id uuid not null,
  offer_snapshot_sha256 text not null check (
    offer_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  copy_version text not null check (
    copy_version = 'checkout-withdrawal-limit-2026-07-30-v1'
  ),
  confirmation_copy text not null check (
    confirmation_copy =
      '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.'
  ),
  confirmed boolean not null check (confirmed),
  accepted_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint checkout_withdrawal_order_user_fkey
    foreign key (order_uuid, user_id)
    references public.orders(order_uuid, user_id)
    on delete cascade,
  constraint checkout_withdrawal_clock_check check (
    created_at >= accepted_at
  )
);

comment on table public.checkout_withdrawal_acceptance_evidence is
  '사용한 생성권의 청약철회 제한을 다른 동의와 분리해 적극 확인한 거래 증거. 주문과 함께 최소 5년 보존하며 탈퇴 시 PII scrub 뒤에도 pseudonymous order UUID와 함께 유지한다.';

alter table public.checkout_withdrawal_acceptance_evidence
  enable row level security;
revoke all on table public.checkout_withdrawal_acceptance_evidence
  from public, anon, authenticated, service_role;
grant select on table public.checkout_withdrawal_acceptance_evidence
  to service_role;

create index checkout_withdrawal_order_idx
  on public.checkout_withdrawal_acceptance_evidence(order_uuid, accepted_at);

create or replace function public.bp_checkout_withdrawal_evidence_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capability text := pg_catalog.current_setting(
    'boss_paegi.checkout_withdrawal_evidence',
    true
  );
begin
  if tg_op = 'INSERT'
     and v_capability = 'record:008905:v1' then
    return new;
  end if;
  if tg_op = 'DELETE'
     and public.bp_privacy_retention_delete_authorized() then
    return old;
  end if;
  raise exception 'checkout_withdrawal_evidence_immutable'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_checkout_withdrawal_evidence_guard()
  from public, anon, authenticated, service_role;

create trigger trg_checkout_withdrawal_evidence_guard
before insert or update or delete
on public.checkout_withdrawal_acceptance_evidence
for each row execute function public.bp_checkout_withdrawal_evidence_guard();

create or replace function public.create_or_reuse_pending_order(
  p_user uuid,
  p_order_uuid uuid,
  p_product_id text,
  p_amount integer,
  p_credits integer,
  p_payment_id text,
  p_provider text,
  p_pay_channel text,
  p_is_test boolean,
  p_expected_store_id text,
  p_expected_currency text,
  p_expected_channel_key text,
  p_checkout_request_id uuid,
  p_product_name text,
  p_offer_evidence_id uuid,
  p_offer_snapshot_sha256 text,
  p_withdrawal_copy_version text,
  p_withdrawal_copy text,
  p_withdrawal_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt jsonb;
  v_order_uuid uuid;
  v_order_user uuid;
  v_order_product text;
  v_order_amount integer;
  v_order_credits integer;
  v_order_is_test boolean;
  v_order_channel text;
  v_current_product_name text;
  v_offer public.commerce_display_evidence%rowtype;
  v_existing public.checkout_withdrawal_acceptance_evidence%rowtype;
  v_evidence public.checkout_withdrawal_acceptance_evidence%rowtype;
  v_pay_mode text;
begin
  if p_checkout_request_id is null
     or p_offer_evidence_id is null
     or p_offer_snapshot_sha256 is null
     or p_offer_snapshot_sha256 !~ '^[0-9a-f]{64}$'
     or pg_catalog.char_length(coalesce(p_product_name, ''))
          not between 1 and 200
     or p_product_name <> pg_catalog.btrim(p_product_name)
     or p_product_name ~ '[[:cntrl:]]'
     or p_withdrawal_copy_version is distinct from
          'checkout-withdrawal-limit-2026-07-30-v1'
     or p_withdrawal_copy is distinct from
          '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.'
     or p_withdrawal_confirmed is distinct from true then
    raise exception 'withdrawal_limit_confirmation_required'
      using errcode = 'P0001';
  end if;

  -- The private 008899 core acquires order -> config -> member locks and
  -- validates the authoritative product amount, lifecycle, unresolved-intent
  -- inventory, and complete PortOne tuple.
  v_receipt := public.bp_008905_create_or_reuse_pending_order_impl(
    p_user,
    p_order_uuid,
    p_product_id,
    p_amount,
    p_credits,
    p_payment_id,
    p_provider,
    p_pay_channel,
    p_is_test,
    p_expected_store_id,
    p_expected_currency,
    p_expected_channel_key
  );

  begin
    v_order_uuid := (v_receipt->>'order_uuid')::uuid;
    v_order_user := (v_receipt->>'user_id')::uuid;
    v_order_product := v_receipt->>'product_id';
    v_order_amount := (v_receipt->>'amount')::integer;
    v_order_credits := (v_receipt->>'credits')::integer;
    v_order_is_test := (v_receipt->>'is_test')::boolean;
    v_order_channel := v_receipt->>'pay_channel';
  exception
    when invalid_text_representation
      or numeric_value_out_of_range then
      raise exception 'checkout_receipt_invalid' using errcode = 'P0001';
  end;
  v_pay_mode := case when v_order_is_test then 'test' else 'live' end;
  if v_order_uuid is null
     or v_order_user is distinct from p_user
     or v_order_product is distinct from p_product_id
     or v_order_amount is null
     or v_order_credits is null
     or v_order_channel is distinct from p_pay_channel then
    raise exception 'checkout_receipt_invalid' using errcode = 'P0001';
  end if;

  select elem->>'goodname'
    into v_current_product_name
    from public.app_settings s
    cross join lateral pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(s.value->'products') = 'array'
          then s.value->'products'
        else '[]'::jsonb
      end
    ) elem
   where s.key = 'growth_levers'
     and elem->>'productId' = p_product_id
     and coalesce((elem->>'active')::boolean, false)
   limit 1;
  if v_current_product_name is distinct from p_product_name then
    raise exception 'checkout_product_name_changed' using errcode = 'P0001';
  end if;

  select *
    into v_offer
    from public.commerce_display_evidence e
   where e.id = p_offer_evidence_id
   for share;
  if not found
     or v_offer.surface is distinct from 'credits_offer'
     or v_offer.snapshot_sha256 is distinct from
          p_offer_snapshot_sha256 then
    raise exception 'checkout_offer_evidence_mismatch'
      using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_typeof(v_offer.snapshot) is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_offer.snapshot->'products')
          is distinct from 'array'
     or pg_catalog.jsonb_typeof(v_offer.snapshot->'channels')
          is distinct from 'array'
     or pg_catalog.jsonb_typeof(v_offer.snapshot->'displayCopy')
          is distinct from 'object' then
    raise exception 'checkout_offer_evidence_mismatch'
      using errcode = 'P0001';
  end if;
  if (
       select pg_catalog.count(*)
         from pg_catalog.jsonb_object_keys(
           v_offer.snapshot
         ) as snapshot_key
     ) <> 7
     or (
       select pg_catalog.count(*)
         from pg_catalog.jsonb_object_keys(
           v_offer.snapshot->'displayCopy'
         ) as display_copy_key
     ) <> 8
     or v_offer.snapshot->>'schemaVersion' is distinct from '1'
     or v_offer.snapshot->>'copyVersion' is distinct from
          'credits-offer-2026-07-30-v1'
     or v_offer.snapshot->>'surface' is distinct from 'credits_offer'
     or v_offer.snapshot->>'payMode' is distinct from v_pay_mode
     or v_offer.snapshot->'displayCopy'->>'summary' is distinct from
          '캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.'
     or v_offer.snapshot->'displayCopy'->>'supply' is distinct from
          '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.'
     or v_offer.snapshot->'displayCopy'->>'validity' is distinct from
          '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.'
     or v_offer.snapshot->'displayCopy'->>'refund' is distinct from
          '미사용 생성권은 환불받을 수 있어요(무료로 지급받은 생성권은 제외). 일부만 사용했더라도 남은 수량만큼 환불돼요. 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한돼요.'
     or v_offer.snapshot->'displayCopy'->>'refundReferencePrefix'
          is distinct from '정확한 산정 기준·차감 순서·절차는'
     or v_offer.snapshot->'displayCopy'->>'termsLinkLabel'
          is distinct from '이용약관 제10조'
     or v_offer.snapshot->'displayCopy'->>'refundReferenceSuffix'
          is distinct from '를 확인해주세요.'
     or v_offer.snapshot->'displayCopy'->>'price' is distinct from
          '표시 가격은 부가세 포함 최종 결제 금액이에요.'
     or not exists (
       select 1
         from pg_catalog.jsonb_array_elements(
           v_offer.snapshot->'products'
         ) product
        where pg_catalog.jsonb_typeof(product) = 'object'
          and (
            select pg_catalog.count(*)
              from pg_catalog.jsonb_object_keys(
                case
                  when pg_catalog.jsonb_typeof(product) = 'object'
                    then product
                  else '{}'::jsonb
                end
              ) as product_key
          ) = 4
          and product->>'productId' = v_order_product
          and product->>'goodname' = p_product_name
          and product->>'priceKrwVatIncluded' =
                v_order_amount::text
          and product->>'credits' = v_order_credits::text
     )
     or not exists (
       select 1
         from pg_catalog.jsonb_array_elements(
           v_offer.snapshot->'channels'
         ) channel
        where pg_catalog.jsonb_typeof(channel) = 'object'
          and (
            select pg_catalog.count(*)
              from pg_catalog.jsonb_object_keys(
                case
                  when pg_catalog.jsonb_typeof(channel) = 'object'
                    then channel
                  else '{}'::jsonb
                end
              ) as channel_key
          ) = 2
          and channel->>'method' = v_order_channel
          and channel->>'label' = case v_order_channel
                when 'card' then '카드'
                when 'tosspay' then '토스페이'
                when 'kakaopay' then '카카오페이'
                else null
              end
     ) then
    raise exception 'checkout_offer_evidence_mismatch'
      using errcode = 'P0001';
  end if;

  select *
    into v_existing
    from public.checkout_withdrawal_acceptance_evidence e
   where e.request_id = p_checkout_request_id
   for update;
  if found then
    if v_existing.order_uuid is distinct from v_order_uuid
       or v_existing.user_id is distinct from p_user
       or v_existing.product_id is distinct from v_order_product
       or v_existing.product_name is distinct from p_product_name
       or v_existing.amount is distinct from v_order_amount
       or v_existing.credits is distinct from v_order_credits
       or v_existing.pay_mode is distinct from v_pay_mode
       or v_existing.pay_channel is distinct from v_order_channel
       or v_existing.offer_evidence_id is distinct from
            p_offer_evidence_id
       or v_existing.offer_snapshot_sha256 is distinct from
            p_offer_snapshot_sha256
       or v_existing.copy_version is distinct from
            p_withdrawal_copy_version
       or v_existing.confirmation_copy is distinct from
            p_withdrawal_copy
       or v_existing.confirmed is distinct from true then
      raise exception 'checkout_request_conflict' using errcode = 'P0001';
    end if;
    v_evidence := v_existing;
  else
    perform pg_catalog.set_config(
      'boss_paegi.checkout_withdrawal_evidence',
      'record:008905:v1',
      true
    );
    insert into public.checkout_withdrawal_acceptance_evidence(
      request_id,
      order_uuid,
      user_id,
      product_id,
      product_name,
      amount,
      credits,
      pay_mode,
      pay_channel,
      offer_evidence_id,
      offer_snapshot_sha256,
      copy_version,
      confirmation_copy,
      confirmed
    )
    values (
      p_checkout_request_id,
      v_order_uuid,
      p_user,
      v_order_product,
      p_product_name,
      v_order_amount,
      v_order_credits,
      v_pay_mode,
      v_order_channel,
      p_offer_evidence_id,
      p_offer_snapshot_sha256,
      p_withdrawal_copy_version,
      p_withdrawal_copy,
      true
    )
    returning * into v_evidence;
  end if;

  return v_receipt || pg_catalog.jsonb_build_object(
    'withdrawal_evidence_id', v_evidence.id,
    'checkout_request_id', v_evidence.request_id,
    'withdrawal_product_name', v_evidence.product_name,
    'withdrawal_pay_mode', v_evidence.pay_mode,
    'withdrawal_offer_evidence_id', v_evidence.offer_evidence_id,
    'withdrawal_offer_snapshot_sha256',
      v_evidence.offer_snapshot_sha256,
    'withdrawal_copy_version', v_evidence.copy_version,
    'withdrawal_confirmation_copy', v_evidence.confirmation_copy,
    'withdrawal_confirmed', v_evidence.confirmed,
    'withdrawal_accepted_at', v_evidence.accepted_at
  );
end;
$$;
revoke all on function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,
  uuid,text,uuid,text,text,text,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,
  uuid,text,uuid,text,text,text,boolean
) to service_role;

-- ── fal end-user age/flow-down evidence ────────────────────────────────────

create table public.generation_provider_acceptance_evidence (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  user_id uuid not null references public.member_accounts(user_id)
    on delete restrict,
  withdrawal_generation bigint not null check (
    withdrawal_generation between 0 and 9007199254740991
  ),
  service_terms_version integer not null check (
    service_terms_version >= 1
  ),
  service_privacy_version integer not null check (
    service_privacy_version >= 1
  ),
  bundle_version text not null check (
    bundle_version =
      'fal-tos-2026-03-03-aup-captured-2026-07-30-v1'
  ),
  provider_terms_version date not null default date '2026-03-03'
    check (provider_terms_version = date '2026-03-03'),
  provider_aup_captured_on date not null default date '2026-07-30'
    check (provider_aup_captured_on = date '2026-07-30'),
  adult_age_threshold smallint not null default 19 check (
    adult_age_threshold = 19
  ),
  adult_self_attested boolean not null check (adult_self_attested),
  fal_terms_accepted boolean not null check (fal_terms_accepted),
  fal_aup_accepted boolean not null check (fal_aup_accepted),
  terms_url text not null default 'https://fal.ai/legal/terms-of-service'
    check (terms_url = 'https://fal.ai/legal/terms-of-service'),
  aup_url text not null default 'https://fal.ai/legal/acceptable-use-policy'
    check (aup_url = 'https://fal.ai/legal/acceptable-use-policy'),
  accepted_at timestamptz not null default clock_timestamp(),
  unique (user_id, bundle_version, withdrawal_generation)
);

comment on table public.generation_provider_acceptance_evidence is
  '기본 만14세 게이트와 별개인 AI 생성 만19세 자기확인 + fal ToS/AUP flow-down의 불변 증적. 생년월일이나 연령 인증값은 저장하지 않는다. 탈퇴 세대에 결속해 재활성 시 재확인을 요구하고 5년 뒤 bounded prune한다.';

alter table public.generation_provider_acceptance_evidence
  enable row level security;
revoke all on table public.generation_provider_acceptance_evidence
  from public, anon, authenticated, service_role;
grant select on table public.generation_provider_acceptance_evidence
  to service_role;

create or replace function public.bp_generation_provider_evidence_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting(
           'boss_paegi.generation_provider_acceptance_prune',
           true
         ) = 'prune:008905:v1'
     and old.accepted_at <
           clock_timestamp() - interval '5 years' then
    return old;
  end if;
  raise exception 'generation_provider_acceptance_immutable'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_generation_provider_evidence_immutable()
  from public, anon, authenticated, service_role;

create trigger trg_generation_provider_evidence_immutable
before update or delete
on public.generation_provider_acceptance_evidence
for each row
execute function public.bp_generation_provider_evidence_immutable();

create or replace function public.record_generation_provider_acceptance(
  p_user_id uuid,
  p_request_id uuid,
  p_bundle_version text,
  p_adult_self_attested boolean,
  p_fal_terms_accepted boolean,
  p_fal_aup_accepted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_member public.member_accounts%rowtype;
  v_existing public.generation_provider_acceptance_evidence%rowtype;
  v_today date :=
    (clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_current_terms integer;
  v_current_privacy integer;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'acceptance_identity_required' using errcode = 'P0001';
  end if;
  if p_bundle_version <>
       'fal-tos-2026-03-03-aup-captured-2026-07-30-v1'
     or p_adult_self_attested is distinct from true
     or p_fal_terms_accepted is distinct from true
     or p_fal_aup_accepted is distinct from true then
    raise exception 'generation_provider_acceptance_required'
      using errcode = 'P0001';
  end if;

  -- Publish/unpublish owns legal:terms -> legal:privacy. Acquire the same
  -- order before the member lock so the evidence can never be stamped against
  -- a stale legal-consent snapshot.
  perform public.bp_0084_legal_consent_locks(true, true);
  perform public.bp_user_mutation_lock(p_user_id);
  select * into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  select * into v_member
    from public.member_accounts
   where user_id = p_user_id
   for update;
  select l.version
    into v_current_terms
    from public.legal_documents l
   where l.doc_type = 'terms'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  select l.version
    into v_current_privacy
    from public.legal_documents l
   where l.doc_type = 'privacy'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  if v_profile.id is null
     or v_member.user_id is null
     or v_profile.deleted_at is not null
     or v_current_terms is null
     or v_current_privacy is null
     or v_member.age_confirmed_at is null
     or coalesce(v_member.terms_version, 0) < v_current_terms
     or coalesce(v_member.privacy_version, 0) < v_current_privacy then
    raise exception 'generation_provider_member_ineligible'
      using errcode = 'P0001';
  end if;

  select * into v_existing
    from public.generation_provider_acceptance_evidence
   where request_id = p_request_id;
  if found then
    if v_existing.user_id <> p_user_id
       or v_existing.bundle_version <> p_bundle_version
       or v_existing.withdrawal_generation is distinct from
            v_profile.withdrawal_generation then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'eligible', true,
      'evidence_id', v_existing.id,
      'bundle_version', v_existing.bundle_version,
      'accepted_at', v_existing.accepted_at,
      'idempotent', true
    );
  end if;

  select * into v_existing
    from public.generation_provider_acceptance_evidence
   where user_id = p_user_id
     and bundle_version = p_bundle_version
     and withdrawal_generation = v_profile.withdrawal_generation;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'eligible', true,
      'evidence_id', v_existing.id,
      'bundle_version', v_existing.bundle_version,
      'accepted_at', v_existing.accepted_at,
      'idempotent', true
    );
  end if;

  insert into public.generation_provider_acceptance_evidence(
    request_id,
    user_id,
    withdrawal_generation,
    service_terms_version,
    service_privacy_version,
    bundle_version,
    adult_self_attested,
    fal_terms_accepted,
    fal_aup_accepted
  )
  values (
    p_request_id,
    p_user_id,
    v_profile.withdrawal_generation,
    v_current_terms,
    v_current_privacy,
    p_bundle_version,
    p_adult_self_attested,
    p_fal_terms_accepted,
    p_fal_aup_accepted
  )
  on conflict (request_id) do nothing
  returning * into v_existing;

  -- Different users do not share the user-mutation lock. A globally reused
  -- request UUID can therefore race at the unique index; converge on the
  -- winner and return only when it is the exact same acceptance identity.
  if not found then
    select * into v_existing
      from public.generation_provider_acceptance_evidence
     where request_id = p_request_id;
    if not found
       or v_existing.user_id <> p_user_id
       or v_existing.bundle_version <> p_bundle_version
       or v_existing.withdrawal_generation is distinct from
            v_profile.withdrawal_generation then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'eligible', true,
      'evidence_id', v_existing.id,
      'bundle_version', v_existing.bundle_version,
      'accepted_at', v_existing.accepted_at,
      'idempotent', true
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'eligible', true,
    'evidence_id', v_existing.id,
    'bundle_version', v_existing.bundle_version,
    'accepted_at', v_existing.accepted_at,
    'idempotent', false
  );
end;
$$;

create or replace function public.generation_provider_acceptance_status(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_row public.generation_provider_acceptance_evidence%rowtype;
  v_withdrawal_generation bigint;
  v_terms_version integer;
  v_privacy_version integer;
  v_current_terms integer;
  v_current_privacy integer;
  v_today date :=
    (current_timestamp at time zone 'Asia/Seoul')::date;
begin
  if p_user_id is null then
    raise exception 'user_id_required' using errcode = 'P0001';
  end if;
  select p.withdrawal_generation, m.terms_version, m.privacy_version
    into v_withdrawal_generation, v_terms_version, v_privacy_version
    from public.profiles p
    join public.member_accounts m on m.user_id = p.id
   where p.id = p_user_id
     and p.deleted_at is null
     and m.age_confirmed_at is not null;
  select l.version
    into v_current_terms
    from public.legal_documents l
   where l.doc_type = 'terms'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  select l.version
    into v_current_privacy
    from public.legal_documents l
   where l.doc_type = 'privacy'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  if v_withdrawal_generation is null
     or v_current_terms is null
     or v_current_privacy is null
     or coalesce(v_terms_version, 0) < v_current_terms
     or coalesce(v_privacy_version, 0) < v_current_privacy then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'eligible', false,
      'bundle_version',
        'fal-tos-2026-03-03-aup-captured-2026-07-30-v1'
    );
  end if;
  select * into v_row
    from public.generation_provider_acceptance_evidence
   where user_id = p_user_id
     and bundle_version =
       'fal-tos-2026-03-03-aup-captured-2026-07-30-v1'
     and withdrawal_generation = v_withdrawal_generation;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'eligible', found,
    'bundle_version',
      'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
    'accepted_at', case when found then v_row.accepted_at else null end
  );
end;
$$;

create or replace function public.prune_generation_provider_acceptance_evidence(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed integer := 0;
  v_has_more boolean := false;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_limit' using errcode = 'P0001';
  end if;
  perform pg_catalog.set_config(
    'boss_paegi.generation_provider_acceptance_prune',
    'prune:008905:v1',
    true
  );
  with candidates as (
    select e.id
      from public.generation_provider_acceptance_evidence e
     where e.accepted_at < clock_timestamp() - interval '5 years'
     order by e.accepted_at, e.id
     limit p_limit
     for update skip locked
  ),
  removed as (
    delete from public.generation_provider_acceptance_evidence e
     using candidates c
     where e.id = c.id
     returning e.id
  )
  select pg_catalog.count(*)::integer
    into v_processed
    from removed;

  select exists (
    select 1
      from public.generation_provider_acceptance_evidence e
     where e.accepted_at < clock_timestamp() - interval '5 years'
  ) into v_has_more;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'has_more', v_has_more
  );
end;
$$;

revoke all on function public.record_generation_provider_acceptance(
  uuid,uuid,text,boolean,boolean,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_provider_acceptance(
  uuid,uuid,text,boolean,boolean,boolean
) to service_role;
revoke all on function public.generation_provider_acceptance_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.generation_provider_acceptance_status(uuid)
  to service_role;
revoke all on function public.prune_generation_provider_acceptance_evidence(
  integer
) from public, anon, authenticated, service_role;
grant execute on function public.prune_generation_provider_acceptance_evidence(
  integer
) to service_role;

do $postflight$
declare
  v_signature text;
  v_checkout_def text;
begin
  foreach v_signature in array array[
    'public.record_commerce_display_evidence(text,jsonb)',
    'public.prune_commerce_display_evidence(integer)',
    'public.record_generation_provider_acceptance(uuid,uuid,text,boolean,boolean,boolean)',
    'public.generation_provider_acceptance_status(uuid)',
    'public.prune_generation_provider_acceptance_evidence(integer)',
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or not pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       ) then
      raise exception '008905 postflight: function ACL drift (%)',
        v_signature;
    end if;
  end loop;
  if pg_catalog.has_table_privilege(
       'service_role',
       'public.commerce_display_evidence',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.commerce_display_evidence',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.commerce_display_evidence',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.generation_provider_acceptance_evidence',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.generation_provider_acceptance_evidence',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.generation_provider_acceptance_evidence',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.checkout_withdrawal_acceptance_evidence',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.checkout_withdrawal_acceptance_evidence',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.checkout_withdrawal_acceptance_evidence',
       'DELETE'
     ) then
    raise exception '008905 postflight: direct evidence DML exposed';
  end if;
  if pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_008905_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
       'EXECUTE'
     ) then
    raise exception '008905 postflight: private checkout implementation exposed';
  end if;
  select pg_catalog.pg_get_functiondef(
           'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'::regprocedure
         )
    into v_checkout_def;
  if pg_catalog.to_regprocedure(
       'pg_catalog.jsonb_object_keys(jsonb)'
     ) is null
     or pg_catalog.strpos(
          v_checkout_def,
          'pg_catalog.jsonb_object_keys'
        ) = 0
     or pg_catalog.strpos(v_checkout_def, 'jsonb_object_length') > 0 then
    raise exception '008905 postflight: checkout JSON key-count compatibility drift';
  end if;
end;
$postflight$;

insert into public.schema_migration_journal(
  version,
  migration_hash,
  manifest_hash,
  app_commit
)
values (
  '008905_legal_commerce_generation_compliance',
  null,
  null,
  null
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
