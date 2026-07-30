-- 008904_privacy_retention_controls.sql
--
-- Published privacy contract:
--   * payment/contract records: five years;
--   * consumer complaint/dispute records: three years.
--
-- The payment graph is intentionally append-only during its legal retention
-- window. After five years this migration keeps only a monthly, non-identifying
-- accounting aggregate and removes the detailed order/refund graph in one
-- transaction. An order is never eligible while any payment, refund, credit,
-- cancellation, or reconciliation state is still operational.
--
-- In-service UGC/right-infringement complaints are `content_reports`. Pending
-- reports are unresolved and are never removed. The first terminal timestamp
-- is immutable; strictly after three years the worker keeps only a monthly,
-- non-identifying aggregate and a payload-hash replay tombstone, then removes
-- the report, reporter/contact/detail, and report-linked moderation ledger.
-- External email complaints are an explicit, non-blocking manual-runbook
-- boundary with the same terminal+3y rule instead of being silently ignored.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $preflight$
declare
  v_name text;
begin
  foreach v_name in array array[
    'orders',
    'content_reports',
    'content_report_submission_receipts',
    'moderation_actions_ledger',
    'moderation_purge_jobs',
    'public_write_attempts',
    'dolls',
    'credit_lots',
    'refund_requests',
    'order_refund_attempts',
    'cancellation_resolution_batches',
    'payment_cancellation_events',
    'reconciliation_issues',
    'credit_refund_shortfalls',
    'legacy_refund_backfill_evidence',
    'credit_ledger',
    'admin_actions_ledger',
    'ai_generations',
    'schema_migration_journal'
  ]
  loop
    if pg_catalog.to_regclass('public.' || v_name) is null then
      raise exception '008904 preflight: missing public.%', v_name;
    end if;
  end loop;

  if pg_catalog.to_regprocedure('public.bp_forbid_delete()') is null
     or pg_catalog.to_regprocedure('public.refund_attempts_lifecycle()') is null
     or pg_catalog.to_regprocedure('public.crb_guard()') is null
     or pg_catalog.to_regprocedure('public.legacy_evidence_freeze()') is null
     or pg_catalog.to_regprocedure('public.ledger_append_only_guard()') is null
     or pg_catalog.to_regprocedure(
          'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_touch_report_doll_moderation_version()'
        ) is null
     or pg_catalog.to_regprocedure(
          'extensions.crypt(text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'extensions.gen_salt(text,integer)'
        ) is null
  then
    raise exception '008904 preflight: retention dependencies missing';
  end if;
end;
$preflight$;

-- The two references below form the only cycle in the payment detail graph:
-- attempt.pg_cancel_id -> cancellation event and event.matched_attempt_id ->
-- attempt. They remain immediate by default but may be deferred by the
-- retention transaction so both terminal rows can be removed atomically.
alter table public.order_refund_attempts
  alter constraint refund_attempts_pg_cancel_fkey
  deferrable initially immediate;
alter table public.payment_cancellation_events
  alter constraint cancellation_events_matched_order_fkey
  deferrable initially immediate;

create table public.payment_retention_monthly_aggregates (
  month_utc date not null,
  provider text not null,
  terminal_status text not null
    check (terminal_status in ('paid', 'canceled', 'failed')),
  is_test boolean not null,
  order_count numeric not null default 0 check (order_count >= 0),
  gross_amount numeric not null default 0 check (gross_amount >= 0),
  granted_credits numeric not null default 0 check (granted_credits >= 0),
  refunded_amount numeric not null default 0 check (refunded_amount >= 0),
  refunded_credits numeric not null default 0 check (refunded_credits >= 0),
  first_compacted_at timestamptz not null default pg_catalog.now(),
  last_compacted_at timestamptz not null default pg_catalog.now(),
  primary key (month_utc, provider, terminal_status, is_test)
);

comment on table public.payment_retention_monthly_aggregates is
  '5년 경과 결제 상세 파기 후 남기는 월/provider/status/test 단위 무식별 최소 합계. 사용자·주문·PG 거래 식별자는 저장하지 않는다.';

alter table public.payment_retention_monthly_aggregates enable row level security;
revoke all on table public.payment_retention_monthly_aggregates
  from public, anon, authenticated, service_role;
grant select on table public.payment_retention_monthly_aggregates
  to service_role;

create table public.content_report_retention_monthly_aggregates (
  month_utc date not null,
  terminal_status text not null check (
    terminal_status in ('actioned', 'dismissed', 'already_removed')
  ),
  reason_code text not null check (
    reason_code in ('portrait', 'defamation', 'obscene', 'hate', 'other')
  ),
  record_count numeric not null default 0 check (record_count >= 0),
  first_compacted_at timestamptz not null default pg_catalog.now(),
  last_compacted_at timestamptz not null default pg_catalog.now(),
  primary key (month_utc, terminal_status, reason_code)
);

comment on table public.content_report_retention_monthly_aggregates is
  '3년 경과 서비스 내 신고 원문 파기 후 남기는 월/status/reason allowlist 단위 무식별 최소 합계. 신고자·연락처·상세·콘텐츠·신고 식별자는 저장하지 않는다.';

alter table public.content_report_retention_monthly_aggregates
  enable row level security;
revoke all on table public.content_report_retention_monthly_aggregates
  from public, anon, authenticated, service_role;
grant select on table public.content_report_retention_monthly_aggregates
  to service_role;

-- A report's first terminal timestamp is the three-year legal anchor. Legacy
-- terminal rows are backfilled only from their already-recorded resolved_at;
-- a terminal row lacking that timestamp remains blocked rather than guessing.
alter table public.content_reports
  add column if not exists retention_terminal_at timestamptz;
update public.content_reports
   set retention_terminal_at = resolved_at
 where status in ('actioned', 'dismissed')
   and retention_terminal_at is null
   and resolved_at is not null;
alter table public.content_reports
  drop constraint if exists content_reports_retention_terminal_shape,
  add constraint content_reports_retention_terminal_shape check (
    (
      status = 'pending'
      and resolved_at is null
      and retention_terminal_at is null
    )
    or (
      status in ('actioned', 'dismissed')
      and (
        (resolved_at is null and retention_terminal_at is null)
        or (
          resolved_at is not null
          and retention_terminal_at is not null
          and resolved_at = retention_terminal_at
        )
      )
    )
  );
create index if not exists content_reports_privacy_retention_candidate_idx
  on public.content_reports(retention_terminal_at, id)
  where status in ('actioned', 'dismissed')
    and retention_terminal_at is not null;

