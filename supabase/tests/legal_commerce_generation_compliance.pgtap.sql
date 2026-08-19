-- 008905: immutable commerce display evidence and fal age/flow-down evidence.

begin;
select plan(41);

select ok(
  to_regclass('public.commerce_display_evidence') is not null
  and to_regclass(
    'public.generation_provider_acceptance_evidence'
  ) is not null
  and to_regclass(
    'public.checkout_withdrawal_acceptance_evidence'
  ) is not null,
  'all compliance evidence tables exist'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.record_commerce_display_evidence(text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.prune_commerce_display_evidence(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.record_generation_provider_acceptance(uuid,uuid,text,boolean,boolean,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.generation_provider_acceptance_status(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.prune_generation_provider_acceptance_evidence(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
    'EXECUTE'
  ),
  'service role can use only the bounded compliance RPCs'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.record_commerce_display_evidence(text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.record_generation_provider_acceptance(uuid,uuid,text,boolean,boolean,boolean)',
    'EXECUTE'
  ),
  'client roles cannot call compliance evidence RPCs'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.commerce_display_evidence',
    'INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.generation_provider_acceptance_evidence',
    'INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.checkout_withdrawal_acceptance_evidence',
    'INSERT,UPDATE,DELETE'
  ),
  'service role cannot bypass immutable evidence RPCs with direct DML'
);

select is(
  public.bp_legal_full_notice_valid(
    date '2026-08-30',
    timestamptz '2026-07-30 14:59:59.999999+00',
    30
  ),
  true,
  'legal notice accepts one microsecond beyond the full 30-day interval'
);
select is(
  public.bp_legal_full_notice_valid(
    date '2026-08-30',
    timestamptz '2026-07-30 15:00:00+00',
    30
  ),
  true,
  'legal notice accepts the exact full 30-day interval'
);
select is(
  public.bp_legal_full_notice_valid(
    date '2026-08-30',
    timestamptz '2026-07-30 15:00:00.000001+00',
    30
  ),
  false,
  'legal notice rejects one microsecond short of 30 full days'
);
select is(
  public.bp_legal_full_notice_valid(
    date '2028-03-01',
    (
      date '2028-03-01'::timestamp at time zone 'Asia/Seoul'
    ) - interval '30 days',
    30
  ),
  true,
  'legal notice interval remains exact across leap-day month end'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.legal_documents'::regclass
       and tgname = 'trg_legal_full_notice_guard'
       and not tgisinternal
  ),
  'legal documents have an authoritative version >= 2 notice trigger'
);

select throws_ok(
  $$
    select public.record_generation_provider_acceptance(
      '95000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000002',
      'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
      true,
      false,
      true
    )
  $$,
  'P0001',
  'generation_provider_acceptance_required',
  'all three affirmative facts are mandatory'
);

-- Generation eligibility must be checked against real current legal
-- authority. Bootstrap the notice-exempt initial publications on a fresh DB;
-- any existing later currently-effective version remains authoritative.
insert into public.legal_documents(
  doc_type,
  status,
  version,
  effective_date,
  title,
  sections
)
values
  (
    'terms',
    'published',
    1,
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    'Generation compliance QA terms',
    '[{"heading":"Terms","body":"Current terms"}]'::jsonb
  ),
  (
    'privacy',
    'published',
    1,
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    'Generation compliance QA privacy',
    '[{"heading":"Privacy","body":"Current privacy"}]'::jsonb
  )
on conflict (doc_type, version) where status = 'published'
do update
  set effective_date = excluded.effective_date,
      title = excluded.title,
      sections = excluded.sections,
      updated_at = clock_timestamp();

insert into auth.users(id, email)
values (
  '95000000-0000-4000-8000-000000000001',
  'generation-compliance@test.local'
);
insert into public.member_accounts(
  user_id,
  email,
  age_confirmed_at,
  terms_version,
  privacy_version
)
values (
  '95000000-0000-4000-8000-000000000001',
  'generation-compliance@test.local',
  clock_timestamp(),
  (
    select l.version
      from public.legal_documents l
     where l.doc_type = 'terms'
       and l.status = 'published'
       and l.effective_date <=
             (clock_timestamp() at time zone 'Asia/Seoul')::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1
  ),
  (
    select l.version
      from public.legal_documents l
     where l.doc_type = 'privacy'
       and l.status = 'published'
       and l.effective_date <=
             (clock_timestamp() at time zone 'Asia/Seoul')::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1
  )
);

create temporary table qa_generation_acceptance as
select public.record_generation_provider_acceptance(
  '95000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000002',
  'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
  true,
  true,
  true
) as result;

select is(
  (select result->>'eligible' from qa_generation_acceptance),
  'true',
  'eligible acceptance is durably recorded'
);
select is(
  (select result->>'idempotent' from qa_generation_acceptance),
  'false',
  'first acceptance reports a new immutable record'
);
select is(
  (
    select public.record_generation_provider_acceptance(
      '95000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000002',
      'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
      true,
      true,
      true
    )->>'idempotent'
  ),
  'true',
  'response-loss retry converges on the same evidence'
);
select is(
  (
    select public.generation_provider_acceptance_status(
      '95000000-0000-4000-8000-000000000001'
    )->>'eligible'
  ),
  'true',
  'status RPC observes the immutable acceptance'
);
select ok(
  (
    select e.withdrawal_generation = p.withdrawal_generation
       and e.service_terms_version = m.terms_version
       and e.service_privacy_version = m.privacy_version
      from public.generation_provider_acceptance_evidence e
      join public.profiles p on p.id = e.user_id
      join public.member_accounts m on m.user_id = e.user_id
     where e.user_id = '95000000-0000-4000-8000-000000000001'
  ),
  'acceptance pins the current profile lifecycle and legal versions'
);
update public.member_accounts
   set terms_version = null
 where user_id = '95000000-0000-4000-8000-000000000001';
select is(
  (
    select public.generation_provider_acceptance_status(
      '95000000-0000-4000-8000-000000000001'
    )->>'eligible'
  ),
  'false',
  'missing or stale current legal consent invalidates provider eligibility'
);
update public.member_accounts
   set terms_version = (
         select l.version
           from public.legal_documents l
          where l.doc_type = 'terms'
            and l.status = 'published'
            and l.effective_date <=
                  (clock_timestamp() at time zone 'Asia/Seoul')::date
          order by l.effective_date desc, l.version desc, l.id desc
          limit 1
       ),
       privacy_version = (
         select l.version
           from public.legal_documents l
          where l.doc_type = 'privacy'
            and l.status = 'published'
            and l.effective_date <=
                  (clock_timestamp() at time zone 'Asia/Seoul')::date
          order by l.effective_date desc, l.version desc, l.id desc
          limit 1
       )
 where user_id = '95000000-0000-4000-8000-000000000001';
set local session_replication_role = replica;
update public.profiles
   set withdrawal_generation = withdrawal_generation + 1
 where id = '95000000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
select is(
  (
    select public.generation_provider_acceptance_status(
      '95000000-0000-4000-8000-000000000001'
    )->>'eligible'
  ),
  'false',
  'an older withdrawal lifecycle never revives after reactivation'
);
create temporary table qa_generation_reacceptance as
select public.record_generation_provider_acceptance(
  '95000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000003',
  'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
  true,
  true,
  true
) as result;
select ok(
  (
    select q.result->>'idempotent' = 'false'
       and e.withdrawal_generation = p.withdrawal_generation
      from qa_generation_reacceptance q
      join public.generation_provider_acceptance_evidence e
        on e.id = (q.result->>'evidence_id')::uuid
      join public.profiles p on p.id = e.user_id
  ),
  'a new lifecycle requires and stores a fresh provider acceptance'
);
select throws_ok(
  $$
    select public.record_generation_provider_acceptance(
      '95000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000002',
      'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
      true,
      true,
      true
    )
  $$,
  'P0001',
  'request_conflict',
  'an old request id cannot be replayed into a newer lifecycle'
);
select throws_ok(
  $$
    update public.generation_provider_acceptance_evidence
       set accepted_at = accepted_at + interval '1 second'
     where user_id = '95000000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'generation_provider_acceptance_immutable',
  'generation acceptance cannot be rewritten'
);
select throws_ok(
  $$
    delete from public.generation_provider_acceptance_evidence
     where user_id = '95000000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'generation_provider_acceptance_immutable',
  'generation acceptance cannot be deleted'
);
select throws_ok(
  $$select public.prune_generation_provider_acceptance_evidence(101)$$,
  'P0001',
  'invalid_limit',
  'provider acceptance retention worker is bounded'
);

insert into auth.users(id, email)
values (
  '95000000-0000-4000-8000-000000000010',
  'generation-retention@test.local'
);
insert into public.member_accounts(user_id, email)
values (
  '95000000-0000-4000-8000-000000000010',
  'generation-retention@test.local'
);
insert into public.generation_provider_acceptance_evidence(
  id,
  request_id,
  user_id,
  withdrawal_generation,
  service_terms_version,
  service_privacy_version,
  bundle_version,
  adult_self_attested,
  fal_terms_accepted,
  fal_aup_accepted,
  accepted_at
)
values
  (
    '95000000-0000-4000-8000-000000000011',
    '95000000-0000-4000-8000-000000000012',
    '95000000-0000-4000-8000-000000000010',
    0,
    1,
    1,
    'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
    true,
    true,
    true,
    clock_timestamp() - interval '5 years 1 minute'
  ),
  (
    '95000000-0000-4000-8000-000000000013',
    '95000000-0000-4000-8000-000000000014',
    '95000000-0000-4000-8000-000000000010',
    1,
    1,
    1,
    'fal-tos-2026-03-03-aup-captured-2026-07-30-v1',
    true,
    true,
    true,
    clock_timestamp() - interval '5 years' + interval '1 minute'
  );
create temporary table qa_provider_prune as
select public.prune_generation_provider_acceptance_evidence(100) as result;
select is(
  (select result->>'processed' from qa_provider_prune),
  '1',
  'only provider evidence strictly older than five years is pruned'
);
select is(
  (
    select count(*)::text
      from public.generation_provider_acceptance_evidence
     where id = '95000000-0000-4000-8000-000000000011'
  ),
  '0',
  'expired provider acceptance evidence is removed'
);
select is(
  (
    select count(*)::text
      from public.generation_provider_acceptance_evidence
     where id = '95000000-0000-4000-8000-000000000013'
  ),
  '1',
  'provider evidence inside the five-year minimum remains'
);

create temporary table qa_commerce_record as
select public.record_commerce_display_evidence(
  'credits_offer',
  '{"copyVersion":"qa-v1","price":3000}'::jsonb
) as result;

select ok(
  (select result->>'snapshot_sha256' from qa_commerce_record)
    ~ '^[0-9a-f]{64}$'
  and (
    select (result->>'retain_until_at_least')::timestamptz
      > (result->>'last_displayed_at')::timestamptz
    from qa_commerce_record
  ),
  'display evidence returns its canonical hash and minimum-retention date'
);
select is(
  (
    select public.record_commerce_display_evidence(
      'credits_offer',
      '{"price":3000,"copyVersion":"qa-v1"}'::jsonb
    )->>'evidence_id'
  ),
  (select result->>'evidence_id' from qa_commerce_record),
  'same canonical JSONB snapshot converges within one KST date'
);
select is(
  (
    select snapshot_sha256
      from public.commerce_display_evidence
     where id =
       (select (result->>'evidence_id')::uuid from qa_commerce_record)
  ),
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        '{"price": 3000, "copyVersion": "qa-v1"}'::jsonb::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ),
  'stored hash is derived from PostgreSQL canonical JSONB text'
);
select throws_ok(
  $$
    update public.commerce_display_evidence
       set snapshot = '{"tampered":true}'::jsonb
     where id =
       (select (result->>'evidence_id')::uuid from qa_commerce_record)
  $$,
  'P0001',
  'commerce_display_evidence_immutable',
  'display snapshot cannot be rewritten'
);
select throws_ok(
  $$
    select public.record_commerce_display_evidence(
      'unknown_surface',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'invalid_display_surface',
  'unknown display surfaces are rejected'
);
select throws_ok(
  $$select public.prune_commerce_display_evidence(101)$$,
  'P0001',
  'invalid_limit',
  'display retention worker is bounded'
);

select pg_catalog.set_config(
  'boss_paegi.commerce_display_evidence',
  'record:008905:v1',
  true
);
insert into public.commerce_display_evidence(
  id,
  surface,
  snapshot,
  snapshot_sha256,
  display_kst_date,
  first_displayed_at,
  last_displayed_at
)
select
  input.id,
  'checkout_withdrawal_limit',
  input.snapshot,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(input.snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  (input.displayed_at at time zone 'Asia/Seoul')::date,
  input.displayed_at,
  input.displayed_at
from (
  values
    (
      '95000000-0000-4000-8000-000000000101'::uuid,
      '{"boundary":"expired"}'::jsonb,
      clock_timestamp() - interval '6 months 1 minute'
    ),
    (
      '95000000-0000-4000-8000-000000000102'::uuid,
      '{"boundary":"inside"}'::jsonb,
      clock_timestamp() - interval '6 months' + interval '1 minute'
    )
) as input(id, snapshot, displayed_at);

create temporary table qa_commerce_prune as
select public.prune_commerce_display_evidence(100) as result;
select is(
  (select result->>'processed' from qa_commerce_prune),
  '1',
  'only evidence strictly older than six months is pruned'
);
select is(
  (
    select pg_catalog.count(*)::text
      from public.commerce_display_evidence
     where id = '95000000-0000-4000-8000-000000000101'
  ),
  '0',
  'expired display evidence is removed'
);
select is(
  (
    select pg_catalog.count(*)::text
      from public.commerce_display_evidence
     where id = '95000000-0000-4000-8000-000000000102'
  ),
  '1',
  'display evidence inside the six-month minimum remains'
);

insert into auth.users(id, email)
values (
  '95000000-0000-4000-8000-000000000201',
  'checkout-withdrawal@test.local'
);
insert into public.member_accounts(user_id, email)
values (
  '95000000-0000-4000-8000-000000000201',
  'checkout-withdrawal@test.local'
);
insert into public.app_settings(key, value)
values (
  'growth_levers',
  pg_catalog.jsonb_build_object(
    'products',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'productId', 'qa_withdrawal_checkout',
        'goodname', 'QA withdrawal checkout',
        'price', 1700,
        'credits', 7,
        'active', true
      )
    )
  )
)
on conflict (key) do update set value = excluded.value;

create temporary table qa_checkout_offer as
select public.record_commerce_display_evidence(
  'credits_offer',
  pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'copyVersion', 'credits-offer-2026-08-19-v3',
    'surface', 'credits_offer',
    'payMode', 'live',
    'products', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'productId', 'qa_withdrawal_checkout',
        'goodname', 'QA withdrawal checkout',
        'priceKrwVatIncluded', 1700,
        'credits', 7
      )
    ),
    'channels', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'method', 'card',
        'label', '카드'
      )
    ),
    'displayCopy', pg_catalog.jsonb_build_object(
      'supply',
        '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.',
      'validity',
        '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.',
      'refund',
        '미사용 생성권은 환불받을 수 있어요(무료 지급분 제외, 일부 사용 시 남은 수량만큼).',
      'refundReferencePrefix',
        '기준·차감 순서·절차는',
      'termsLinkLabel', '이용약관 제10조',
      'refundReferenceSuffix', '를 확인해주세요.'
    )
  )
) as result;

