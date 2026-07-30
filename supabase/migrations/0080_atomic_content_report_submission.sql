-- 0080: atomic public content-report submission.
--
-- The former route did `pending count -> insert` as two autocommit requests.
-- Concurrent first reports could both emit the sole operational takedown alert,
-- and resolved SDK read errors were indistinguishable from count=0/not-found.
--
-- A public response can be lost after commit. The new client therefore owns a
-- stable submission UUID and the database stores an immutable exact-payload
-- receipt in the same transaction as the report. A request without such an ID
-- cannot be deduplicated without guessing that two identical reports are one.
--
-- Migration-first rollout: land this additive RPC, wait for PostgREST reload,
-- then deploy the route that calls it. Old servers continue direct INSERT only
-- during the expand window; 0092 closes that compatibility grant.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if to_regclass('public.dolls') is null
     or to_regclass('public.content_reports') is null then
    raise exception '0080 preflight: moderation tables missing';
  end if;
end;
$$;

create index if not exists idx_content_reports_pending_target
  on public.content_reports(target_type, target_id, created_at, id)
  where status = 'pending';

create table public.content_report_submission_receipts (
  submission_id uuid primary key,
  target_id uuid not null,
  reason text not null check (
    reason in ('portrait', 'defamation', 'obscene', 'hate', 'other')
  ),
  detail text check (pg_catalog.char_length(detail) <= 2000),
  reporter_contact text check (
    pg_catalog.char_length(reporter_contact) <= 200
  ),
  outcome text not null check (outcome in ('inserted', 'already_removed')),
  report_id uuid unique references public.content_reports(id),
  was_first boolean not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint content_report_submission_receipts_outcome_shape check (
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
);

comment on table public.content_report_submission_receipts is
  'Immutable exact-payload receipt for public report response-loss replay. Old rollout inserts have no receipt.';

alter table public.content_report_submission_receipts enable row level security;
revoke all on table public.content_report_submission_receipts
  from public, anon, authenticated, service_role;
create index idx_content_report_receipts_created
  on public.content_report_submission_receipts(created_at, submission_id);

create or replace function public.submit_content_report(
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
  v_deleted_at timestamptz;
  v_receipt public.content_report_submission_receipts%rowtype;
  v_detail text := nullif(pg_catalog.btrim(p_detail), '');
  v_contact text := nullif(
    pg_catalog.btrim(p_reporter_contact),
    ''
  );
  v_report_id uuid;
  v_was_first boolean;
begin
  if p_submission_id is null then
    raise exception 'submission_id_required' using errcode = 'P0001';
  end if;
  if p_reason is null
     or p_reason not in (
       'portrait',
       'defamation',
       'obscene',
       'hate',
       'other'
     ) then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  if v_detail is not null and pg_catalog.char_length(v_detail) > 2000 then
    raise exception 'detail_invalid' using errcode = 'P0001';
  end if;
  if v_contact is not null and pg_catalog.char_length(v_contact) > 200 then
    raise exception 'contact_invalid' using errcode = 'P0001';
  end if;
  if p_rate_allowed is null then
    raise exception 'rate_decision_required' using errcode = 'P0001';
  end if;

  -- The submission lock is first and is never acquired by moderation/account
  -- mutations. It serializes both concurrent duplicate calls and malicious
  -- cross-target reuse without introducing a lifecycle lock cycle.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:submission:' || p_submission_id::text,
      0::bigint
    )
  );

  select r.*
    into v_receipt
    from public.content_report_submission_receipts r
   where r.submission_id = p_submission_id;
  if found then
    if v_receipt.target_id is distinct from p_target_id
       or v_receipt.reason is distinct from p_reason
       or v_receipt.detail is distinct from v_detail
       or v_receipt.reporter_contact is distinct from v_contact then
      raise exception 'submission_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'inserted', v_receipt.outcome = 'inserted',
      'already_removed', v_receipt.outcome = 'already_removed',
      'was_first', v_receipt.was_first,
      'report_id', v_receipt.report_id,
      'duplicate', true
    );
  end if;

  -- Rate-limit exhaustion cannot hide a committed receipt from a retry, but it
  -- must reject every new intent before target reads or writes.
  if p_rate_allowed is not true then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- Global moderation ordering point. Takedown/permanent-delete/account-delete
  -- all need a conflicting doll-row lock, so no pending report can appear after
  -- deletion commits and a deletion cannot miss a committed report.
  select d.deleted_at
    into v_deleted_at
    from public.dolls d
   where d.id = p_target_id
   for key share;
  if not found then
    raise exception 'target_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    insert into public.content_report_submission_receipts(
      submission_id,
      target_id,
      reason,
      detail,
      reporter_contact,
      outcome,
      report_id,
      was_first
    )
    values (
      p_submission_id,
      p_target_id,
      p_reason,
      v_detail,
      v_contact,
      'already_removed',
      null,
      false
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'inserted', false,
      'already_removed', true,
      'was_first', false,
      'report_id', null,
      'duplicate', false
    );
  end if;

  -- Row KEY SHARE locks are mutually compatible, so serialize reports for the
  -- same target separately. Different dolls remain fully concurrent.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:doll:' || p_target_id::text,
      0::bigint
    )
  );

  select not exists (
    select 1
      from public.content_reports r
     where r.target_type = 'doll'
       and r.target_id = p_target_id
       and r.status = 'pending'
  )
    into v_was_first;

  insert into public.content_reports(
    target_type,
    target_id,
    reason,
    detail,
    reporter_user_id,
    reporter_contact
  )
  values (
    'doll',
    p_target_id,
    p_reason,
    v_detail,
    p_reporter_user_id,
    v_contact
  )
  returning id into v_report_id;

  insert into public.content_report_submission_receipts(
    submission_id,
    target_id,
    reason,
    detail,
    reporter_contact,
    outcome,
    report_id,
    was_first
  )
  values (
    p_submission_id,
    p_target_id,
    p_reason,
    v_detail,
    v_contact,
    'inserted',
    v_report_id,
    v_was_first
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'inserted', true,
    'already_removed', false,
    'was_first', v_was_first,
    'report_id', v_report_id,
    'duplicate', false
  );
