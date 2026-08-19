-- 0105: 고지 문구 계약을 registry 전문 등록제로 단일화 + checkout 단일 검증 계층
--
-- checkout 구조 재설계 3/3 (docs/checkout-rework.md PR-C).
-- ① `commerce_copy_registry` — 고지 문구의 (surface, copy_version, 원문 jsonb)
--    등록 테이블. RPC 는 제출 문구가 active 행과 **jsonb 등가**인지로만 검증한다
--    — 함수 리터럴·테이블 CHECK 박제(0104 까지의 구조, 2026-08-19 전면 차단
--    사고의 원인)를 철거. 문구 변경 = 코드 상수 수정 + seed 마이그레이션 1개
--    (`npm run gen:copy-registry-migration`) — 함수는 불변.
-- ② `create_or_reuse_pending_order` 를 20-arg 로 재정의: prior-intent 를
--    예외가 아닌 정상 반환(`needs_provider_resolution` + intents 목록)으로
--    알리고, 호출측이 포트원 비-PAID 실측 결과(p_prior_resolutions)를 들고
--    재호출하면 같은 트랜잭션에서 종단 후 생성한다. reuse(같은 상품·수단
--    이어서 열기)는 유지. 구 19-arg 는 drop(오버로드 모호성 방지 — 배포는
--    creditsEnabled OFF 컷오버).
-- ③ 증거 테이블의 문구 CHECK 2종 drop — 기록 경로는 RPC 단일 + registry 검증.

begin;

-- ── ① copy registry ──────────────────────────────────────────────────────────
create table public.commerce_copy_registry (
  surface text not null
    check (surface in ('credits_offer', 'checkout_withdrawal_limit')),
  copy_version text not null
    check (pg_catalog.char_length(copy_version) between 1 and 100),
  copy jsonb not null,
  active boolean not null default false,
  registered_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (surface, copy_version)
);
comment on table public.commerce_copy_registry is
  '결제 고지 문구 원문 등록부 — 원본은 코드 상수(lib/pay), 검증은 jsonb 등가. '
  'seed 는 gen:copy-registry-migration 산출 형식만 사용.';
alter table public.commerce_copy_registry enable row level security;
revoke all on public.commerce_copy_registry
  from public, anon, authenticated, service_role;
create unique index commerce_copy_registry_one_active_per_surface
  on public.commerce_copy_registry (surface)
  where active;

-- copy-registry-seed credits_offer credits-offer-2026-07-30-v1 active=false
insert into public.commerce_copy_registry (surface, copy_version, copy, active)
values (
  'credits_offer',
  'credits-offer-2026-07-30-v1',
  $copyjson${"summary": "캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.", "supply": "생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.", "validity": "구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.", "refund": "미사용 생성권은 환불받을 수 있어요(무료로 지급받은 생성권은 제외). 일부만 사용했더라도 남은 수량만큼 환불돼요. 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한돼요.", "refundReferencePrefix": "정확한 산정 기준·차감 순서·절차는", "termsLinkLabel": "이용약관 제10조", "refundReferenceSuffix": "를 확인해주세요.", "price": "표시 가격은 부가세 포함 최종 결제 금액이에요."}$copyjson$::jsonb,
  false
)
on conflict (surface, copy_version) do nothing;
-- copy-registry-seed credits_offer credits-offer-2026-08-19-v3 active=true
insert into public.commerce_copy_registry (surface, copy_version, copy, active)
values (
  'credits_offer',
  'credits-offer-2026-08-19-v3',
  $copyjson${"supply": "생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.", "validity": "구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.", "refund": "미사용 생성권은 환불받을 수 있어요(무료 지급분 제외, 일부 사용 시 남은 수량만큼).", "refundReferencePrefix": "기준·차감 순서·절차는", "termsLinkLabel": "이용약관 제10조", "refundReferenceSuffix": "를 확인해주세요."}$copyjson$::jsonb,
  true
)
on conflict (surface, copy_version) do nothing;
-- copy-registry-seed checkout_withdrawal_limit checkout-withdrawal-limit-2026-07-30-v1 active=false
insert into public.commerce_copy_registry (surface, copy_version, copy, active)
values (
  'checkout_withdrawal_limit',
  'checkout-withdrawal-limit-2026-07-30-v1',
  $copyjson$"구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다."$copyjson$::jsonb,
  false
)
on conflict (surface, copy_version) do nothing;
-- copy-registry-seed checkout_withdrawal_limit checkout-withdrawal-limit-2026-08-19-v2 active=true
insert into public.commerce_copy_registry (surface, copy_version, copy, active)
values (
  'checkout_withdrawal_limit',
  'checkout-withdrawal-limit-2026-08-19-v2',
  $copyjson$"이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요."$copyjson$::jsonb,
  true
)
on conflict (surface, copy_version) do nothing;