create temporary table qa_checkout_withdrawal as
select public.create_or_reuse_pending_order(
  '95000000-0000-4000-8000-000000000201',
  '95000000-0000-4000-8000-000000000202',
  'qa_withdrawal_checkout',
  1700,
  7,
  '95000000000040008000000000000202',
  'portone',
  'card',
  false,
  'store-qa',
  'KRW',
  'channel-card-live',
  '95000000-0000-4000-8000-000000000203',
  'QA withdrawal checkout',
  (
    select (result->>'evidence_id')::uuid
      from qa_checkout_offer
  ),
  (
    select result->>'snapshot_sha256'
      from qa_checkout_offer
  ),
  'checkout-withdrawal-limit-2026-08-19-v2',
  '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
  true
) as result;
select ok(
  (
    select q.result->>'outcome' = 'ready'
       and q.result->>'withdrawal_confirmed' = 'true'
       and e.order_uuid =
             (q.result->>'order_uuid')::uuid
       and e.user_id =
             '95000000-0000-4000-8000-000000000201'::uuid
       and e.product_name = 'QA withdrawal checkout'
       and e.amount = 1700
       and e.credits = 7
       and e.pay_mode = 'live'
       and e.pay_channel = 'card'
       and e.confirmed
      from qa_checkout_withdrawal q
      join public.checkout_withdrawal_acceptance_evidence e
        on e.id = (q.result->>'withdrawal_evidence_id')::uuid
  ),
  'checkout atomically stores every affirmative withdrawal fact'
);
select is(
  (
    select public.create_or_reuse_pending_order(
      '95000000-0000-4000-8000-000000000201',
      '95000000-0000-4000-8000-000000000202',
      'qa_withdrawal_checkout',
      1700,
      7,
      '95000000000040008000000000000202',
      'portone',
      'card',
      false,
      'store-rotated',
      'KRW',
      'channel-rotated',
      '95000000-0000-4000-8000-000000000203',
      'QA withdrawal checkout',
      (
        select (result->>'evidence_id')::uuid
          from qa_checkout_offer
      ),
      (
        select result->>'snapshot_sha256'
          from qa_checkout_offer
      ),
      'checkout-withdrawal-limit-2026-08-19-v2',
      '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
      true
    )->>'withdrawal_evidence_id'
  ),
  (
    select result->>'withdrawal_evidence_id'
      from qa_checkout_withdrawal
  ),
  'response-loss replay converges on one withdrawal evidence row'
);
select throws_ok(
  $$
    select public.create_or_reuse_pending_order(
      '95000000-0000-4000-8000-000000000201',
      '95000000-0000-4000-8000-000000000204',
      'qa_withdrawal_checkout',
      1700,
      7,
      '95000000000040008000000000000204',
      'portone',
      'card',
      false,
      'store-qa',
      'KRW',
      'channel-card-live',
      '95000000-0000-4000-8000-000000000205',
      'QA withdrawal checkout',
      (
        select (result->>'evidence_id')::uuid
          from qa_checkout_offer
      ),
      (
        select result->>'snapshot_sha256'
          from qa_checkout_offer
      ),
      'checkout-withdrawal-limit-2026-08-19-v2',
      '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
      false
    )
  $$,
  'P0001',
  'withdrawal_limit_confirmation_required',
  'false confirmation cannot create or reuse a charge-capable order'
);
select is(
  (
    select count(*)::text
      from public.orders
     where user_id = '95000000-0000-4000-8000-000000000201'
  ),
  '1',
  'rejected confirmation leaves no second durable order'
);
select throws_ok(
  $$
    update public.checkout_withdrawal_acceptance_evidence
       set confirmation_copy = 'tampered'
     where request_id =
       '95000000-0000-4000-8000-000000000203'
  $$,
  'P0001',
  'checkout_withdrawal_evidence_immutable',
  'checkout withdrawal evidence cannot be rewritten'
);
select throws_ok(
  $$
    delete from public.checkout_withdrawal_acceptance_evidence
     where request_id =
       '95000000-0000-4000-8000-000000000203'
  $$,
  'P0001',
  'checkout_withdrawal_evidence_immutable',
  'checkout withdrawal evidence cannot be directly deleted'
);

select ok(
  exists (
    select 1
      from public.schema_migration_journal
     where version = '008905_legal_commerce_generation_compliance'
  ),
  '008905 migration receipt exists'
);

select * from finish();
rollback;