-- Raw response-loss receipts contain the same optional contact/detail as the
-- report. At terminal+3y they become a minimal random submission UUID plus a
-- random-salt bcrypt verifier over a canonical SHA-256 digest. The adaptive
-- verifier resists offline recovery of low-entropy contact fields, still
-- rejects cross-payload UUID reuse, and makes an exact retry return the safe
-- already-removed result.
alter table public.content_report_submission_receipts
  add column if not exists payload_verifier text,
  add column if not exists retained_at timestamptz,
  alter column target_id drop not null,
  alter column reason drop not null,
  drop constraint if exists
    content_report_submission_receipts_outcome_shape,
  add constraint content_report_submission_receipts_payload_verifier_check
    check (
      payload_verifier is null
      or payload_verifier
           ~ '^\$2[aby]\$10\$[./A-Za-z0-9]{53}$'
    ),
  add constraint content_report_submission_receipts_outcome_shape check (
    (
      retained_at is null
      and target_id is not null
      and reason is not null
      and (
        (
          outcome = 'inserted'
          and report_id is not null
        )
        or (
          outcome = 'already_removed'
          and report_id is null
          and was_first is false
        )
      )
    )
    or (
      retained_at is not null
      and payload_verifier is not null
      and target_id is null
      and reason is null
      and detail is null
      and reporter_contact is null
      and outcome = 'already_removed'
      and report_id is null
      and was_first is false
    )
  );
create index if not exists
  content_report_receipts_privacy_retention_candidate_idx
  on public.content_report_submission_receipts(created_at, submission_id)
  where outcome = 'already_removed' and retained_at is null;

create table public.content_report_retention_failures (
  subject_type text not null check (subject_type in ('report', 'receipt')),
  subject_id uuid not null,
  attempt_count integer not null default 1
    check (attempt_count between 1 and 1000000),
  last_sqlstate text not null
    check (last_sqlstate ~ '^[0-9A-Z]{5}$'),
  last_failed_at timestamptz not null,
  retry_after timestamptz not null,
  primary key (subject_type, subject_id),
  constraint content_report_retention_failure_time_check
    check (retry_after >= last_failed_at)
);

comment on table public.content_report_retention_failures is
  '3년 신고 원문 파기 실패 큐. 오류 본문·신고 원문 없이 subject kind/UUID와 SQLSTATE만 재시도 동안 보관한다.';

alter table public.content_report_retention_failures
  enable row level security;
revoke all on table public.content_report_retention_failures
  from public, anon, authenticated, service_role;
grant select on table public.content_report_retention_failures
  to service_role;

create table public.privacy_retention_failures (
  order_uuid uuid primary key,
  attempt_count integer not null default 1
    check (attempt_count between 1 and 1000000),
  last_sqlstate text not null
    check (last_sqlstate ~ '^[0-9A-Z]{5}$'),
  last_failed_at timestamptz not null,
  retry_after timestamptz not null,
  constraint privacy_retention_failure_time_check
    check (retry_after >= last_failed_at)
);

comment on table public.privacy_retention_failures is
  '5년 결제 상세 파기 실패 큐. 오류 본문·사용자정보 없이 내부 order UUID와 SQLSTATE만 재시도 동안 보관한다.';

alter table public.privacy_retention_failures enable row level security;
revoke all on table public.privacy_retention_failures
  from public, anon, authenticated, service_role;
grant select on table public.privacy_retention_failures to service_role;

create table public.privacy_retention_health (
  singleton boolean primary key default true check (singleton),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error_code text,
  run_count bigint not null default 0 check (run_count >= 0),
  failure_count bigint not null default 0 check (failure_count >= 0),
  last_processed integer not null default 0 check (last_processed >= 0),
  updated_at timestamptz not null default pg_catalog.now()
);

