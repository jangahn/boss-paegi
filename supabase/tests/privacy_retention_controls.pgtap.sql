-- 008904: five-year payment and terminal+three-year in-service complaint
-- retention. External email complaints follow docs/privacy-retention.md.

begin;
select plan(39);

select ok(
  has_function_privilege(
    'service_role',
    'public.maintain_privacy_retention(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.privacy_retention_status()',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_maintain_privacy_retention(integer,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_reserve_report_write_attempt_pre008904(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'only bounded retention and tombstone-aware public wrappers are exposed'
);

select ok(
  (
    select pg_catalog.bool_and(c.relrowsecurity)
      from pg_catalog.pg_class c
     where c.oid in (
       'public.payment_retention_monthly_aggregates'::regclass,
       'public.content_report_retention_monthly_aggregates'::regclass,
       'public.privacy_retention_failures'::regclass,
       'public.content_report_retention_failures'::regclass
     )
  )
  and not has_table_privilege(
    'service_role',
    'public.content_report_submission_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.content_report_retention_monthly_aggregates',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'retention evidence and replay tombstones stay behind RLS/RPC'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.content_reports'::regclass
       and a.attname = 'retention_terminal_at'
       and not a.attisdropped
  )
  and exists (
    select 1
      from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.content_reports'::regclass
       and t.tgname = 'trg_content_reports_terminal_guard'
       and not t.tgisinternal
  )
  and exists (
    select 1
      from pg_catalog.pg_trigger t
     where t.tgrelid =
             'public.content_report_submission_receipts'::regclass
       and t.tgname =
             'trg_content_report_receipt_retention_guard'
       and not t.tgisinternal
  ),
  'terminal anchor and immutable receipt guards exist in the catalog'
);

select throws_ok(
  $$select public.bp_maintain_privacy_retention(101, clock_timestamp())$$,
  '22023',
  'privacy_retention_limit_invalid',
  'worker rejects an unbounded limit'
);
select throws_ok(
  $$
    select public.bp_maintain_privacy_retention(
      1,
      clock_timestamp() + interval '6 minutes'
    )
  $$,
  '22023',
  'privacy_retention_clock_invalid',
  'worker rejects a future clock outside its skew fence'
);

create temporary table qa_privacy_clock as
select pg_catalog.clock_timestamp() as as_of;

insert into auth.users(id, email)
values (
  '98000000-0000-4000-8000-000000000001',
  'privacy-retention@test.local'
);
insert into public.member_accounts(user_id, email, is_admin)
values (
  '98000000-0000-4000-8000-000000000001',
  'privacy-retention@test.local',
  true
);
insert into public.dolls(id, owner_id, image_url)
values
  (
    '98000000-0000-4000-8000-000000000010',
    '98000000-0000-4000-8000-000000000001',
    'https://example.test/privacy-retention.png'
  ),
  (
    '98000000-0000-4000-8000-000000000011',
    '98000000-0000-4000-8000-000000000001',
    'https://example.test/privacy-retention-purge.png'
  );

insert into public.content_reports(
  id, target_type, target_id, reason, detail, reporter_user_id,
  reporter_contact, status, created_at, resolved_at, resolved_by
)
values
  (
    '98000000-0000-4000-8000-000000000100',
    'doll',
    '98000000-0000-4000-8000-000000000010',
    'other',
    'pending detail',
    '98000000-0000-4000-8000-000000000001',
    'pending@test.local',
    'pending',
    (select as_of - interval '10 years' from qa_privacy_clock),
    null,
    null
  ),
  (
    '98000000-0000-4000-8000-000000000101',
    'doll',
    '98000000-0000-4000-8000-000000000010',
    'portrait',
    'eligible secret',
    '98000000-0000-4000-8000-000000000001',
    'eligible@test.local',
    'dismissed',
    (select as_of - interval '4 years' from qa_privacy_clock),
    (
      select as_of - interval '3 years 1 microsecond'
        from qa_privacy_clock
    ),
    '98000000-0000-4000-8000-000000000001'
  ),
  (
    '98000000-0000-4000-8000-000000000102',
    'doll',
    '98000000-0000-4000-8000-000000000010',
    'defamation',
    'exact boundary',
    null,
    null,
    'dismissed',
    (select as_of - interval '4 years' from qa_privacy_clock),
    (select as_of - interval '3 years' from qa_privacy_clock),
    '98000000-0000-4000-8000-000000000001'
  ),
  (
    '98000000-0000-4000-8000-000000000103',
    'doll',
    '98000000-0000-4000-8000-000000000010',
    'hate',
    'one microsecond inside window',
    null,
    null,
    'actioned',
    (select as_of - interval '4 years' from qa_privacy_clock),
    (
      select as_of - interval '3 years' + interval '1 microsecond'
        from qa_privacy_clock
    ),
    '98000000-0000-4000-8000-000000000001'
  ),
  (
    '98000000-0000-4000-8000-000000000104',
    'doll',
    '98000000-0000-4000-8000-000000000011',
    'defamation',
    'purge race',
    null,
    null,
    'actioned',
    (select as_of - interval '4 years' from qa_privacy_clock),
    (select as_of - interval '3 years 1 day' from qa_privacy_clock),
    '98000000-0000-4000-8000-000000000001'
  );

insert into public.content_report_submission_receipts(
  submission_id, target_id, reason, detail, reporter_contact,
  outcome, report_id, was_first, created_at
)
values
  (
    '98000000-0000-4000-8000-000000000201',
    '98000000-0000-4000-8000-000000000010',
    'portrait',
    'eligible secret',
    'eligible@test.local',
    'inserted',
    '98000000-0000-4000-8000-000000000101',
    true,
    (select as_of - interval '4 years' from qa_privacy_clock)
  ),
  (
    '98000000-0000-4000-8000-000000000202',
    '98000000-0000-4000-8000-000000000099',
    'other',
    'removed-target secret',
    'removed@test.local',
    'already_removed',
    null,
    false,
    (
      select as_of - interval '3 years 1 microsecond'
        from qa_privacy_clock
    )
  );

insert into public.moderation_actions_ledger(
  admin_user_id, action_type, target_type, target_id, report_id, reason
)
values (
  '98000000-0000-4000-8000-000000000001',
  'dismiss_report',
  'doll',
  '98000000-0000-4000-8000-000000000010',
  '98000000-0000-4000-8000-000000000101',
  'privacy retention linked ledger'
);

insert into public.moderation_purge_jobs(
  id, doll_id, admin_user_id, reason, status, manifest
)
values (
  '98000000-0000-4000-8000-000000000301',
  '98000000-0000-4000-8000-000000000011',
  '98000000-0000-4000-8000-000000000001',
  'privacy retention active purge',
  'pending',
  '[]'::jsonb
);

create temporary table qa_privacy_state as
select moderation_version as version_before
  from public.dolls
 where id = '98000000-0000-4000-8000-000000000010';

select ok(
  (
    select resolved_at = retention_terminal_at
      from public.content_reports
     where id = '98000000-0000-4000-8000-000000000101'
  ),
  'the first terminal clock is copied exactly into the retention anchor'
);
select throws_ok(
  $$
    update public.content_reports
       set resolved_at = resolved_at + interval '1 microsecond'
     where id = '98000000-0000-4000-8000-000000000101'
  $$,
  'P0001',
  'report_terminal_clock_immutable',
  'a known terminal timestamp is immutable'
);
select throws_ok(
  $$
    insert into public.content_reports(
      target_type, target_id, reason, status, resolved_at
    ) values (
      'doll',
      '98000000-0000-4000-8000-000000000010',
      'other',
      'pending',
      clock_timestamp()
    )
  $$,
  'P0001',
  'pending_report_terminal_clock_forbidden',
  'an open report cannot carry an expiry clock'
);
select throws_ok(
  $$
    delete from public.content_reports
     where id = '98000000-0000-4000-8000-000000000101'
  $$,
  'P0001',
  'content_reports_delete_forbidden',
  'ordinary SQL cannot bypass report retention'
);
select is(
  public.bp_content_report_retention_blocker(
    '98000000-0000-4000-8000-000000000100',
    (select as_of from qa_privacy_clock)
  ),
  'report_open',
  'pending reports remain open regardless of age'
);
select is(
  public.bp_content_report_retention_blocker(
    '98000000-0000-4000-8000-000000000101',
    (select as_of from qa_privacy_clock)
  ),
  null,
  'cutoff minus one microsecond is eligible'
);
select is(
  public.bp_content_report_retention_blocker(
    '98000000-0000-4000-8000-000000000102',
    (select as_of from qa_privacy_clock)
  ),
  'retention_window_open',
  'the exact three-year boundary is retained'
);
select is(
  public.bp_content_report_retention_blocker(
    '98000000-0000-4000-8000-000000000103',
    (select as_of from qa_privacy_clock)
  ),
  'retention_window_open',
  'cutoff plus one microsecond is retained'
);
select is(
  public.bp_content_report_retention_blocker(
    '98000000-0000-4000-8000-000000000104',
    (select as_of from qa_privacy_clock)
  ),
  'moderation_purge_open',
  'an active permanent-purge saga fences retention'
);

create temporary table qa_privacy_first_result as
select public.bp_maintain_privacy_retention(
  10,
  (select as_of from qa_privacy_clock)
) as result;

select ok(
  (
    select
      result->>'ok' = 'true'
      and result->>'processed' = '2'
      and result->>'content_report_processed' = '2'
      and result->>'payment_processed' = '0'
      and result->>'errors' = '0'
      from qa_privacy_first_result
  ),
  'eligible report plus old already-removed receipt share one bounded batch'
);
select ok(
  not exists (
    select 1
      from public.content_reports
     where id = '98000000-0000-4000-8000-000000000101'
  )
  and (
    select pg_catalog.count(*) = 4
      from public.content_reports
     where id in (
       '98000000-0000-4000-8000-000000000100',
       '98000000-0000-4000-8000-000000000102',
       '98000000-0000-4000-8000-000000000103',
       '98000000-0000-4000-8000-000000000104'
     )
  ),
  'eligible terminal report is purged while open/boundary/fenced rows remain'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.moderation_actions_ledger
     where report_id = '98000000-0000-4000-8000-000000000101'
  ),
  0,
  'report-linked moderation ledger is removed before its FK parent'
);
select ok(
  (
    select
      target_id is null
      and reason is null
      and detail is null
      and reporter_contact is null
      and outcome = 'already_removed'
      and report_id is null
      and was_first is false
      and payload_verifier
            ~ '^\$2[aby]\$10\$[./A-Za-z0-9]{53}$'
      and retained_at = (select as_of from qa_privacy_clock)
      from public.content_report_submission_receipts
     where submission_id = '98000000-0000-4000-8000-000000000201'
  ),
  'linked receipt becomes a non-identifying payload-hash tombstone'
);
select ok(
  (
    select
      target_id is null
      and reason is null
      and detail is null
      and reporter_contact is null
      and payload_verifier
            ~ '^\$2[aby]\$10\$[./A-Za-z0-9]{53}$'
      and retained_at = (select as_of from qa_privacy_clock)
      from public.content_report_submission_receipts
     where submission_id = '98000000-0000-4000-8000-000000000202'
  ),
  'already-removed response receipt is independently scrubbed after three years'
);
select is(
  (
    select pg_catalog.sum(record_count)::integer
      from public.content_report_retention_monthly_aggregates
  ),
  2,
  'one non-identifying aggregate record is counted per compacted source row'
);
select is(
  (
    select moderation_version
      from public.dolls
     where id = '98000000-0000-4000-8000-000000000010'
  ),
  (select version_before from qa_privacy_state),
  'retention bookkeeping does not advance the moderation ABA token'
);
select ok(
  (
    public.reserve_report_write_attempt(
      '98000000-0000-4000-8000-000000000201',
      '98000000-0000-4000-8000-000000000010',
      'portrait',
      'eligible secret',
      'eligible@test.local',
      pg_catalog.repeat('a', 64)
    )->>'outcome' = 'replay'
  )
  and (
    public.reserve_report_write_attempt(
      '98000000-0000-4000-8000-000000000201',
      '98000000-0000-4000-8000-000000000010',
      'portrait',
      'eligible secret',
      'eligible@test.local',
      pg_catalog.repeat('a', 64)
    )#>>'{result,already_removed}' = 'true'
  ),
  'an exact response-loss replay remains recoverable after raw-data purge'
);
select is(
  public.reserve_report_write_attempt(
    '98000000-0000-4000-8000-000000000201',
    '98000000-0000-4000-8000-000000000010',
    'portrait',
    'different payload',
    'eligible@test.local',
    pg_catalog.repeat('a', 64)
  )->>'error_code',
  'submission_conflict',
  'cross-payload reuse of a retained submission UUID fails closed'
);
select ok(
  (
    select
      status->>'consumer_dispute_source_mapped' = 'true'
      and status->'legal_blockers' = '[]'::jsonb
      and status->'external_boundaries' =
            '["external_consumer_complaint_manual_retention_runbook"]'::jsonb
      from (
        select public.bp_privacy_retention_status_at(
          (select as_of from qa_privacy_clock)
        ) as status
      ) q
  ),
  'in-service complaints are mapped and the manual email SOP is non-blocking'
);

delete from public.moderation_purge_jobs
 where id = '98000000-0000-4000-8000-000000000301';
select is(
  public.bp_maintain_privacy_retention(
    10,
    (select as_of from qa_privacy_clock)
  )->>'content_report_processed',
  '1',
  'a report becomes eligible once its purge fence is terminally absent'
);

insert into public.content_reports(
  id, target_type, target_id, reason, detail, reporter_contact,
  status, created_at, resolved_at, resolved_by
)
values (
  '98000000-0000-4000-8000-000000000105',
  'doll',
  '98000000-0000-4000-8000-000000000010',
  'obscene',
  'fault injection raw detail',
  'fault@test.local',
  'dismissed',
  (select as_of - interval '4 years' from qa_privacy_clock),
  (select as_of - interval '3 years 1 month' from qa_privacy_clock),
  '98000000-0000-4000-8000-000000000001'
);

create function pg_temp.qa_fail_privacy_report_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.id = '98000000-0000-4000-8000-000000000105'::uuid then
    raise exception 'qa_retention_fault' using errcode = 'P7777';
  end if;
  return old;
end;
$$;
create trigger trg_zz_qa_fail_privacy_report_delete
  before delete on public.content_reports
  for each row execute function pg_temp.qa_fail_privacy_report_delete();

select ok(
  (
    select
      result->>'ok' = 'false'
      and result->>'errors' = '1'
      and result->>'content_report_errors' = '1'
      and result->>'processed' = '0'
      from (
        select public.bp_maintain_privacy_retention(
          10,
          (select as_of from qa_privacy_clock)
        ) as result
      ) q
  ),
  'a per-report fault is visible without aborting the bounded worker'
);
select ok(
  exists (
    select 1
      from public.content_reports
     where id = '98000000-0000-4000-8000-000000000105'
       and detail = 'fault injection raw detail'
       and reporter_contact = 'fault@test.local'
  )
  and exists (
    select 1
      from public.content_report_retention_failures
     where subject_type = 'report'
       and subject_id = '98000000-0000-4000-8000-000000000105'
       and attempt_count = 1
       and last_sqlstate = 'P7777'
       and retry_after =
             (select as_of + interval '5 minutes' from qa_privacy_clock)
  )
  and not exists (
    select 1
      from public.content_report_retention_monthly_aggregates
     where terminal_status = 'dismissed'
       and reason_code = 'obscene'
       and month_utc = (
         select (
           pg_catalog.date_trunc(
             'month',
             (as_of - interval '3 years 1 month') at time zone 'UTC'
           )
         )::date
           from qa_privacy_clock
       )
  ),
  'fault rolls back aggregate/scrub and persists only SQLSTATE retry evidence'
);

drop trigger trg_zz_qa_fail_privacy_report_delete
  on public.content_reports;
update public.content_report_retention_failures
   set retry_after = (select as_of from qa_privacy_clock)
 where subject_type = 'report'
   and subject_id = '98000000-0000-4000-8000-000000000105';
create temporary table qa_privacy_retry_result as
select public.bp_maintain_privacy_retention(
  10,
  (select as_of from qa_privacy_clock)
) as result;
select ok(
  (
    select result->>'content_report_processed' = '1'
      from qa_privacy_retry_result
  )
  and not exists (
    select 1
      from public.content_reports
     where id = '98000000-0000-4000-8000-000000000105'
  )
  and not exists (
    select 1
      from public.content_report_retention_failures
     where subject_type = 'report'
       and subject_id = '98000000-0000-4000-8000-000000000105'
  ),
  'a due retry succeeds once the transient fault is removed'
);

insert into public.content_reports(
  id, target_type, target_id, reason, status,
  created_at, resolved_at, resolved_by
)
select
  (
    '98000000-0000-4000-8001-'
      || pg_catalog.lpad(g::text, 12, '0')
  )::uuid,
  'doll',
  '98000000-0000-4000-8000-000000000010',
  'hate',
  'dismissed',
  (select as_of - interval '4 years' from qa_privacy_clock),
  (select as_of - interval '3 years 2 months' from qa_privacy_clock),
  '98000000-0000-4000-8000-000000000001'
from pg_catalog.generate_series(1, 101) g;
create temporary table qa_privacy_high_version as
select moderation_version as version_before
  from public.dolls
 where id = '98000000-0000-4000-8000-000000000010';

create temporary table qa_privacy_high_result as
select public.bp_maintain_privacy_retention(
  100,
  (select as_of from qa_privacy_clock)
) as result;
select ok(
  (
    select
      result->>'processed' = '100'
      and result->>'content_report_processed' = '100'
      and result->>'errors' = '0'
      and result->>'content_report_ready' = '1'
      from qa_privacy_high_result
  ),
  'high-cardinality input consumes exactly the global 100-attempt budget'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.content_reports
     where id::text like '98000000-0000-4000-8001-%'
  ),
  1,
  'a 101-row candidate set leaves exactly one row after the first batch'
);
select is(
  (
    select moderation_version
      from public.dolls
     where id = '98000000-0000-4000-8000-000000000010'
  ),
  (select version_before from qa_privacy_high_version),
  '100 retention deletes still cause zero moderation-version ABA changes'
);
create temporary table qa_privacy_high_drain_result as
select public.bp_maintain_privacy_retention(
  100,
  (select as_of from qa_privacy_clock)
) as result;
select ok(
  (
    select result->>'content_report_processed' = '1'
      from qa_privacy_high_drain_result
  )
  and not exists (
    select 1
      from public.content_reports
     where id::text like '98000000-0000-4000-8001-%'
  ),
  'the next bounded batch drains the final high-cardinality row'
);
create temporary table qa_privacy_high_rerun_result as
select public.bp_maintain_privacy_retention(
  100,
  (select as_of from qa_privacy_clock)
) as result;
select ok(
  (
    select result->>'processed' = '0'
      from qa_privacy_high_rerun_result
  )
  and (
    select record_count = 101
      from public.content_report_retention_monthly_aggregates
     where terminal_status = 'dismissed'
       and reason_code = 'hate'
       and month_utc = (
         select (
           pg_catalog.date_trunc(
             'month',
             (as_of - interval '3 years 2 months') at time zone 'UTC'
           )
         )::date
           from qa_privacy_clock
       )
  ),
  'response-loss rerun is idempotent and cannot double-count aggregates'
);

alter table public.orders
  disable trigger trg_orders_insert_guard;
insert into public.orders(
  order_uuid, user_id, product_id, amount, credits, status,
  provider, created_at, updated_at, paid_at
)
values
  (
    '98000000-0000-4000-8000-000000000401',
    '98000000-0000-4000-8000-000000000001',
    'privacy-old',
    1100,
    2,
    'paid',
    'payapp',
    (
      select as_of - interval '5 years 1 microsecond'
        from qa_privacy_clock
    ),
    (
      select as_of - interval '5 years 1 microsecond'
        from qa_privacy_clock
    ),
    (
      select as_of - interval '5 years 1 microsecond'
        from qa_privacy_clock
    )
  ),
  (
    '98000000-0000-4000-8000-000000000402',
    '98000000-0000-4000-8000-000000000001',
    'privacy-exact',
    2200,
    4,
    'paid',
    'payapp',
    (select as_of - interval '5 years' from qa_privacy_clock),
    (select as_of - interval '5 years' from qa_privacy_clock),
    (select as_of - interval '5 years' from qa_privacy_clock)
  );
alter table public.orders
  enable trigger trg_orders_insert_guard;
insert into public.credit_lots(
  id, user_id, source, order_uuid, qty, consumed,
  granted_at, expires_at, expired_at, expiration_reason,
  created_at, updated_at
)
values (
  '98000000-0000-4000-8000-000000000411',
  '98000000-0000-4000-8000-000000000001',
  'purchase',
  '98000000-0000-4000-8000-000000000401',
  2,
  2,
  (select as_of - interval '6 years' from qa_privacy_clock),
  (select as_of - interval '5 years 1 day' from qa_privacy_clock),
  (
    select as_of - interval '5 years 1 microsecond'
      from qa_privacy_clock
  ),
  'natural',
  (select as_of - interval '6 years' from qa_privacy_clock),
  (
    select as_of - interval '5 years 1 microsecond'
      from qa_privacy_clock
  )
);

select ok(
  public.bp_payment_retention_blocker(
    '98000000-0000-4000-8000-000000000401',
    (select as_of from qa_privacy_clock)
  ) is null
  and public.bp_payment_retention_blocker(
    '98000000-0000-4000-8000-000000000402',
    (select as_of from qa_privacy_clock)
  ) = 'retention_window_open',
  'payment cutoff is also strict at minus/exact one microsecond'
);
create temporary table qa_privacy_payment_result as
select public.bp_maintain_privacy_retention(
  10,
  (select as_of from qa_privacy_clock)
) as result;
select ok(
  (
    select
      result->>'ok' = 'true'
      and result->>'processed' = '1'
      and result->>'payment_processed' = '1'
      and result->>'content_report_processed' = '0'
      from qa_privacy_payment_result
  ),
  'eligible terminal payment detail is compacted within the shared budget'
);
select ok(
  not exists (
    select 1
      from public.orders
     where order_uuid = '98000000-0000-4000-8000-000000000401'
  )
  and not exists (
    select 1
      from public.credit_lots
     where id = '98000000-0000-4000-8000-000000000411'
  )
  and exists (
    select 1
      from public.orders
     where order_uuid = '98000000-0000-4000-8000-000000000402'
  ),
  'payment child graph is removed before the order while exact-boundary stays'
);
select ok(
  (
    select
      order_count = 1
      and gross_amount = 1100
      and granted_credits = 2
      from public.payment_retention_monthly_aggregates
     where provider = 'payapp'
       and terminal_status = 'paid'
       and is_test is false
       and month_utc = (
         select (
           pg_catalog.date_trunc(
             'month',
             (as_of - interval '5 years 1 microsecond')
               at time zone 'UTC'
           )
         )::date
           from qa_privacy_clock
       )
  ),
  'payment compaction preserves only the non-identifying monthly totals'
);
select throws_ok(
  $$
    delete from public.content_reports
     where id = '98000000-0000-4000-8000-000000000102'
  $$,
  'P0001',
  'content_reports_delete_forbidden',
  'worker clears its narrow delete capability before returning'
);
select ok(
  (
    select
      status->>'content_report_ready' = '0'
      and status->>'content_report_blocked' = '0'
      and status->>'content_report_open' = '1'
      and status->>'payment_ready' = '0'
      from (
        select public.bp_privacy_retention_status_at(
          (select as_of from qa_privacy_clock)
        ) as status
      ) q
  ),
  'status distinguishes unresolved reports from retention backlog'
);

select * from finish();
rollback;
