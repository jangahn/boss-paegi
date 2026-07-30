-- 0091_payment_evidence_contract_validate.sql
--
-- Validate the historical PortOne inventory without holding the short
-- ACCESS EXCLUSIVE lock from 0090. Ordinary row writes remain available while
-- PostgreSQL scans the table under ShareUpdateExclusive.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

alter table public.orders
  validate constraint orders_portone_payment_evidence_required_check;

do $$
declare
  v_constraint_def text;
  v_index_def text;
begin
  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_constraint_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.orders'::regclass
     and c.conname = 'orders_portone_payment_evidence_required_check'
     and c.contype = 'c'
     and c.convalidated;
  if v_constraint_def is distinct from
       'check(((providerisdistinctfrom''portone''::text)or((payment_idisnotnull)and(payment_id=replace((order_uuid)::text,''-''::text,''''::text))and(expected_store_idisnotnull)and(expected_currencyisnotnull)and(expected_channel_keyisnotnull))))' then
    raise exception '0091 validation: required payment evidence CHECK drift';
  end if;

  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_index_def
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
   where i.indrelid = 'public.orders'::regclass
     and idx.relname =
           'orders_one_unresolved_portone_intent_per_user_uidx'
     and i.indisunique
     and i.indisvalid
     and i.indisready;
  if v_index_def is distinct from
       'createuniqueindexorders_one_unresolved_portone_intent_per_user_uidxonpublic.ordersusingbtree(user_id)where((provider=''portone''::text)and(status=any(array[''pending''::text,''failed''::text]))and(paid_atisnull)and(canceled_atisnull))' then
    raise exception '0091 validation: unresolved PortOne unique index drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0091_payment_evidence_contract_validate', null, null, null)
on conflict (version) do nothing;

commit;