insert into public.privacy_retention_health(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.privacy_retention_health enable row level security;
revoke all on table public.privacy_retention_health
  from public, anon, authenticated, service_role;
grant select on table public.privacy_retention_health to service_role;

-- Candidate discovery is day-leading and deterministic. The partial index
-- excludes the one state that must never be compacted automatically.
create index if not exists orders_privacy_retention_candidate_idx
  on public.orders (updated_at, order_uuid)
  where status in ('paid', 'canceled', 'failed');
create index if not exists privacy_retention_failures_retry_idx
  on public.privacy_retention_failures (retry_after, order_uuid);
create index if not exists content_report_retention_failures_retry_idx
  on public.content_report_retention_failures (
    retry_after, subject_type, subject_id
  );

-- Transaction-local capability used only by the SECURITY DEFINER retention
-- worker. Data API roles still have no DELETE privilege on any detail table,
-- and no public function can set this capability.
create or replace function public.bp_privacy_retention_delete_authorized()
returns boolean
language sql
stable
set search_path = ''
as $$
  select pg_catalog.current_setting(
           'boss_paegi.privacy_retention_delete',
           true
         ) = '008904:v1';
$$;
revoke all on function public.bp_privacy_retention_delete_authorized()
  from public, anon, authenticated, service_role;

create or replace function public.bp_privacy_retention_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.bp_privacy_retention_delete_authorized() then
    return old;
  end if;
  if tg_argv[0] = 'append_only' then
    raise exception '%_append_only_violation', tg_table_name
      using errcode = 'P0001';
  end if;
  raise exception '%', tg_argv[0] using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_privacy_retention_delete_guard()
  from public, anon, authenticated, service_role;

create or replace function public.bp_content_report_payload_digest(
  p_target_id uuid,
  p_reason text,
  p_detail text,
  p_reporter_contact text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'targetId', p_target_id,
          'reason', p_reason,
          'detail', nullif(pg_catalog.btrim(p_detail), ''),
          'reporterContact',
            nullif(pg_catalog.btrim(p_reporter_contact), '')
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;
revoke all on function public.bp_content_report_payload_digest(
  uuid, text, text, text
) from public, anon, authenticated, service_role;

-- The terminal anchor can be set exactly once. Pending/open reports cannot
-- carry a terminal clock, terminal states cannot be reopened or relabelled,
-- and an already-known clock cannot be rewritten to accelerate expiry.
create or replace function public.bp_content_report_terminal_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if public.bp_privacy_retention_delete_authorized() then
      return old;
    end if;
    raise exception 'content_reports_delete_forbidden'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      if new.resolved_at is not null
         or new.retention_terminal_at is not null then
        raise exception 'pending_report_terminal_clock_forbidden'
          using errcode = 'P0001';
      end if;
    else
      if new.resolved_at is null then
        raise exception 'terminal_report_clock_required'
          using errcode = 'P0001';
      end if;
      new.retention_terminal_at := new.resolved_at;
    end if;
    return new;
  end if;

  if old.retention_terminal_at is not null then
    if new.status is distinct from old.status
       or new.resolved_at is distinct from old.resolved_at
       or new.retention_terminal_at is distinct from
            old.retention_terminal_at then
      raise exception 'report_terminal_clock_immutable'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if old.status = 'pending' then
    if new.status = 'pending' then
      if new.resolved_at is not null
         or new.retention_terminal_at is not null then
        raise exception 'pending_report_terminal_clock_forbidden'
          using errcode = 'P0001';
      end if;
      return new;
    end if;
    if new.status not in ('actioned', 'dismissed')
       or new.resolved_at is null then
      raise exception 'terminal_report_clock_required'
        using errcode = 'P0001';
    end if;
    new.retention_terminal_at := new.resolved_at;
    return new;
  end if;

  -- A legacy terminal row with no recorded clock may be repaired once, but it
  -- cannot change terminal classification or install a mismatched anchor.
  if new.status is distinct from old.status
     or old.resolved_at is not null
     or new.resolved_at is null
     or (
       new.retention_terminal_at is not null
       and new.retention_terminal_at is distinct from new.resolved_at
     ) then
    raise exception 'report_terminal_clock_immutable'
      using errcode = 'P0001';
  end if;
  new.retention_terminal_at := new.resolved_at;
  return new;
end;
$$;
revoke all on function public.bp_content_report_terminal_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_content_reports_terminal_guard
  on public.content_reports;
create trigger trg_content_reports_terminal_guard
  before insert or update or delete
  on public.content_reports
  for each row execute function public.bp_content_report_terminal_guard();

create or replace function public.bp_content_report_receipt_retention_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.bp_privacy_retention_delete_authorized() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'content_report_receipt_immutable'
    using errcode = 'P0001';
end;
$$;
revoke all on function
  public.bp_content_report_receipt_retention_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_content_report_receipt_retention_guard
  on public.content_report_submission_receipts;
create trigger trg_content_report_receipt_retention_guard
  before update or delete on public.content_report_submission_receipts
  for each row execute function
    public.bp_content_report_receipt_retention_guard();

-- A retention DELETE is bookkeeping only. It must not advance a live doll's
-- moderation CAS token and invalidate an unrelated operator action (ABA).
create or replace function public.bp_touch_report_doll_moderation_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_doll_id uuid;
begin
  if tg_op = 'DELETE'
     and public.bp_privacy_retention_delete_authorized() then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and old.target_type is not distinct from new.target_type
     and old.target_id is not distinct from new.target_id
     and old.status is not distinct from new.status then
    return new;
  end if;
  for v_doll_id in
    select distinct q.doll_id
      from (
        select case
          when tg_op in ('UPDATE', 'DELETE')
           and old.target_type = 'doll'
          then old.target_id
          else null
        end as doll_id
        union all
        select case
          when tg_op in ('UPDATE', 'INSERT')
           and new.target_type = 'doll'
          then new.target_id
          else null
        end
      ) q
     where q.doll_id is not null
     order by q.doll_id
  loop
    update public.dolls
       set moderation_version = moderation_version + 1
     where id = v_doll_id;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.bp_touch_report_doll_moderation_version()
  from public, anon, authenticated, service_role;

-- Preserve every pre-existing non-retention mutation rule. Only DELETE gets a
-- narrowly-scoped capability path.
create or replace function public.bp_forbid_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.bp_privacy_retention_delete_authorized() then
    return old;
  end if;
  raise exception '%_delete_forbidden', tg_table_name using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_forbid_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_refund_attempts_lifecycle
  on public.order_refund_attempts;
create trigger trg_refund_attempts_lifecycle
  before insert on public.order_refund_attempts
  for each row execute function public.refund_attempts_lifecycle();

create or replace function public.bp_refund_attempts_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
begin
  if public.bp_privacy_retention_delete_authorized() then
    return old;
  end if;
  select r.state
    into v_state
    from public.refund_requests r
   where r.id = old.request_id;
  if v_state is not null and v_state <> 'building' then
    raise exception 'refund_attempts_delete_only_building'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke all on function public.bp_refund_attempts_delete_guard()
  from public, anon, authenticated, service_role;
create trigger trg_refund_attempts_delete_guard
  before delete on public.order_refund_attempts
  for each row execute function public.bp_refund_attempts_delete_guard();

drop trigger if exists trg_crb_freeze
  on public.cancellation_resolution_batches;
create trigger trg_crb_freeze
  before update on public.cancellation_resolution_batches
  for each row execute function public.crb_guard();
create trigger trg_crb_retention_delete
  before delete on public.cancellation_resolution_batches
  for each row
  execute function public.bp_privacy_retention_delete_guard('crb_immutable');

drop trigger if exists trg_legacy_evidence_freeze
  on public.legacy_refund_backfill_evidence;
create trigger trg_legacy_evidence_freeze
  before update on public.legacy_refund_backfill_evidence
  for each row execute function public.legacy_evidence_freeze();
create trigger trg_legacy_evidence_retention_delete
  before delete on public.legacy_refund_backfill_evidence
  for each row
  execute function public.bp_privacy_retention_delete_guard(
    'legacy_evidence_immutable'
  );

drop trigger if exists trg_credit_ledger_freeze on public.credit_ledger;
create trigger trg_credit_ledger_freeze
  before update on public.credit_ledger
  for each row execute function public.ledger_append_only_guard();
create trigger trg_credit_ledger_retention_delete
  before delete on public.credit_ledger
  for each row
  execute function public.bp_privacy_retention_delete_guard('append_only');

drop trigger if exists trg_admin_ledger_freeze
  on public.admin_actions_ledger;
create trigger trg_admin_ledger_freeze
  before update on public.admin_actions_ledger
  for each row execute function public.ledger_append_only_guard();
create trigger trg_admin_ledger_retention_delete
  before delete on public.admin_actions_ledger
  for each row
  execute function public.bp_privacy_retention_delete_guard('append_only');

-- NULL means eligible. Every non-NULL code is an operator-visible reason why
-- the detailed record must remain. The function is private so callers cannot
-- use it as a payment-state oracle through PostgREST.
create or replace function public.bp_payment_retention_blocker(
  p_order_uuid uuid,
  p_as_of timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.orders;
  v_cutoff timestamptz := p_as_of - interval '5 years';
begin
  select *
    into o
    from public.orders
   where order_uuid = p_order_uuid;
  if not found then
    return 'order_missing';
  end if;
  if o.status not in ('paid', 'canceled', 'failed') then
    return 'order_nonterminal';
  end if;
  if o.updated_at >= v_cutoff
     or o.created_at >= v_cutoff
     or coalesce(o.paid_at, '-infinity'::timestamptz) >= v_cutoff
     or coalesce(o.canceled_at, '-infinity'::timestamptz) >= v_cutoff
  then
    return 'retention_window_open';
  end if;
  if o.refund_state in ('in_progress', 'pg_done') then
    return 'legacy_refund_open';
  end if;
  if o.cancel_intent_created_at is not null
     and o.status <> 'canceled'
  then
    return 'cancel_intent_open';
  end if;

  if exists (
    select 1
      from public.refund_requests r
     where (
           r.scope_order_uuid = p_order_uuid
           or exists (
             select 1
               from public.order_refund_attempts a
              where a.request_id = r.id
                and a.order_uuid = p_order_uuid
           )
         )
       and (
         r.state in ('building', 'prepared', 'processing', 'blocked')
         or r.updated_at >= v_cutoff
       )
  ) then
    return 'refund_request_open_or_recent';
  end if;
  if exists (
    select 1
      from public.order_refund_attempts a
     where a.order_uuid = p_order_uuid
       and (
         a.state not in ('committed', 'released')
         or a.updated_at >= v_cutoff
       )
  ) then
    return 'refund_attempt_open_or_recent';
  end if;
  if exists (
    select 1
      from public.payment_cancellation_events e
     where e.order_uuid = p_order_uuid
       and (
         e.resolution_state = 'unmatched'
         or e.updated_at >= v_cutoff
       )
  ) then
    return 'cancellation_open_or_recent';
  end if;
  if exists (
    select 1
      from public.reconciliation_issues i
     where i.order_uuid = p_order_uuid
       and (i.state = 'open' or i.updated_at >= v_cutoff)
  ) then
    return 'reconciliation_open_or_recent';
  end if;
  if exists (
    select 1
      from public.credit_refund_shortfalls s
     where s.order_uuid = p_order_uuid
       and (s.state = 'open' or s.updated_at >= v_cutoff)
  ) then
    return 'shortfall_open_or_recent';
  end if;
  if exists (
    select 1
      from public.credit_lots l
     where l.order_uuid = p_order_uuid
       and (
         l.expired_at is null
         or l.refund_reserved <> 0
         or l.updated_at >= v_cutoff
       )
  ) then
    return 'credit_lot_live_or_recent';
  end if;
  if exists (
    select 1
      from public.ai_generations g
      join public.credit_lots l on l.id = g.credit_lot_id
     where l.order_uuid = p_order_uuid
       and g.status in ('queued', 'done')
  ) then
    return 'generation_nonterminal';
  end if;
  if exists (
    select 1
      from public.cancellation_resolution_batches b
     where b.order_uuid = p_order_uuid
       and b.created_at >= v_cutoff
  ) or exists (
    select 1
      from public.legacy_refund_backfill_evidence e
     where e.order_uuid = p_order_uuid
       and greatest(e.applied_at, e.created_at) >= v_cutoff
  ) or exists (
    select 1
      from public.credit_ledger l
     where l.ref_order_uuid = p_order_uuid
       and l.created_at >= v_cutoff
  ) or exists (
    select 1
      from public.admin_actions_ledger l
     where l.order_uuid = p_order_uuid
       and l.created_at >= v_cutoff
  ) then
    return 'financial_evidence_recent';
  end if;

  return null;
end;
$$;
revoke all on function public.bp_payment_retention_blocker(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- Preserve the quota-hardened 008900 implementations behind tombstone-aware
-- wrappers. The old bodies remain the authority for all non-retained rows.
do $wrap_report_replay$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_reserve_report_write_attempt_pre008904(uuid,uuid,text,text,text,text)'
     ) is null then
    alter function public.reserve_report_write_attempt(
      uuid, uuid, text, text, text, text
    ) rename to bp_reserve_report_write_attempt_pre008904;
  end if;
  if pg_catalog.to_regprocedure(
       'public.bp_submit_content_report_core_pre008904(uuid,uuid,text,text,uuid,text,boolean)'
     ) is null then
    alter function public.bp_submit_content_report_core(
      uuid, uuid, text, text, uuid, text, boolean
    ) rename to bp_submit_content_report_core_pre008904;
  end if;
end;
$wrap_report_replay$;

revoke all on function
  public.bp_reserve_report_write_attempt_pre008904(
    uuid, uuid, text, text, text, text
  ) from public, anon, authenticated, service_role;
revoke all on function
  public.bp_submit_content_report_core_pre008904(
    uuid, uuid, text, text, uuid, text, boolean
  ) from public, anon, authenticated, service_role;

create or replace function public.reserve_report_write_attempt(
  p_submission_id uuid,
  p_target_id uuid,
  p_reason text,
  p_detail text,
  p_reporter_contact text,
  p_network_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_operation_key text;
  v_receipt public.content_report_submission_receipts%rowtype;
  v_payload_digest text;
begin
  if p_submission_id is null then
    return public.bp_reserve_report_write_attempt_pre008904(
      p_submission_id,
      p_target_id,
      p_reason,
      p_detail,
      p_reporter_contact,
      p_network_actor_key
    );
  end if;
  v_operation_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'report-attempt:' || p_submission_id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_payload_digest := public.bp_content_report_payload_digest(
    p_target_id, p_reason, p_detail, p_reporter_contact
  );

  -- Same global order as 008900: operation attempt -> submission receipt.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-write-attempt:' || v_operation_key,
      0::bigint
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:submission:' || p_submission_id::text,
      0::bigint
    )
  );
  select *
    into v_receipt
    from public.content_report_submission_receipts r
   where r.submission_id = p_submission_id
     and r.retained_at is not null;
  if found then
    if v_receipt.payload_verifier is null
       or extensions.crypt(
            v_payload_digest,
            v_receipt.payload_verifier
          ) is distinct from v_receipt.payload_verifier then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', 'submission_conflict'
      );
    end if;
    update public.public_write_attempts a
       set state = 'succeeded',
           error_code = null,
           updated_at = pg_catalog.clock_timestamp()
     where a.endpoint = 'report'
       and a.operation_key = v_operation_key;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'replay',
      'result', pg_catalog.jsonb_build_object(
        'ok', true,
        'inserted', false,
        'already_removed', true,
        'was_first', false,
        'report_id', null,
        'duplicate', true
      )
    );
  end if;
  return public.bp_reserve_report_write_attempt_pre008904(
    p_submission_id,
    p_target_id,
    p_reason,
    p_detail,
    p_reporter_contact,
    p_network_actor_key
  );
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'busy',
      'error_code', 'report_write_quota_busy'
    );