-- ── ② checkout RPC 재정의 ────────────────────────────────────────────────────
drop function public.create_or_reuse_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text, uuid, text, uuid, text, text, text, boolean
);

create or replace function public.bp_0105_create_or_reuse_pending_order_impl(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount integer;
  v_credits integer;
  v_deleted_at timestamptz;
  v_order public.orders%rowtype;
  v_candidate public.orders%rowtype;
  v_candidate_count integer := 0;
  v_intents jsonb := '[]'::jsonb;
  v_reusable boolean := false;
  v_outcome text;
begin
  if p_user is null
     or p_order_uuid is null
     or p_provider is distinct from 'portone'
     or coalesce(p_pay_channel, '') not in (
       'card', 'tosspay', 'kakaopay'
     )
     or p_is_test is null
     or p_payment_id is distinct from
          pg_catalog.replace(p_order_uuid::text, '-', '')
     or pg_catalog.char_length(coalesce(p_payment_id, ''))
          not between 1 and 500
     or p_payment_id ~ '[[:cntrl:]]'
     or pg_catalog.char_length(coalesce(p_expected_store_id, ''))
          not between 1 and 128
     or p_expected_store_id <> pg_catalog.btrim(p_expected_store_id)
     or p_expected_store_id ~ '[[:cntrl:]]'
     or p_expected_currency is distinct from 'KRW'
     or pg_catalog.char_length(coalesce(p_expected_channel_key, ''))
          not between 1 and 256
     or p_expected_channel_key <>
          pg_catalog.btrim(p_expected_channel_key)
     or p_expected_channel_key ~ '[[:cntrl:]]' then
    raise exception 'invalid_payment_evidence_snapshot'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  perform public.bp_checkout_config_lock();
  perform public.bp_user_mutation_lock(p_user);

  select (elem->>'price')::integer, (elem->>'credits')::integer
    into v_amount, v_credits
    from public.app_settings s
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(s.value->'products', '[]'::jsonb)
    ) elem
   where s.key = 'growth_levers'
     and elem->>'productId' = p_product_id
     and coalesce((elem->>'active')::boolean, false);
  if v_amount is null then
    raise exception 'invalid_product' using errcode = 'P0001';
  end if;
  if p_amount is distinct from v_amount
     or p_credits is distinct from v_credits then
    raise exception 'product_amount_mismatch' using errcode = 'P0001';
  end if;

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

  -- Same payment id means a transport replay of this exact candidate.
  select *
    into v_order
    from public.orders o
   where o.payment_id = p_payment_id
   for update;
  if found then
    if v_order.order_uuid is distinct from p_order_uuid
       or v_order.user_id is distinct from p_user
       or v_order.product_id is distinct from p_product_id
       or v_order.status not in ('pending', 'failed')
       or v_order.provider is distinct from 'portone'
       or v_order.is_test is distinct from p_is_test
       or v_order.pay_channel is distinct from p_pay_channel
       or v_order.paid_at is not null
       or v_order.canceled_at is not null then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    if v_order.expected_store_id is null
       and v_order.expected_currency is null
       and v_order.expected_channel_key is null then
      raise exception 'legacy_checkout_refresh_required'
        using errcode = 'P0001';
    end if;
    if v_order.expected_store_id is null
       or v_order.expected_currency is null
       or v_order.expected_channel_key is null then
      raise exception 'checkout_evidence_conflict' using errcode = 'P0001';
    end if;
    v_outcome := 'replayed';
  else
    -- Once checkout parameters have reached any browser, a later tab must not
    -- mint a second charge-capable payment id while the first is still able to
    -- become PAID. This includes old pending rows and quasi-terminal failed
    -- rows: PortOne permits the same payment id to be retried until success.
    -- Serialize the complete unresolved user inventory, not a recent-window
    -- heuristic. A different product/mode/method is a visible conflict rather
    -- than an implicit supersession that an old tab could later double-charge.
    for v_candidate in
      select *
        from public.orders o
       where o.user_id = p_user
         and o.provider = 'portone'
         and o.status in ('pending', 'failed')
         and o.paid_at is null
         and o.canceled_at is null
       order by o.created_at desc, o.order_uuid desc
       limit 11
       for update
    loop
      v_candidate_count := v_candidate_count + 1;
      v_order := v_candidate;
      v_intents := v_intents || pg_catalog.jsonb_build_object(
        'order_uuid', v_candidate.order_uuid,
        'payment_id', v_candidate.payment_id
      );
    end loop;
    if v_candidate_count = 1
       and v_order.product_id is not distinct from p_product_id
       and v_order.is_test is not distinct from p_is_test
       and v_order.pay_channel is not distinct from p_pay_channel
       and v_order.payment_id is not null
       and v_order.payment_id is not distinct from
             pg_catalog.replace(v_order.order_uuid::text, '-', '')
       and v_order.expected_store_id is not null
       and v_order.expected_currency is not null
       and v_order.expected_channel_key is not null then
      v_reusable := true;
    end if;
    if v_candidate_count >= 1 and not v_reusable then
      -- 미해결 intent 가 있으나 이어서 열 수 없는 조합(다른 상품/수단·legacy·
      -- 다건) — 예외가 아니라 정상 반환으로 정리 대상을 알린다. 호출측(route)이
      -- 건별 포트원 비-PAID 실측을 마친 뒤 p_prior_resolutions 로 재호출하면
      -- wrapper 가 같은 트랜잭션에서 종단하고 이 경로는 소멸한다.
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'needs_provider_resolution',
        'intents', v_intents
      );
    end if;
    if v_reusable then
      v_outcome := 'reused';
    else
      insert into public.orders (
        order_uuid,
        user_id,
        product_id,
        amount,
        credits,
        status,
        provider,
        payment_id,
        is_test,
        pay_channel,
        expected_store_id,
        expected_currency,
        expected_channel_key
      )
      values (
        p_order_uuid,
        p_user,
        p_product_id,
        p_amount,
        p_credits,
        'pending',
        'portone',
        p_payment_id,
        p_is_test,
        p_pay_channel,
        p_expected_store_id,
        p_expected_currency,
        p_expected_channel_key
      )
      returning * into v_order;
      v_outcome := 'ready';
    end if;
  end if;

  if v_order.expected_store_id is null
     and v_order.expected_currency is null
     and v_order.expected_channel_key is null then
    raise exception 'legacy_checkout_refresh_required'
      using errcode = 'P0001';
  end if;

  if v_order.order_uuid is null
     or v_order.user_id is distinct from p_user
     or v_order.product_id is distinct from p_product_id
     or v_order.amount is null
     or v_order.amount <= 0
     or v_order.credits is null
     or v_order.credits <= 0
     or v_order.status not in ('pending', 'failed')
     or v_order.provider is distinct from 'portone'
     or v_order.payment_id is null
     or v_order.payment_id is distinct from
       pg_catalog.replace(v_order.order_uuid::text, '-', '')
     or v_order.is_test is distinct from p_is_test
     or v_order.pay_channel is distinct from p_pay_channel
     or v_order.expected_store_id is null
     or v_order.expected_currency is distinct from 'KRW'
     or v_order.expected_channel_key is null
     or (
       v_outcome = 'ready'
       and (
         v_order.amount is distinct from p_amount
         or v_order.credits is distinct from p_credits
         or v_order.status is distinct from 'pending'
         or v_order.expected_store_id is distinct from p_expected_store_id
         or v_order.expected_channel_key is distinct from
              p_expected_channel_key
       )
     )
     or v_order.paid_at is not null
     or v_order.canceled_at is not null then
    raise exception 'checkout_receipt_invalid' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', v_outcome,
    'order_uuid', v_order.order_uuid,
    'payment_id', v_order.payment_id,
    'user_id', v_order.user_id,
    'product_id', v_order.product_id,
    'amount', v_order.amount,
    'credits', v_order.credits,
    'status', v_order.status,
    'provider', v_order.provider,
    'is_test', v_order.is_test,
    'pay_channel', v_order.pay_channel,
    'expected_store_id', v_order.expected_store_id,
    'expected_currency', v_order.expected_currency,
    'expected_channel_key', v_order.expected_channel_key,
    'paid_at', v_order.paid_at,
    'canceled_at', v_order.canceled_at
  );
