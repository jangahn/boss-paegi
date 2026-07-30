-- 0090_payment_evidence_contract_constraint.sql
--
-- First contract phase. The provider-backed backfill and old-request drain
-- must be complete before this short transaction installs the permanent
-- PortOne evidence requirement. NOT VALID still protects every new write;
-- historical validation is deliberately isolated in 0091.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if exists (
    select 1
      from public.orders o
     where (
             o.expected_store_id is null
             or o.expected_currency is null
             or o.expected_channel_key is null
           )
       and (
             o.expected_store_id is not null
             or o.expected_currency is not null
             or o.expected_channel_key is not null
           )
  ) then
    raise exception
      '0090 contract: partial payment evidence snapshot remains';
  end if;
  if exists (
    select 1
      from public.orders o
     where o.provider = 'portone'
       and o.payment_id is null
  ) then
    raise exception
      '0090 contract: PortOne order without payment id remains';
  end if;
  if exists (
    select 1
      from public.orders o
     where o.provider = 'portone'
       and o.payment_id is not null
       and o.expected_store_id is null
       and o.expected_currency is null
       and o.expected_channel_key is null
  ) then
    raise exception
      '0090 contract: legacy PortOne payment evidence backfill remains';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.orders'::regclass
       and c.conname =
             'orders_portone_payment_evidence_required_check'
  ) then
    alter table public.orders
      add constraint orders_portone_payment_evidence_required_check
      check (
        provider is distinct from 'portone'
        or (
          payment_id is not null
          and payment_id =
            pg_catalog.replace(order_uuid::text, '-', '')
          and expected_store_id is not null
          and expected_currency is not null
          and expected_channel_key is not null
        )
      ) not valid;
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0090_payment_evidence_contract_constraint', null, null, null)
on conflict (version) do nothing;

commit;