end;
$$;
revoke all on function public.reserve_report_write_attempt(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.reserve_report_write_attempt(
  uuid, uuid, text, text, text, text
) to service_role;

create or replace function public.bp_submit_content_report_core(
  p_submission_id uuid,
  p_target_id uuid,
  p_reason text,
  p_detail text,
  p_reporter_user_id uuid,
  p_reporter_contact text,
  p_rate_allowed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.content_report_submission_receipts%rowtype;
begin
  if p_submission_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'content-report:submission:' || p_submission_id::text,
        0::bigint
      )
    );
    select *
      into v_receipt
      from public.content_report_submission_receipts r
     where r.submission_id = p_submission_id
       and r.retained_at is not null;
    if found then
      if v_receipt.payload_verifier is null
         or extensions.crypt(
              public.bp_content_report_payload_digest(
                p_target_id, p_reason, p_detail, p_reporter_contact
              ),
              v_receipt.payload_verifier
            ) is distinct from v_receipt.payload_verifier then
        raise exception 'submission_conflict' using errcode = 'P0001';
      end if;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'inserted', false,
        'already_removed', true,
        'was_first', false,
        'report_id', null,
        'duplicate', true
      );
    end if;
  end if;
  -- The non-retained implementation below still takes the doll lifecycle row
  -- FOR KEY SHARE before target-state inspection and report insertion.
  return public.bp_submit_content_report_core_pre008904(
    p_submission_id,
    p_target_id,
    p_reason,
    p_detail,
    p_reporter_user_id,
    p_reporter_contact,
    p_rate_allowed
  );