end;
$$;

alter function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
)
  owner to postgres;
revoke all on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
) to service_role;

-- Rolling expand stage: old servers still submit directly until the app
-- deployment completes. 0092 removes this temporary service-role grant.
revoke insert on table public.content_reports from service_role;
grant insert on table public.content_reports to service_role;

comment on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
) is
  'Exactly-once public report receipt, lifecycle serialization, and one first-pending election per target wave.';

do $$
declare
  v_proc regprocedure :=
    to_regprocedure(
      'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)'
    );
  v_owner text;
  v_security_definer boolean;
  v_config text[];
begin
  if v_proc is null then
    raise exception '0080 postflight: submit RPC missing';
  end if;

  select r.rolname, p.prosecdef, p.proconfig
    into v_owner, v_security_definer, v_config
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_proc;

  if v_owner <> 'postgres'
     or v_security_definer is not true
     or not coalesce(v_config, '{}'::text[]) @> array['search_path=""'] then
    raise exception '0080 postflight: owner/security/search_path drift';
  end if;
  if not has_function_privilege('service_role', v_proc, 'EXECUTE')
     or has_function_privilege('anon', v_proc, 'EXECUTE')
     or has_function_privilege('authenticated', v_proc, 'EXECUTE') then
    raise exception '0080 postflight: function ACL drift';
  end if;
  if not has_table_privilege(
    'service_role',
    'public.content_reports',
    'INSERT'
  ) then
    raise exception '0080 postflight: rolling report INSERT compatibility missing';
  end if;
  if has_table_privilege(
       'service_role',
       'public.content_report_submission_receipts',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'anon',
       'public.content_report_submission_receipts',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'authenticated',
       'public.content_report_submission_receipts',
       'SELECT,INSERT,UPDATE,DELETE'
     )
  then
    raise exception '0080 postflight: report receipt ACL drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0080_atomic_content_report_submission', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
