-- 0087_payment_evidence_expand_ddl.sql
--
-- Short, retry-safe DDL phase for the payment-evidence expand. Keep every
-- orders-table lock in this small transaction; the much larger function/ACL
-- rollout lives in the later 008899 file and never holds ACCESS EXCLUSIVE on
-- public.orders.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.orders
  add column if not exists expected_store_id text,
  add column if not exists expected_currency text,
  add column if not exists expected_channel_key text;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.orders'::regclass
       and c.conname = 'orders_payment_evidence_snapshot_check'
  ) then
    alter table public.orders
      add constraint orders_payment_evidence_snapshot_check check (
        (
          expected_store_id is null
          and expected_currency is null
          and expected_channel_key is null
        )
        or (
          expected_store_id is not null
          and expected_currency is not null
          and expected_channel_key is not null
          and pg_catalog.char_length(expected_store_id) between 1 and 128
          and expected_store_id = pg_catalog.btrim(expected_store_id)
          and expected_store_id !~ '[[:cntrl:]]'
          and expected_currency = 'KRW'
          and pg_catalog.char_length(expected_channel_key) between 1 and 256
          and expected_channel_key = pg_catalog.btrim(expected_channel_key)
          and expected_channel_key !~ '[[:cntrl:]]'
        )
      ) not valid;
  end if;
end;
$$;

-- A NULL legacy snapshot may be adopted once by the bounded rollout-backfill
-- RPC. Once complete, the three values are immutable even if a future server
-- route regains column UPDATE.
create or replace function public.bp_guard_order_payment_evidence_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if row(
       new.expected_store_id,
       new.expected_currency,
       new.expected_channel_key
     ) is distinct from row(
       old.expected_store_id,
       old.expected_currency,
       old.expected_channel_key
     )
     and not (
       old.expected_store_id is null
       and old.expected_currency is null
       and old.expected_channel_key is null
       and new.expected_store_id is not null
       and new.expected_currency is not null
       and new.expected_channel_key is not null
     ) then
    raise exception 'payment_evidence_snapshot_immutable'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_guard_order_payment_evidence_snapshot()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_orders_payment_evidence_snapshot
  on public.orders;
create trigger trg_orders_payment_evidence_snapshot
  before update of
    expected_store_id,
    expected_currency,
    expected_channel_key
  on public.orders
  for each row
  execute function public.bp_guard_order_payment_evidence_snapshot();

-- A PortOne payment id remains charge-capable in both pending and failed
-- states. Enforce the complete user inventory invariant below every RPC so a
-- direct service-role INSERT or a future caller cannot create two late-payable
-- intents. Existing duplicate inventory blocks rollout for provider-backed
-- resolution instead of being silently canonicalized.
--
-- A populated production table must have this index prebuilt with
-- CREATE UNIQUE INDEX CONCURRENTLY before 0087. The only in-migration fallback
-- is an objectively empty table (fresh local reset), where there is no
-- inventory scan or live write traffic to block. This fail-closed split keeps
-- a fresh empty-database bootstrap through the repository's explicit migration
-- runner possible without allowing an accidental regular index build against
-- production data.
do $$
declare
  v_index_def text;
begin
  if exists (
    select 1
      from public.orders o
     where o.provider = 'portone'
       and o.status in ('pending', 'failed')
       and o.paid_at is null
       and o.canceled_at is null
     group by o.user_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception
      '0087 preflight: duplicate unresolved PortOne intents require resolution';
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

  if v_index_def is null then
    if exists (select 1 from public.orders limit 1) then
      raise exception
        '0087 preflight: populated orders require concurrent unresolved-intent index prebuild';
    end if;

    execute $index$
      create unique index
        orders_one_unresolved_portone_intent_per_user_uidx
        on public.orders (user_id)
        where provider = 'portone'
          and status in ('pending', 'failed')
          and paid_at is null
          and canceled_at is null
    $index$;

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
  end if;

  if v_index_def is distinct from
       'createuniqueindexorders_one_unresolved_portone_intent_per_user_uidxonpublic.ordersusingbtree(user_id)where((provider=''portone''::text)and(status=any(array[''pending''::text,''failed''::text]))and(paid_atisnull)and(canceled_atisnull))' then
    raise exception
      '0087 preflight: unresolved PortOne unique index drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0087_payment_evidence_expand_ddl', null, null, null)
on conflict (version) do nothing;

commit;