end;
$$;
revoke all on function public.bp_submit_content_report_core(
  uuid, uuid, text, text, uuid, text, boolean
) from public, anon, authenticated, service_role;

-- NULL means eligible. Pending rows, missing legacy clocks, exact-boundary
-- rows, and reports whose doll purge is still running are fail-closed.
create or replace function public.bp_content_report_retention_blocker(
  p_report_id uuid,
  p_as_of timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.content_reports;
begin
  select *
    into r
    from public.content_reports
   where id = p_report_id;
  if not found then
    return 'report_missing';
  end if;
  if r.status = 'pending' then
    return 'report_open';
  end if;
  if r.status not in ('actioned', 'dismissed') then
    return 'report_nonterminal';
  end if;
  if r.retention_terminal_at is null
     or r.resolved_at is distinct from r.retention_terminal_at then
    return 'terminal_anchor_missing';
  end if;
  -- Strict inequality: exactly terminal+3y remains retained.
  if r.retention_terminal_at >= p_as_of - interval '3 years' then
    return 'retention_window_open';
  end if;
  if exists (
    select 1
      from public.moderation_purge_jobs j
     where j.doll_id = r.target_id
       and j.status in ('pending', 'leased')
  ) then
    return 'moderation_purge_open';
  end if;
  return null;
end;
$$;
revoke all on function
  public.bp_content_report_retention_blocker(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.bp_privacy_retention_status_at(
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payment_cutoff timestamptz := p_as_of - interval '5 years';
  v_report_cutoff timestamptz := p_as_of - interval '3 years';
  v_ready integer;
  v_blocked integer;
  v_failures integer;
  v_report_ready integer;
  v_report_blocked integer;
  v_report_failures integer;
  v_report_open integer;
  h public.privacy_retention_health;
begin
  select count(*)::integer
    into v_ready
    from (
      select 1
        from public.orders o
       where o.updated_at < v_payment_cutoff
         and o.status in ('paid', 'canceled', 'failed')
         and public.bp_payment_retention_blocker(o.order_uuid, p_as_of)
               is null
       order by o.updated_at, o.order_uuid
       limit 1001
    ) q;

  select count(*)::integer
    into v_blocked
    from (
      select 1
        from public.orders o
       where o.updated_at < v_payment_cutoff
         and public.bp_payment_retention_blocker(o.order_uuid, p_as_of)
               is not null
       order by o.updated_at, o.order_uuid
       limit 1001
    ) q;

  select count(*)::integer
    into v_report_ready
    from (
      select r.id
        from public.content_reports r
       where r.retention_terminal_at < v_report_cutoff
         and public.bp_content_report_retention_blocker(r.id, p_as_of)
               is null
      union all
      select receipt.submission_id
        from public.content_report_submission_receipts receipt
       where receipt.outcome = 'already_removed'
         and receipt.retained_at is null
         and receipt.created_at < v_report_cutoff
      limit 1001
    ) q;

  select count(*)::integer
    into v_report_blocked
    from (
      select 1
        from public.content_reports r
       where r.status in ('actioned', 'dismissed')
         and (
           r.retention_terminal_at is null
           or (
             r.retention_terminal_at < v_report_cutoff
             and public.bp_content_report_retention_blocker(
                   r.id,
                   p_as_of
                 ) is not null
           )
         )
       order by r.created_at, r.id
       limit 1001
    ) q;

  select count(*)::integer
    into v_report_failures
    from (
      select 1
        from public.content_report_retention_failures
       order by retry_after, subject_type, subject_id
       limit 1001
    ) q;

  select count(*)::integer
    into v_report_open
    from (
      select 1
        from public.content_reports r
       where r.status = 'pending'
       order by r.created_at, r.id
       limit 1001
    ) q;

  select count(*)::integer
    into v_failures
    from (
      select 1
        from public.privacy_retention_failures
       order by retry_after, order_uuid
       limit 1001
    ) q;

  select *
    into h
    from public.privacy_retention_health
   where singleton;

  return pg_catalog.jsonb_build_object(
    'payment_ready', least(v_ready, 1000),
    'payment_ready_capped', v_ready > 1000,
    'payment_blocked', least(v_blocked, 1000),
    'payment_blocked_capped', v_blocked > 1000,
    'payment_failures', least(v_failures, 1000),
    'payment_failures_capped', v_failures > 1000,
    'content_report_ready', least(v_report_ready, 1000),
    'content_report_ready_capped', v_report_ready > 1000,
    'content_report_blocked', least(v_report_blocked, 1000),
    'content_report_blocked_capped', v_report_blocked > 1000,
    'content_report_failures', least(v_report_failures, 1000),
    'content_report_failures_capped', v_report_failures > 1000,
    'content_report_open', least(v_report_open, 1000),
    'content_report_open_capped', v_report_open > 1000,
    'consumer_dispute_source_mapped', true,
    'consumer_dispute_backlog',
      least(v_report_ready + v_report_blocked, 1000),
    'consumer_dispute_backlog_capped',
      v_report_ready + v_report_blocked > 1000,
    'legal_blockers', '[]'::jsonb,
    'external_boundaries', pg_catalog.jsonb_build_array(
      'external_consumer_complaint_manual_retention_runbook'
    ),
    'last_started_at', h.last_started_at,
    'last_completed_at', h.last_completed_at,
    'last_succeeded_at', h.last_succeeded_at,
    'last_failed_at', h.last_failed_at,
    'last_error_code', h.last_error_code,
    'run_count', h.run_count,
    'failure_count', h.failure_count,
    'last_processed', h.last_processed
  );
end;
$$;
revoke all on function public.bp_privacy_retention_status_at(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.privacy_retention_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.bp_privacy_retention_status_at(pg_catalog.clock_timestamp());
$$;
revoke all on function public.privacy_retention_status()
  from public, anon, authenticated;
grant execute on function public.privacy_retention_status()
  to service_role;

create or replace function public.bp_maintain_privacy_retention(
  p_limit integer,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed integer := 0;
  v_payment_processed integer := 0;
  v_content_report_processed integer := 0;
  v_content_report_attempted integer := 0;
  v_errors integer := 0;
  v_payment_errors integer := 0;
  v_content_report_errors integer := 0;
  v_last_error text;
  v_status jsonb;
  v_attempts integer;
  v_request_ids uuid[];
  v_submission_id uuid;
  v_target_id uuid;
  v_operation_key text;
  c record;
  r public.content_reports;
  v_receipt public.content_report_submission_receipts%rowtype;
  o public.orders;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'privacy_retention_limit_invalid'
      using errcode = '22023';
  end if;
  if p_as_of is null
     or p_as_of > pg_catalog.clock_timestamp() + interval '5 minutes'
  then
    raise exception 'privacy_retention_clock_invalid'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('boss-paegi:privacy-retention:v1', 0)
  );
  perform pg_catalog.set_config(
    'boss_paegi.privacy_retention_delete',
    '008904:v1',
    true
  );

  update public.privacy_retention_health
     set last_started_at = p_as_of,
         run_count = run_count + 1,
         last_processed = 0,
         updated_at = p_as_of
   where singleton;

  -- One shared budget covers both legal classes. Report candidates run first
  -- because their window is shorter; every success or failure consumes one of
  -- the at-most-100 attempts, so high-cardinality data stays bounded.
  for c in
    select candidate.subject_type, candidate.subject_id, candidate.sort_at
      from (
        select
          'report'::text as subject_type,
          report.id as subject_id,
          report.retention_terminal_at as sort_at
        from public.content_reports report
        left join public.content_report_retention_failures failure
          on failure.subject_type = 'report'
         and failure.subject_id = report.id
       where report.retention_terminal_at
               < p_as_of - interval '3 years'
         and (
           failure.subject_id is null
           or failure.retry_after <= p_as_of
         )
         and public.bp_content_report_retention_blocker(
               report.id,
               p_as_of
             ) is null
        union all
        select
          'receipt'::text,
          receipt.submission_id,
          receipt.created_at
        from public.content_report_submission_receipts receipt
        left join public.content_report_retention_failures failure
          on failure.subject_type = 'receipt'
         and failure.subject_id = receipt.submission_id
       where receipt.outcome = 'already_removed'
         and receipt.retained_at is null
         and receipt.created_at < p_as_of - interval '3 years'
         and (
           failure.subject_id is null
           or failure.retry_after <= p_as_of
         )
      ) candidate
     order by candidate.sort_at, candidate.subject_type, candidate.subject_id
     limit p_limit
  loop
    v_content_report_attempted := v_content_report_attempted + 1;
    begin
      if c.subject_type = 'report' then
        -- Read the immutable receipt link only to establish the canonical
        -- attempt -> submission -> doll -> report lock order.
        select receipt.submission_id
          into v_submission_id
          from public.content_report_submission_receipts receipt
         where receipt.report_id = c.subject_id;
        if found then
          v_operation_key := pg_catalog.encode(
            extensions.digest(
              pg_catalog.convert_to(
                'report-attempt:' || v_submission_id::text,
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          );
          perform pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
              'report-write-attempt:' || v_operation_key,
              0::bigint
            )
          );
          perform pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
              'content-report:submission:' || v_submission_id::text,
              0::bigint
            )
          );
        else
          v_submission_id := null;
        end if;

        select report.target_id
          into v_target_id
          from public.content_reports report
         where report.id = c.subject_id;
        if not found then
          raise exception 'content_report_retention_fence_lost'
            using errcode = '40001';
        end if;

        -- Existing moderation mutations lock the doll first. Missing dolls are
        -- old account-deletion orphans and have no live lifecycle to race.
        perform 1
          from public.dolls d
         where d.id = v_target_id
         for update;
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'content-report:doll:' || v_target_id::text,
            0::bigint
          )
        );
        select *
          into r
          from public.content_reports report
         where report.id = c.subject_id
         for update;
        if not found
           or public.bp_content_report_retention_blocker(
                c.subject_id,
                p_as_of
              ) is not null then
          raise exception 'content_report_retention_fence_lost'
            using errcode = '40001';
        end if;

        insert into public.content_report_retention_monthly_aggregates (
          month_utc,
          terminal_status,
          reason_code,
          record_count,
          first_compacted_at,
          last_compacted_at
        )
        values (
          (
            pg_catalog.date_trunc(
              'month',
              r.retention_terminal_at at time zone 'UTC'
            )
          )::date,
          r.status,
          case
            when r.reason in (
              'portrait', 'defamation', 'obscene', 'hate', 'other'
            ) then r.reason
            else 'other'
          end,
          1,
          p_as_of,
          p_as_of
        )
        on conflict (month_utc, terminal_status, reason_code)
        do update
          set record_count =
                public.content_report_retention_monthly_aggregates
                  .record_count + 1,
              last_compacted_at = excluded.last_compacted_at;

        if v_submission_id is not null then
          update public.content_report_submission_receipts receipt
             set payload_verifier =
                   extensions.crypt(
                     public.bp_content_report_payload_digest(
                       receipt.target_id,
                       receipt.reason,
                       receipt.detail,
                       receipt.reporter_contact
                     ),
                     extensions.gen_salt('bf', 10)
                   ),
                 target_id = null,
                 reason = null,
                 detail = null,
                 reporter_contact = null,
                 outcome = 'already_removed',
                 report_id = null,
                 was_first = false,
                 retained_at = p_as_of
           where receipt.submission_id = v_submission_id
             and receipt.report_id = c.subject_id
             and receipt.retained_at is null;
          if not found then
            raise exception 'content_report_receipt_fence_lost'
              using errcode = '40001';
          end if;
        end if;

        delete from public.moderation_actions_ledger ledger
         where ledger.report_id = c.subject_id;
        delete from public.content_reports report
         where report.id = c.subject_id
           and report.retention_terminal_at = r.retention_terminal_at
           and report.status = r.status;
        if not found then
          raise exception 'content_report_retention_fence_lost'
            using errcode = '40001';
        end if;
      else
        v_submission_id := c.subject_id;
        v_operation_key := pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              'report-attempt:' || v_submission_id::text,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        );
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'report-write-attempt:' || v_operation_key,
            0::bigint
          )
        );
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'content-report:submission:' || v_submission_id::text,
            0::bigint
          )
        );

        select *
          into v_receipt
          from public.content_report_submission_receipts receipt
         where receipt.submission_id = v_submission_id
           and receipt.outcome = 'already_removed'
           and receipt.retained_at is null
           and receipt.created_at < p_as_of - interval '3 years'
         for update;
        if not found then
          raise exception 'content_report_receipt_fence_lost'
            using errcode = '40001';
        end if;

        insert into public.content_report_retention_monthly_aggregates (
          month_utc,
          terminal_status,
          reason_code,
          record_count,
          first_compacted_at,
          last_compacted_at
        )
        values (
          (
            pg_catalog.date_trunc(
              'month',
              v_receipt.created_at at time zone 'UTC'
            )
          )::date,
          'already_removed',
          v_receipt.reason,
          1,
          p_as_of,
          p_as_of
        )
        on conflict (month_utc, terminal_status, reason_code)
        do update
          set record_count =
                public.content_report_retention_monthly_aggregates
                  .record_count + 1,
              last_compacted_at = excluded.last_compacted_at;

        update public.content_report_submission_receipts receipt
           set payload_verifier =
                 extensions.crypt(
                   public.bp_content_report_payload_digest(
                     receipt.target_id,
                     receipt.reason,
                     receipt.detail,
                     receipt.reporter_contact
                   ),
                   extensions.gen_salt('bf', 10)
                 ),
               target_id = null,
               reason = null,
               detail = null,
               reporter_contact = null,
               report_id = null,
               was_first = false,
               retained_at = p_as_of
         where receipt.submission_id = v_submission_id
           and receipt.outcome = 'already_removed'
           and receipt.retained_at is null
           and receipt.created_at < p_as_of - interval '3 years';
        if not found then
          raise exception 'content_report_receipt_fence_lost'
            using errcode = '40001';
        end if;
      end if;

      delete from public.content_report_retention_failures failure
       where failure.subject_type = c.subject_type
         and failure.subject_id = c.subject_id;
      v_content_report_processed := v_content_report_processed + 1;
      v_processed := v_processed + 1;
    exception
      when others then
        v_errors := v_errors + 1;
        v_content_report_errors := v_content_report_errors + 1;
        v_last_error := sqlstate;
        select coalesce(failure.attempt_count, 0) + 1
          into v_attempts
          from public.content_report_retention_failures failure
         where failure.subject_type = c.subject_type
           and failure.subject_id = c.subject_id;
        v_attempts := coalesce(v_attempts, 1);
        insert into public.content_report_retention_failures (
          subject_type,
          subject_id,
          attempt_count,
          last_sqlstate,
          last_failed_at,
          retry_after
        )
        values (
          c.subject_type,
          c.subject_id,
          v_attempts,
          v_last_error,
          p_as_of,
          p_as_of
            + pg_catalog.make_interval(
                secs => least(
                  86400,
                  300 * (1 << least(v_attempts - 1, 8))
                )
              )
        )
        on conflict (subject_type, subject_id) do update
          set attempt_count = excluded.attempt_count,
              last_sqlstate = excluded.last_sqlstate,
              last_failed_at = excluded.last_failed_at,
              retry_after = excluded.retry_after;
    end;
  end loop;

  for o in
    select candidate.*
      from public.orders candidate
      left join public.privacy_retention_failures f
        on f.order_uuid = candidate.order_uuid
     where candidate.updated_at < p_as_of - interval '5 years'
       and candidate.status in ('paid', 'canceled', 'failed')
       and (f.order_uuid is null or f.retry_after <= p_as_of)
       and public.bp_payment_retention_blocker(
             candidate.order_uuid,
             p_as_of
           ) is null
     order by candidate.updated_at, candidate.order_uuid
     limit greatest(p_limit - v_content_report_attempted, 0)
     for update of candidate skip locked
  loop
    begin
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'boss-paegi:privacy-retention:order:' || o.order_uuid::text,
          0
        )
      );
      if public.bp_payment_retention_blocker(o.order_uuid, p_as_of)
           is not null
      then
        raise exception 'privacy_retention_fence_lost'
          using errcode = '40001';
      end if;

      set constraints
        public.refund_attempts_pg_cancel_fkey,
        public.cancellation_events_matched_order_fkey
        deferred;

      insert into public.payment_retention_monthly_aggregates (
        month_utc,
        provider,
        terminal_status,
        is_test,
        order_count,
        gross_amount,
        granted_credits,
        refunded_amount,
        refunded_credits,
        first_compacted_at,
        last_compacted_at
      )
      values (
        (
          pg_catalog.date_trunc(
            'month',
            coalesce(o.paid_at, o.created_at) at time zone 'UTC'
          )
        )::date,
        o.provider,
        o.status,
        o.is_test,
        1,
        o.amount,
        o.credits,
        o.refunded_amount,
        o.refunded_credits,
        p_as_of,
        p_as_of
      )
      on conflict (month_utc, provider, terminal_status, is_test)
      do update
        set order_count =
              public.payment_retention_monthly_aggregates.order_count + 1,
            gross_amount =
              public.payment_retention_monthly_aggregates.gross_amount
                + excluded.gross_amount,
            granted_credits =
              public.payment_retention_monthly_aggregates.granted_credits
                + excluded.granted_credits,
            refunded_amount =
              public.payment_retention_monthly_aggregates.refunded_amount
                + excluded.refunded_amount,
            refunded_credits =
              public.payment_retention_monthly_aggregates.refunded_credits
                + excluded.refunded_credits,
            last_compacted_at = excluded.last_compacted_at;

      -- A generated character may outlive the legally retained payment
      -- evidence. Remove only its financial provenance; ownership/content
      -- lifecycle remains unchanged.
      update public.ai_generations g
         set credit_lot_id = null,
             consumed_at = null,
             refunded_at = null
       where g.credit_lot_id in (
         select l.id
           from public.credit_lots l
          where l.order_uuid = o.order_uuid
       );

      delete from public.credit_ledger l
       where l.ref_order_uuid = o.order_uuid
          or l.ref_lot_id in (
            select lot.id
              from public.credit_lots lot
             where lot.order_uuid = o.order_uuid
          )
          or l.ref_attempt_id in (
            select a.id
              from public.order_refund_attempts a
             where a.order_uuid = o.order_uuid
          )
          or l.ref_cancellation_id in (
            select e.cancellation_id
              from public.payment_cancellation_events e
             where e.order_uuid = o.order_uuid
          );

      delete from public.admin_actions_ledger l
       where l.order_uuid = o.order_uuid
          or l.ref_attempt_id in (
            select a.id
              from public.order_refund_attempts a
             where a.order_uuid = o.order_uuid
          )
          or l.ref_cancellation_id in (
            select e.cancellation_id
              from public.payment_cancellation_events e
             where e.order_uuid = o.order_uuid
          );

      delete from public.credit_refund_shortfalls
       where order_uuid = o.order_uuid;
      delete from public.reconciliation_issues
       where order_uuid = o.order_uuid;
      delete from public.legacy_refund_backfill_evidence
       where order_uuid = o.order_uuid;

      select pg_catalog.array_agg(distinct request_id)
        into v_request_ids
        from public.order_refund_attempts
       where order_uuid = o.order_uuid;

      -- The two deletes below are protected by the deferred cyclic FKs.
      delete from public.payment_cancellation_events
       where order_uuid = o.order_uuid;
      delete from public.order_refund_attempts
       where order_uuid = o.order_uuid;

      delete from public.cancellation_resolution_batches
       where order_uuid = o.order_uuid;
      delete from public.refund_requests
       where (
             scope_order_uuid = o.order_uuid
             or id = any(coalesce(v_request_ids, array[]::uuid[]))
           )
         and not exists (
           select 1
             from public.order_refund_attempts remaining
            where remaining.request_id = refund_requests.id
         );
      delete from public.credit_lots
       where order_uuid = o.order_uuid;

      delete from public.orders
       where order_uuid = o.order_uuid
         and version = o.version;
      if not found then
        raise exception 'privacy_retention_fence_lost'
          using errcode = '40001';
      end if;

      delete from public.privacy_retention_failures
       where order_uuid = o.order_uuid;
      v_payment_processed := v_payment_processed + 1;
      v_processed := v_processed + 1;
    exception
      when others then
        v_errors := v_errors + 1;
        v_payment_errors := v_payment_errors + 1;
        v_last_error := sqlstate;
        select coalesce(f.attempt_count, 0) + 1
          into v_attempts
          from public.privacy_retention_failures f
         where f.order_uuid = o.order_uuid;
        v_attempts := coalesce(v_attempts, 1);

        insert into public.privacy_retention_failures (
          order_uuid,
          attempt_count,
          last_sqlstate,
          last_failed_at,
          retry_after
        )
        values (
          o.order_uuid,
          v_attempts,
          v_last_error,
          p_as_of,
          p_as_of
            + pg_catalog.make_interval(
                secs => least(
                  86400,
                  300 * (1 << least(v_attempts - 1, 8))
                )
              )
        )
        on conflict (order_uuid) do update
          set attempt_count = excluded.attempt_count,
              last_sqlstate = excluded.last_sqlstate,
              last_failed_at = excluded.last_failed_at,
              retry_after = excluded.retry_after;
    end;
  end loop;

  -- Do not leak the narrow DELETE capability to later statements when an
  -- internal caller invokes this function inside a larger transaction.
  perform pg_catalog.set_config(
    'boss_paegi.privacy_retention_delete',
    '',
    true
  );

  update public.privacy_retention_health
     set last_completed_at = p_as_of,
         last_succeeded_at =
           case when v_errors = 0 then p_as_of else last_succeeded_at end,
         last_failed_at =
           case when v_errors > 0 then p_as_of else last_failed_at end,
         last_error_code =
           case when v_errors > 0 then v_last_error else null end,
         failure_count = failure_count + v_errors,
         last_processed = v_processed,
         updated_at = p_as_of
   where singleton;

  v_status := public.bp_privacy_retention_status_at(p_as_of);
  return pg_catalog.jsonb_build_object(
    'ok', v_errors = 0,
    'processed', v_processed,
    'errors', v_errors,
    'payment_processed', v_payment_processed,
    'payment_errors', v_payment_errors,
    'content_report_processed', v_content_report_processed,
    'content_report_errors', v_content_report_errors,
    'payment_ready', v_status->'payment_ready',
    'payment_ready_capped', v_status->'payment_ready_capped',
    'payment_blocked', v_status->'payment_blocked',
    'payment_blocked_capped', v_status->'payment_blocked_capped',
    'payment_failures', v_status->'payment_failures',
    'payment_failures_capped', v_status->'payment_failures_capped',
    'content_report_ready', v_status->'content_report_ready',
    'content_report_ready_capped',
      v_status->'content_report_ready_capped',
    'content_report_blocked', v_status->'content_report_blocked',
    'content_report_blocked_capped',
      v_status->'content_report_blocked_capped',
    'content_report_failures', v_status->'content_report_failures',
    'content_report_failures_capped',
      v_status->'content_report_failures_capped',
    'content_report_open', v_status->'content_report_open',
    'content_report_open_capped',
      v_status->'content_report_open_capped',
    'consumer_dispute_source_mapped',
      v_status->'consumer_dispute_source_mapped',
    'consumer_dispute_backlog', v_status->'consumer_dispute_backlog',
    'consumer_dispute_backlog_capped',
      v_status->'consumer_dispute_backlog_capped',
    'legal_blockers', v_status->'legal_blockers',
    'external_boundaries', v_status->'external_boundaries'
  );
