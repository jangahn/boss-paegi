-- 008800_payment_evidence_expand_validate.sql
--
-- Validation takes ShareUpdateExclusive rather than ACCESS EXCLUSIVE and does
-- not block ordinary INSERT/UPDATE/DELETE traffic. It is separate from the
-- short DDL phase so neither lock is held through the large rollout migration.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

alter table public.orders
  validate constraint orders_payment_evidence_snapshot_check;

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
     and c.conname = 'orders_payment_evidence_snapshot_check'
     and c.contype = 'c'
     and c.convalidated;
  if v_constraint_def is distinct from
       'check((((expected_store_idisnull)and(expected_currencyisnull)and(expected_channel_keyisnull))or((expected_store_idisnotnull)and(expected_currencyisnotnull)and(expected_channel_keyisnotnull)and((char_length(expected_store_id)>=1)and(char_length(expected_store_id)<=128))and(expected_store_id=btrim(expected_store_id))and(expected_store_id!~''[[:cntrl:]]''::text)and(expected_currency=''krw''::text)and((char_length(expected_channel_key)>=1)and(char_length(expected_channel_key)<=256))and(expected_channel_key=btrim(expected_channel_key))and(expected_channel_key!~''[[:cntrl:]]''::text))))' then
    raise exception '008800 validation: payment evidence shape constraint drift';
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
    raise exception '008800 validation: unresolved PortOne unique index drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('008800_payment_evidence_expand_validate', null, null, null)
on conflict (version) do nothing;

commit;