end;
$$;
revoke all on function public.bp_0105_create_or_reuse_pending_order_impl(
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text
) from public, anon, authenticated, service_role;

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
  p_withdrawal_confirmed boolean,
  p_prior_resolutions jsonb default null
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
  v_registry_copy jsonb;
  v_resolution jsonb;
  v_resolution_uuid uuid;
  v_resolution_owner uuid;
  v_resolution_status text;
begin
  if p_checkout_request_id is null
     or p_offer_evidence_id is null
     or p_offer_snapshot_sha256 is null
     or p_offer_snapshot_sha256 !~ '^[0-9a-f]{64}$'
     or pg_catalog.char_length(coalesce(p_product_name, ''))
          not between 1 and 200
     or p_product_name <> pg_catalog.btrim(p_product_name)
     or p_product_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(coalesce(p_withdrawal_copy_version, ''))
          not between 1 and 100
     or pg_catalog.char_length(coalesce(p_withdrawal_copy, ''))
          not between 1 and 1000
     or p_withdrawal_confirmed is distinct from true then
    raise exception 'withdrawal_limit_confirmation_required'
      using errcode = 'P0001';
  end if;
  -- 문구 계약의 단일 검증: 코드가 보낸 (version, 원문) 이 registry 의 active
  -- 행과 jsonb 등가여야 한다. 문구 변경 = registry seed 마이그레이션 1개
  -- (npm run gen:copy-registry-migration) — 함수 본문은 불변.
  perform 1
    from public.commerce_copy_registry r
   where r.surface = 'checkout_withdrawal_limit'
     and r.copy_version = p_withdrawal_copy_version
     and r.active
     and r.copy = pg_catalog.to_jsonb(p_withdrawal_copy);
  if not found then
    raise exception 'withdrawal_limit_confirmation_required'
      using errcode = 'P0001';
  end if;

  if p_prior_resolutions is not null then
    if pg_catalog.jsonb_typeof(p_prior_resolutions) is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_prior_resolutions) not between 1 and 10 then
      raise exception 'checkout_resolution_invalid' using errcode = 'P0001';
    end if;
    for v_resolution in
      select value from pg_catalog.jsonb_array_elements(p_prior_resolutions)
    loop
      begin
        v_resolution_uuid := (v_resolution->>'order_uuid')::uuid;
      exception when invalid_text_representation then
        raise exception 'checkout_resolution_invalid' using errcode = 'P0001';
      end;
      v_resolution_status := v_resolution->>'pg_status';
      if v_resolution_uuid is null
         or pg_catalog.char_length(coalesce(v_resolution_status, ''))
              not between 1 and 40
         or v_resolution_status ~ '[^A-Z_0-9]' then
        raise exception 'checkout_resolution_invalid' using errcode = 'P0001';
      end if;
      select o.user_id into v_resolution_owner
        from public.orders o
       where o.order_uuid = v_resolution_uuid;
      if v_resolution_owner is distinct from p_user then
        raise exception 'checkout_resolution_invalid' using errcode = 'P0001';
      end if;
      -- 종단은 공식 RPC — 미지급·pending/failed 가드와 멱등은 그쪽 소유.
      perform public.mark_order_canceled_unpaid(
        v_resolution_uuid,
        v_resolution_status,
        null,
        pg_catalog.jsonb_build_object(
          'reason', 'checkout_prior_intent_auto_resolve',
          'observed', v_resolution->'raw'
        )
      );
    end loop;
  end if;

  -- The private 008899 core acquires order -> config -> member locks and
  -- validates the authoritative product amount, lifecycle, unresolved-intent
  -- inventory, and complete PortOne tuple.
  v_receipt := public.bp_0105_create_or_reuse_pending_order_impl(
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

  if v_receipt->>'outcome' = 'needs_provider_resolution' then
    return v_receipt;
  end if;

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
  -- displayCopy 는 registry 의 active 원문과 jsonb 등가여야 한다 — 키 수·문구
  -- 리터럴을 함수에 박제하지 않는다(2026-08-19 문구 계약 사고의 재발 방지 구조).
  select r.copy
    into v_registry_copy
    from public.commerce_copy_registry r
   where r.surface = 'credits_offer'
     and r.copy_version = v_offer.snapshot->>'copyVersion'
     and r.active;
  if not found then
    raise exception 'checkout_offer_evidence_mismatch'
      using errcode = 'P0001';
  end if;
  if (
       select pg_catalog.count(*)
         from pg_catalog.jsonb_object_keys(
           v_offer.snapshot
         ) as snapshot_key
     ) <> 7
     or v_offer.snapshot->>'schemaVersion' is distinct from '1'
     or v_offer.snapshot->>'surface' is distinct from 'credits_offer'
     or v_offer.snapshot->>'payMode' is distinct from v_pay_mode
     or v_offer.snapshot->'displayCopy' is distinct from v_registry_copy
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
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text, uuid, text, uuid, text, text, text, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.create_or_reuse_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text, uuid, text, uuid, text, text, text, boolean, jsonb
) to service_role;

