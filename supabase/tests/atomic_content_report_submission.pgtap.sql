-- 0080 atomic report contract. Cross-session blocking is covered by
-- scripts/qa/test-report-submission-race.sh.

begin;
select plan(46);

select has_function(
  'public',
  'submit_content_report',
  array['uuid', 'uuid', 'text', 'text', 'uuid', 'text', 'boolean', 'text'],
  'network-bounded atomic report RPC exists'
);
select has_table(
  'public',
  'content_report_submission_receipts',
  'durable report receipt table exists'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)'::regprocedure
  ),
  'report RPC is SECURITY DEFINER'
);
select is(
  (
    select r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid =
       'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)'::regprocedure
  ),
  'postgres',
  'report RPC has the expected owner'
);
select ok(
  (
    select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
      from pg_catalog.pg_proc p
     where p.oid =
       'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)'::regprocedure
  ),
  'report RPC pins an empty search_path'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)',
    'EXECUTE'
  ),
  'service role can submit reports only through the network-bounded RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
    'EXECUTE'
  ),
  'anon cannot bypass the public HTTP boundary'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
    'EXECUTE'
  ),
  'authenticated cannot bypass the public HTTP boundary'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.content_report_submission_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role cannot read or mutate report receipts directly'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.content_report_submission_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.content_report_submission_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'browser roles cannot read reporter receipt PII'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.content_reports',
    'INSERT'
  ),
  'service role cannot reintroduce split direct INSERT'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'public'
       and indexname = 'idx_content_reports_pending_target'
  ),
  'pending target lookup has a partial index'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)'::regprocedure
    )
  ),
  'for key share',
  'report locks the doll lifecycle row'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)'::regprocedure
    )
  ),
  'pg_advisory_xact_lock',
  'same-target first-pending election is serialized'
);

create temporary table report_ctx (
  user_id uuid not null,
  doll_id uuid not null,
  deleted_doll_id uuid not null,
  first_submission_id uuid not null,
  deleted_submission_id uuid not null,
  first_result jsonb not null,
  second_result jsonb not null,
  third_result jsonb
) on commit drop;

do $fixture$
declare
  v_user uuid := gen_random_uuid();
  v_doll uuid := gen_random_uuid();
  v_deleted_doll uuid := gen_random_uuid();
  v_first_submission uuid := gen_random_uuid();
  v_second_submission uuid := gen_random_uuid();
  v_deleted_submission uuid := gen_random_uuid();
  v_first jsonb;
  v_second jsonb;
begin
  insert into auth.users(id, email)
  values (v_user, 'atomic-report@example.test');
  insert into public.dolls(id, owner_id, image_url)
  values
    (v_doll, v_user, 'active-report.png'),
    (v_deleted_doll, v_user, 'deleted-report.png');
  update public.dolls
     set deleted_at = clock_timestamp()
   where id = v_deleted_doll;

  v_first := public.submit_content_report(
    v_first_submission,
    v_doll,
    'portrait',
    '  detail text  ',
    v_user,
    '  reporter@example.test  ',
    true
  );
  v_second := public.submit_content_report(
    v_second_submission,
    v_doll,
    'other',
    null,
    null,
    null,
    true
  );
  insert into report_ctx(
    user_id,
    doll_id,
    deleted_doll_id,
    first_submission_id,
    deleted_submission_id,
    first_result,
    second_result
  )
  values (
    v_user,
    v_doll,
    v_deleted_doll,
    v_first_submission,
    v_deleted_submission,
    v_first,
    v_second
  );
end;
$fixture$;

select is(first_result->>'ok', 'true', 'first report succeeds')
  from report_ctx;
select is(first_result->>'inserted', 'true', 'first report is inserted')
  from report_ctx;
select is(
  first_result->>'already_removed',
  'false',
  'active target is not reported as removed'
) from report_ctx;
select is(
  first_result->>'was_first',
  'true',
  'first pending report wins the alert election'
) from report_ctx;
select is(
  first_result->>'duplicate',
  'false',
  'first execution is not marked as a replay'
) from report_ctx;
select is(
  (
    select count(*)::int
      from public.content_reports r
      join report_ctx c
        on r.id = (c.first_result->>'report_id')::uuid
       and r.target_id = c.doll_id
  ),
  1,
  'returned first report id identifies the committed row'
);
select is(
  (
    select r.detail || '|' || r.reporter_contact
      from public.content_reports r
      join report_ctx c
        on r.id = (c.first_result->>'report_id')::uuid
  ),
  'detail text|reporter@example.test',
  'optional text is trimmed before persistence'
);
select is(second_result->>'inserted', 'true', 'later report is also retained')
  from report_ctx;
select is(
  second_result->>'was_first',
  'false',
  'later report does not duplicate the pending-wave alert'
) from report_ctx;
select is(
  second_result->>'duplicate',
  'false',
  'a distinct later intent is not a replay'
) from report_ctx;
select is(
  (
    select count(*)::int
      from public.content_reports r
      join report_ctx c on r.target_id = c.doll_id
     where r.status = 'pending'
  ),
  2,
  'both reports are retained while exactly one wins the alert'
);