end;
$$;
revoke all on function
  public.bp_maintain_privacy_retention(integer, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.maintain_privacy_retention(
  p_limit integer default 100
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.bp_maintain_privacy_retention(
    p_limit,
    pg_catalog.clock_timestamp()
  );
$$;
revoke all on function public.maintain_privacy_retention(integer)
  from public, anon, authenticated;
grant execute on function public.maintain_privacy_retention(integer)
  to service_role;

-- Contract/ACL assertions fail the migration instead of leaving a partially
-- exposed retention primitive.
do $verify$
begin
  if pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_maintain_privacy_retention(integer,timestamptz)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.maintain_privacy_retention(integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.maintain_privacy_retention(integer)',
       'EXECUTE'
     )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid =
          'public.payment_retention_monthly_aggregates'::regclass
     )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid =
          'public.content_report_retention_monthly_aggregates'::regclass
     )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid =
          'public.content_report_retention_failures'::regclass
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_reserve_report_write_attempt_pre008904(uuid,uuid,text,text,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.content_report_submission_receipts',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.content_reports'::regclass
          and t.tgname = 'trg_content_reports_terminal_guard'
          and not t.tgisinternal
     )
  then
    raise exception '008904 verification: retention ACL/RLS drift';
  end if;
end;
$verify$;

insert into public.schema_migration_journal (
  version,
  migration_hash,
  manifest_hash,
  app_commit
)
values (
  '008904_privacy_retention_controls',
  null,
  null,
  null
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
