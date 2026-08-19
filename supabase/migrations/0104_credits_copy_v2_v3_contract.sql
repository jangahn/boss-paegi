-- 0104: /credits 고지 문구 v2/v3 를 DB 계약에 반영 — 결제 전면 거절 복구 (긴급)
--
-- 사고(2026-08-19 밤): v0.86/v0.88 이 코드측 문구·copyVersion 을 갱신했지만, 008905 는
-- 같은 값을 ①checkout_withdrawal_acceptance_evidence 테이블 CHECK ②create_or_reuse_
-- pending_order 함수의 byte-exact 검증 리터럴로도 박제하고 있었다(코드만 바꾸면 계약
-- 위반) → 배포 직후부터 모든 checkout 이 withdrawal_limit_confirmation_required 로 거절.
-- 교훈: 고지 문구/copyVersion 은 코드·DB 양측 계약 — 변경 시 반드시 마이그레이션 동반.
--
-- 내용: CHECK 는 (v1|v2) 허용으로 교체(기존 v1 증거 행 보존 — 불변 증거), 함수는
-- 리터럴을 현행 코드 값(withdrawal v2 · offer v3: summary/price 검증 제거·refund 압축·
-- displayCopy 키수 8→6)으로 교체한 body-only 재정의(시그니처·ACL·잠금 순서 불변).

alter table public.checkout_withdrawal_acceptance_evidence
  drop constraint checkout_withdrawal_acceptance_evidence_copy_version_check;
alter table public.checkout_withdrawal_acceptance_evidence
  add constraint checkout_withdrawal_acceptance_evidence_copy_version_check check (
    copy_version in (
      'checkout-withdrawal-limit-2026-07-30-v1',
      'checkout-withdrawal-limit-2026-08-19-v2'
    )
  );
alter table public.checkout_withdrawal_acceptance_evidence
  drop constraint checkout_withdrawal_acceptance_evidence_confirmation_copy_check;
alter table public.checkout_withdrawal_acceptance_evidence
  add constraint checkout_withdrawal_acceptance_evidence_confirmation_copy_check check (
    confirmation_copy in (
      '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
      '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.'
    )
  );

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
          'checkout-withdrawal-limit-2026-08-19-v2'
     or p_withdrawal_copy is distinct from
          '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.'
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
     ) <> 6
     or v_offer.snapshot->>'schemaVersion' is distinct from '1'
     or v_offer.snapshot->>'copyVersion' is distinct from
          'credits-offer-2026-08-19-v3'
     or v_offer.snapshot->>'surface' is distinct from 'credits_offer'
     or v_offer.snapshot->>'payMode' is distinct from v_pay_mode
     or v_offer.snapshot->'displayCopy'->>'supply' is distinct from
          '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.'
     or v_offer.snapshot->'displayCopy'->>'validity' is distinct from
          '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.'
     or v_offer.snapshot->'displayCopy'->>'refund' is distinct from
          '미사용 생성권은 환불받을 수 있어요(무료 지급분 제외, 일부 사용 시 남은 수량만큼).'
     or v_offer.snapshot->'displayCopy'->>'refundReferencePrefix'
          is distinct from '기준·차감 순서·절차는'
     or v_offer.snapshot->'displayCopy'->>'termsLinkLabel'
          is distinct from '이용약관 제10조'
     or v_offer.snapshot->'displayCopy'->>'refundReferenceSuffix'
          is distinct from '를 확인해주세요.'
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