select is(
  (
    select public.submit_content_report(
      c.first_submission_id,
      c.doll_id,
      'portrait',
      'detail text',
      null,
      'reporter@example.test',
      false
    )->>'report_id'
      from report_ctx c
  ),
  (
    select first_result->>'report_id'
      from report_ctx
  ),
  'response-loss retry replays the exact committed report id'
);
select is(
  (
    select public.submit_content_report(
      c.first_submission_id,
      c.doll_id,
      'portrait',
      'detail text',
      null,
      'reporter@example.test',
      false
    )->>'duplicate'
      from report_ctx c
  ),
  'true',
  'exact receipt replay bypasses later rate-limit exhaustion'
);
select is(
  (
    select count(*)::int
      from public.content_reports r
      join report_ctx c on r.target_id = c.doll_id
  ),
  2,
  'exact receipt replay never inserts a second row'
);
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,%L,null,%L,true)',
    first_submission_id,
    doll_id,
    'other',
    'detail text',
    'reporter@example.test'
  ),
  'P0001',
  'submission_conflict',
  'same submission id cannot be reused for a changed payload'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,null,null,null,false)',
    gen_random_uuid(),
    doll_id,
    'other'
  ),
  'P0001',
  'rate_limited',
  'a new intent cannot bypass rate-limit exhaustion'
) from report_ctx;

update public.content_reports r
   set status = 'dismissed',
       resolved_at = clock_timestamp()
  from report_ctx c
 where r.target_id = c.doll_id
   and r.status = 'pending';
update report_ctx c
   set third_result = public.submit_content_report(
     gen_random_uuid(),
     c.doll_id,
     'hate',
     '',
     null,
     '',
     true
   );

select is(
  third_result->>'was_first',
  'true',
  'a new pending wave elects a new first report'
) from report_ctx;
select is(
  (
    select count(*)::int
      from public.content_reports r
      join report_ctx c on r.target_id = c.doll_id
  ),
  3,
  'new-wave submission adds exactly one row'
);
select is(
  (
    select public.submit_content_report(
      c.deleted_submission_id,
      c.deleted_doll_id,
      'other',
      null,
      null,
      null,
      true
    )->>'inserted'
      from report_ctx c
  ),
  'false',
  'deleted target is an idempotent non-insert'
);
select is(
  (
    select public.submit_content_report(
      c.deleted_submission_id,
      c.deleted_doll_id,
      'other',
      null,
      null,
      null,
      false
    )->>'already_removed'
      from report_ctx c
  ),
  'true',
  'deleted target is explicitly reported as already removed'
);
select is(
  (
    select public.submit_content_report(
      c.deleted_submission_id,
      c.deleted_doll_id,
      'other',
      null,
      null,
      null,
      false
    )->>'duplicate'
      from report_ctx c
  ),
  'true',
  'already-removed outcome is also durably replayable'
);
select is(
  (
    select count(*)::int
      from public.content_report_submission_receipts r
      join report_ctx c
        on r.submission_id in (
          c.first_submission_id,
          c.deleted_submission_id
        )
  ),
  2,
  'inserted and already-removed outcomes both have one receipt'
);
select is(
  (
    select count(*)::int
      from public.content_reports r
      join report_ctx c on r.target_id = c.deleted_doll_id
  ),
  0,
  'deleted target never receives a pending row'
);

select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,null,null,null,true)',
    gen_random_uuid(),
    gen_random_uuid(),
    'other'
  ),
  'P0001',
  'target_not_found',
  'missing target is distinct from a deleted target'
);
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,null,null,null,true)',
    gen_random_uuid(),
    doll_id,
    'forged'
  ),
  'P0001',
  'reason_invalid',
  'DB enforces the reason allowlist'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,null,null,null,null,true)',
    gen_random_uuid(),
    doll_id
  ),
  'P0001',
  'reason_invalid',
  'null reason is rejected'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,%L,null,null,true)',
    gen_random_uuid(),
    doll_id,
    'other',
    repeat('x', 2001)
  ),
  'P0001',
  'detail_invalid',
  'oversized detail is rejected without truncation'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,null,null,%L,true)',
    gen_random_uuid(),
    doll_id,
    'other',
    repeat('x', 201)
  ),
  'P0001',
  'contact_invalid',
  'oversized contact is rejected without truncation'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,null,%L::uuid,null,true)',
    gen_random_uuid(),
    doll_id,
    'other',
    gen_random_uuid()
  ),
  '23503',
  null,
  'unknown reporter cannot forge a profile reference'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(null,%L::uuid,%L,null,null,null,true)',
    doll_id,
    'other'
  ),
  'P0001',
  'submission_id_required',
  'DB rejects identity-free submissions instead of guessing'
) from report_ctx;
select throws_ok(
  format(
    'select public.submit_content_report(%L::uuid,%L::uuid,%L,%L,null,%L,true)',
    first_submission_id,
    deleted_doll_id,
    'portrait',
    'detail text',
    'reporter@example.test'
  ),
  'P0001',
  'submission_conflict',
  'same submission id cannot cross target boundaries'
) from report_ctx;
select is(
  (
    select count(*)::int
      from public.content_reports r
      join report_ctx c on r.target_id = c.doll_id
  ),
  3,
  'all rejected submissions leave report rows unchanged'
);

select * from finish();
rollback;