-- 구 impl(008905 rename 사슬)은 wrapper 가 더는 부르지 않는다 — 잔존 코드 제거.
drop function public.bp_008905_create_or_reuse_pending_order_impl(
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text
);

-- ── ③ 증거 테이블 문구 CHECK 철거 ────────────────────────────────────────────
alter table public.checkout_withdrawal_acceptance_evidence
  drop constraint checkout_withdrawal_acceptance_evidence_copy_version_check;
alter table public.checkout_withdrawal_acceptance_evidence
  drop constraint checkout_withdrawal_acceptance_evidence_confirmation_copy_check;

-- ── postflight ───────────────────────────────────────────────────────────────
do $postflight$
declare
  v_def text;
  v_impl text;
begin
  if (select pg_catalog.count(*) from public.commerce_copy_registry) <> 4
     or (select pg_catalog.count(*)
           from public.commerce_copy_registry where active) <> 2 then
    raise exception '0105 postflight: registry seed rows are wrong';
  end if;
  if pg_catalog.to_regprocedure(
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
     ) is not null then
    raise exception '0105 postflight: legacy 19-arg checkout overload survived';
  end if;
  v_def := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean,jsonb)'
  ));
  if v_def is null
     or v_def not like '%commerce_copy_registry%'
     or v_def like '%credits-offer-2026-%'
     or v_def like '%청약철회가 제한%' then
    raise exception '0105 postflight: wrapper still pins copy literals';
  end if;
  v_impl := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
    'public.bp_0105_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
  ));
  if v_impl is null
     or v_impl not like '%needs_provider_resolution%'
     or v_impl like '%checkout_reuse_ambiguous%' then
    raise exception '0105 postflight: impl prior-intent contract is wrong';
  end if;
  if pg_catalog.to_regprocedure(
       'public.bp_008905_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
     ) is not null then
    raise exception '0105 postflight: superseded 008905 impl survived';
  end if;
  if exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid =
       pg_catalog.to_regclass('public.checkout_withdrawal_acceptance_evidence')
       and conname in (
         'checkout_withdrawal_acceptance_evidence_copy_version_check',
         'checkout_withdrawal_acceptance_evidence_confirmation_copy_check'
       )
  ) then
    raise exception '0105 postflight: evidence copy CHECKs survived';
  end if;
end;
$postflight$;

commit;

notify pgrst, 'reload schema';
