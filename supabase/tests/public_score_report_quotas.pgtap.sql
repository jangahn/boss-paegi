-- 008900 score/report durable-write quota boundaries. Cross-connection final
-- slot races are covered by scripts/qa/test-public-score-report-quota-races.sh.

begin;
select plan(52);

select ok(
  has_function_privilege(
    'service_role',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_submit_score_with_review_core(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_consume_score_write_quota(text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_probe_score_write_replay(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb)',
    'EXECUTE'
  ),
  'only the network-bounded score wrapper is a Data API authority'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
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
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_consume_report_write_quota(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_consume_report_legacy_write_quota()',
    'EXECUTE'
  )
  and not has_table_privilege(
    'service_role',
    'public.content_reports',
    'INSERT'
  ),
  'only the network-bounded report wrapper is a Data API authority'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.public_write_attempts'::regclass
  )
  and not has_table_privilege(
    'service_role',
    'public.public_write_attempts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'opaque write attempts are RLS-enabled and reachable only through RPCs'
);

create function pg_temp.qa_digest(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_value, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

insert into auth.users(id, email)
values
  (
    '96000000-0000-4000-8000-000000000001',
    'public-quota-score-a@test.local'
  ),
  (
    '96000000-0000-4000-8000-000000000002',
    'public-quota-score-b@test.local'
  );
insert into public.member_accounts(user_id, email)
values
  (
    '96000000-0000-4000-8000-000000000001',
    'public-quota-score-a@test.local'
  ),
  (
    '96000000-0000-4000-8000-000000000002',
    'public-quota-score-b@test.local'
  );
insert into public.dolls(id, owner_id, image_url)
values (
  '96000000-0000-4000-8000-000000000010',
  '96000000-0000-4000-8000-000000000001',
  'public-quota-report.png'
);

delete from public.public_write_quota_buckets
 where endpoint in ('score', 'report');
delete from public.public_write_attempts
 where endpoint in ('score', 'report');

-- Score owner dimension: N-1 -> final slot -> exact replay -> N+1.
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values
  (
    'score',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    'global',
    0
  ),
  (
    'score',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    pg_temp.qa_digest(
      'score-network:' || pg_catalog.repeat('a', 64)
    ),
    0
  ),
  (
    'score',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    pg_temp.qa_digest(
      'score-owner:96000000-0000-4000-8000-000000000001'
    ),
    99
  );
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null,
    100,
    'fist',
    1000,
    1,
    'normal',
    null,
    'registered',
    '[]'::jsonb,
    jsonb_build_object(
      'submissionId',
      '96000000-0000-4000-8000-000000000101',
      'submissionFingerprint',
      pg_catalog.repeat('1', 64)
    ),
    0,
    'quota-test',
    pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'false',
  'score owner N-1 admits the exact final slot'
);
select ok(
  (select request_count = 1
     from public.public_write_quota_buckets
    where endpoint = 'score' and actor_key = 'global')
  and
  (select request_count = 1
     from public.public_write_quota_buckets
    where endpoint = 'score'
      and actor_key = pg_temp.qa_digest(
        'score-network:' || pg_catalog.repeat('a', 64)
      ))
  and
  (select request_count = 100
     from public.public_write_quota_buckets
    where endpoint = 'score'
      and actor_key = pg_temp.qa_digest(
        'score-owner:96000000-0000-4000-8000-000000000001'
      )),
  'score final owner slot increments all three dimensions exactly once'
);
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null,
    100,
    'fist',
    1000,
    1,
    'normal',
    null,
    'registered',
    '[]'::jsonb,
    jsonb_build_object(
      'submissionId',
      '96000000-0000-4000-8000-000000000101',
      'submissionFingerprint',
      pg_catalog.repeat('1', 64)
    ),
    0,
    'quota-test',
    pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'true',
  'exact score replay remains recoverable at the owner cap'
);
select is(
  (
    select pg_catalog.sum(request_count)::integer
      from public.public_write_quota_buckets
     where endpoint = 'score'
  ),
  102,
  'exact score replay consumes no quota dimension'
);
select throws_ok(
  $sql$
    select public.submit_score_with_review(
      '96000000-0000-4000-8000-000000000001',
      null, 101, 'fist', 1000, 1, 'normal', null,
      'registered', '[]'::jsonb,
      '{"submissionId":"96000000-0000-4000-8000-000000000102","submissionFingerprint":"2222222222222222222222222222222222222222222222222222222222222222"}'::jsonb,
      0, 'quota-test',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $sql$,
  'P0001',
  'score_write_owner_request_quota',
  'new score over the owner cap is rejected'
);
select ok(
  not exists (
    select 1 from public.scores
     where submission_origin_owner_id =
             '96000000-0000-4000-8000-000000000001'
       and submission_id =
             '96000000-0000-4000-8000-000000000102'
  )
  and
  (select request_count = 100
     from public.public_write_quota_buckets
    where endpoint = 'score'
      and actor_key = pg_temp.qa_digest(
        'score-owner:96000000-0000-4000-8000-000000000001'
      )),
  'owner rejection creates no score and never overflows its counter'
);
select is(
  public.reserve_score_write_attempt(
    '96000000-0000-4000-8000-000000000001',
    null, 102, 'fist', 1000, 1, 'normal', null,
    '{"submissionId":"96000000-0000-4000-8000-000000000112","submissionFingerprint":"1212121212121212121212121212121212121212121212121212121212121212"}'::jsonb,
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  )->>'error_code',
  'score_write_owner_request_quota',
  'owner cap rejects a separately committed reservation with a fresh network'
);
select ok(
  not exists (
    select 1
      from public.public_write_quota_buckets
     where endpoint = 'score'
       and actor_key = pg_temp.qa_digest(
         'score-network:' || pg_catalog.repeat('c', 64)
       )
  ),
  'owner-cap rejection leaves no zero-count network row to spray'
);

-- Score network dimension.
delete from public.public_write_quota_buckets where endpoint = 'score';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values
  (
    'score',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    'global',
    0
  ),
  (
    'score',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    pg_temp.qa_digest(
      'score-network:' || pg_catalog.repeat('b', 64)
    ),
    299
  ),
  (
    'score',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    pg_temp.qa_digest(
      'score-owner:96000000-0000-4000-8000-000000000002'
    ),
    0
  );
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000002',
    null, 110, 'hammer', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    jsonb_build_object(
      'submissionId',
      '96000000-0000-4000-8000-000000000103',
      'submissionFingerprint',
      pg_catalog.repeat('3', 64)
    ),
    0, 'quota-test', pg_catalog.repeat('b', 64)
  )->>'duplicate',
  'false',
  'score network N-1 admits the exact final slot'
);
select ok(
  (select request_count = 1
     from public.public_write_quota_buckets
    where endpoint = 'score' and actor_key = 'global')
  and
  (select request_count = 300
     from public.public_write_quota_buckets
    where endpoint = 'score'
      and actor_key = pg_temp.qa_digest(
        'score-network:' || pg_catalog.repeat('b', 64)
      ))
  and
  (select request_count = 1
     from public.public_write_quota_buckets
    where endpoint = 'score'
      and actor_key = pg_temp.qa_digest(
        'score-owner:96000000-0000-4000-8000-000000000002'
      )),
  'score final network slot increments global, network, and owner once'
);
select throws_ok(
  $sql$
    select public.submit_score_with_review(
      '96000000-0000-4000-8000-000000000002',
      null, 111, 'hammer', 1000, 1, 'normal', null,
      'registered', '[]'::jsonb,
      '{"submissionId":"96000000-0000-4000-8000-000000000104","submissionFingerprint":"4444444444444444444444444444444444444444444444444444444444444444"}'::jsonb,
      0, 'quota-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  $sql$,
  'P0001',
  'score_write_network_request_quota',
  'new score over the network cap is rejected'
);
select ok(
  not exists (
    select 1 from public.scores
     where submission_origin_owner_id =
             '96000000-0000-4000-8000-000000000002'
       and submission_id =
             '96000000-0000-4000-8000-000000000104'
  )
  and
  (select request_count = 300
     from public.public_write_quota_buckets
    where endpoint = 'score'
      and actor_key = pg_temp.qa_digest(
        'score-network:' || pg_catalog.repeat('b', 64)
      )),
  'network rejection creates no score and never overflows its counter'
);
select is(
  public.reserve_score_write_attempt(
    '96000000-0000-4000-8000-000000000001',
    null, 112, 'hammer', 1000, 1, 'normal', null,
    '{"submissionId":"96000000-0000-4000-8000-000000000113","submissionFingerprint":"1313131313131313131313131313131313131313131313131313131313131313"}'::jsonb,
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )->>'error_code',
  'score_write_network_request_quota',
  'network cap rejects a separately committed reservation with a fresh owner'
);
select ok(
  not exists (
    select 1
      from public.public_write_quota_buckets
     where endpoint = 'score'
       and actor_key = pg_temp.qa_digest(
         'score-owner:96000000-0000-4000-8000-000000000001'
       )
  ),
  'network-cap rejection leaves no zero-count owner row to spray'
);

-- Score global dimension and quota-before-core rollback.
delete from public.public_write_quota_buckets where endpoint = 'score';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values (
  'score',
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
  'global',
  4999
);
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null, 120, 'book', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    jsonb_build_object(
      'submissionId',
      '96000000-0000-4000-8000-000000000105',
      'submissionFingerprint',
      pg_catalog.repeat('5', 64)
    ),
    0, 'quota-test', pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'false',
  'score global N-1 admits the exact final slot'
);
select ok(
  (select request_count = 5000
     from public.public_write_quota_buckets
    where endpoint = 'score' and actor_key = 'global')
  and
  (select pg_catalog.count(*) = 3
     from public.public_write_quota_buckets
    where endpoint = 'score'),
  'score final global slot allocates and increments exactly two actor rows'
);
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null, 120, 'book', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    jsonb_build_object(
      'submissionId',
      '96000000-0000-4000-8000-000000000105',
      'submissionFingerprint',
      pg_catalog.repeat('5', 64)
    ),
    0, 'quota-test', pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'true',
  'exact score replay remains recoverable at the global cap'
);
select is(
  (
    select pg_catalog.sum(request_count)::integer
      from public.public_write_quota_buckets
     where endpoint = 'score'
  ),
  5002,
  'global-cap exact score replay consumes no quota dimension'
);
select throws_ok(
  $sql$
    select public.submit_score_with_review(
      '96000000-0000-4000-8000-000000000002',
      null, 121, 'book', 1000, 1, 'normal', null,
      'pending',
      '[{"id":"QA_QUOTA","value":1,"threshold":0,"source":"submit"}]'::jsonb,
      '{"submissionId":"96000000-0000-4000-8000-000000000106","submissionFingerprint":"6666666666666666666666666666666666666666666666666666666666666666"}'::jsonb,
      1, 'quota-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  $sql$,
  'P0001',
  'score_write_global_request_quota',
  'new flagged score over the global cap is rejected before core work'
);
select ok(
  not exists (
    select 1 from public.scores
     where submission_origin_owner_id =
             '96000000-0000-4000-8000-000000000002'
       and submission_id =
             '96000000-0000-4000-8000-000000000106'
  )
  and
  not exists (
    select 1
      from public.public_write_quota_buckets
     where endpoint = 'score'
       and actor_key in (
         pg_temp.qa_digest(
           'score-network:' || pg_catalog.repeat('b', 64)
         ),
         pg_temp.qa_digest(
           'score-owner:96000000-0000-4000-8000-000000000002'
         )
       )
  ),
  'global rejection creates no score, flag, or rejected actor bucket'
);

delete from public.public_write_quota_buckets where endpoint = 'score';
delete from public.public_write_attempts where endpoint = 'score';
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null, -1, 'fist', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    '{"submissionId":"96000000-0000-4000-8000-000000000107","submissionFingerprint":"7777777777777777777777777777777777777777777777777777777777777777"}'::jsonb,
    0, 'quota-test',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )->>'writeAttemptError',
  'invalid_score_protocol',
  'core validation failure is returned through a durable failure envelope'
);
select ok(
  (select pg_catalog.sum(request_count)::integer = 3
     from public.public_write_quota_buckets
    where endpoint = 'score')
  and (select pg_catalog.count(*) = 1
              and pg_catalog.bool_and(state = 'failed')
              and pg_catalog.bool_and(error_code = 'invalid_score_protocol')
         from public.public_write_attempts
        where endpoint = 'score')
  and not exists (
    select 1 from public.scores
     where submission_origin_owner_id =
             '96000000-0000-4000-8000-000000000001'
       and submission_id =
             '96000000-0000-4000-8000-000000000107'
  ),
  'invalid score consumes all three dimensions and caches one failed attempt'
);
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null, -1, 'fist', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    '{"submissionId":"96000000-0000-4000-8000-000000000107","submissionFingerprint":"7777777777777777777777777777777777777777777777777777777777777777"}'::jsonb,
    0, 'quota-test',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )->>'writeAttemptError',
  'invalid_score_protocol',
  'exact retry replays the cached score failure without core work'
);
select ok(
  (select pg_catalog.sum(request_count)::integer = 3
     from public.public_write_quota_buckets
    where endpoint = 'score')
  and (select pg_catalog.count(*) = 1
         from public.public_write_attempts
        where endpoint = 'score'),
  'exact failed score retry consumes no additional quota or attempt row'
);
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000001',
    null, -1, 'fist', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    '{"submissionId":"96000000-0000-4000-8000-000000000107","submissionFingerprint":"8888888888888888888888888888888888888888888888888888888888888888"}'::jsonb,
    0, 'quota-test',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )->>'writeAttemptError',
  'submission_id_conflict',
  'changed fingerprint on a failed score operation is conflict, not a new attempt'
);

select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000010',
    130, 'fist', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    '{"submissionId":"96000000-0000-4000-8000-000000000108","submissionFingerprint":"9999999999999999999999999999999999999999999999999999999999999999"}'::jsonb,
    0, 'quota-test',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )->>'writeAttemptError',
  'doll_ownership_mismatch',
  'unauthorized score payload is quota-counted and cached'
);
select is(
  public.submit_score_with_review(
    '96000000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000010',
    130, 'fist', 1000, 1, 'normal', null,
    'registered', '[]'::jsonb,
    '{"submissionId":"96000000-0000-4000-8000-000000000108","submissionFingerprint":"9999999999999999999999999999999999999999999999999999999999999999"}'::jsonb,
    0, 'quota-test',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )->>'writeAttemptError',
  'doll_ownership_mismatch',
  'exact unauthorized score retry replays the same cached failure'
);
select ok(
  (select pg_catalog.sum(request_count)::integer = 6
     from public.public_write_quota_buckets
    where endpoint = 'score')
  and (select pg_catalog.count(*) = 2
              and pg_catalog.bool_and(state = 'failed')
         from public.public_write_attempts
        where endpoint = 'score')
  and not exists (
    select 1 from public.scores
     where submission_origin_owner_id =
             '96000000-0000-4000-8000-000000000002'
       and submission_id =
             '96000000-0000-4000-8000-000000000108'
  ),
  'unauthorized score retry invokes no duplicate core work or quota increment'
);

-- Report network dimension.
delete from public.public_write_quota_buckets where endpoint = 'report';
delete from public.public_write_attempts where endpoint = 'report';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values
  (
    'report',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    'global',
    0
  ),
  (
    'report',
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
    pg_temp.qa_digest(
      'report-network:' || pg_catalog.repeat('a', 64)
    ),
    19
  );
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000201',
    '96000000-0000-4000-8000-000000000010',
    'portrait', 'network boundary', null, null, true,
    pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'false',
  'report network N-1 admits the exact final slot'
);
select ok(
  (select request_count = 1
     from public.public_write_quota_buckets
    where endpoint = 'report' and actor_key = 'global')
  and
  (select request_count = 20
     from public.public_write_quota_buckets
    where endpoint = 'report'
      and actor_key = pg_temp.qa_digest(
        'report-network:' || pg_catalog.repeat('a', 64)
      )),
  'report final network slot increments both dimensions once'
);
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000201',
    '96000000-0000-4000-8000-000000000010',
    'portrait', 'network boundary', null, null, false,
    pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'true',
  'exact report replay bypasses memory and durable network limits'
);
select is(
  (
    select pg_catalog.sum(request_count)::integer
      from public.public_write_quota_buckets
     where endpoint = 'report'
  ),
  21,
  'exact report replay consumes no quota dimension'
);
select throws_ok(
  $sql$
    select public.submit_content_report(
      '96000000-0000-4000-8000-000000000202',
      '96000000-0000-4000-8000-000000000010',
      'portrait', 'network rejected', null, null, true,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $sql$,
  'P0001',
  'rate_limited',
  'new report over the network cap is rejected'
);
select ok(
  not exists (
    select 1 from public.content_report_submission_receipts
     where submission_id =
             '96000000-0000-4000-8000-000000000202'
  )
  and
  (select pg_catalog.sum(request_count)::integer = 21
     from public.public_write_quota_buckets
    where endpoint = 'report'),
  'network rejection creates no report receipt and changes no counter'
);

-- Report global dimension.
delete from public.public_write_quota_buckets where endpoint = 'report';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values (
  'report',
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
  'global',
  499
);
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000203',
    '96000000-0000-4000-8000-000000000010',
    'hate', 'global boundary', null, null, true,
    pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'false',
  'report global N-1 admits the exact final slot'
);
select ok(
  (select request_count = 500
     from public.public_write_quota_buckets
    where endpoint = 'report' and actor_key = 'global')
  and
  (select pg_catalog.count(*) = 2
     from public.public_write_quota_buckets
    where endpoint = 'report'),
  'report final global slot allocates exactly one network row'
);
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000203',
    '96000000-0000-4000-8000-000000000010',
    'hate', 'global boundary', null, null, false,
    pg_catalog.repeat('a', 64)
  )->>'duplicate',
  'true',
  'exact report replay remains recoverable at the global cap'
);
select throws_ok(
  $sql$
    select public.submit_content_report(
      '96000000-0000-4000-8000-000000000204',
      '96000000-0000-4000-8000-000000000010',
      'hate', 'global rejected', null, null, true,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  $sql$,
  'P0001',
  'rate_limited',
  'new report over the global cap is rejected'
);
select ok(
  not exists (
    select 1 from public.content_report_submission_receipts
     where submission_id =
             '96000000-0000-4000-8000-000000000204'
  )
  and not exists (
    select 1
      from public.public_write_quota_buckets
     where endpoint = 'report'
       and actor_key = pg_temp.qa_digest(
         'report-network:' || pg_catalog.repeat('b', 64)
       )
  )
  and
  (select request_count = 500
     from public.public_write_quota_buckets
    where endpoint = 'report' and actor_key = 'global'),
  'global report rejection creates no receipt or rejected network bucket'
);

-- Missing targets are syntactically valid attempts. They must remain counted
-- and exact-replayable instead of exercising the target lookup indefinitely.
delete from public.public_write_quota_buckets where endpoint = 'report';
delete from public.public_write_attempts where endpoint = 'report';
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000207',
    '96000000-0000-4000-8000-000000000099',
    'other', 'missing target', null, null, true,
    pg_catalog.repeat('c', 64)
  )->>'writeAttemptError',
  'target_not_found',
  'missing report target is returned through a durable failure envelope'
);
select ok(
  (select pg_catalog.sum(request_count)::integer = 2
     from public.public_write_quota_buckets
    where endpoint = 'report')
  and (select pg_catalog.count(*) = 1
              and pg_catalog.bool_and(state = 'failed')
              and pg_catalog.bool_and(error_code = 'target_not_found')
         from public.public_write_attempts
        where endpoint = 'report')
  and not exists (
    select 1 from public.content_report_submission_receipts
     where submission_id =
             '96000000-0000-4000-8000-000000000207'
  ),
  'missing report target consumes both dimensions and caches one failed attempt'
);
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000207',
    '96000000-0000-4000-8000-000000000099',
    'other', 'missing target', null, null, true,
    pg_catalog.repeat('c', 64)
  )->>'writeAttemptError',
  'target_not_found',
  'exact missing-target retry replays the cached report failure'
);
select ok(
  (select pg_catalog.sum(request_count)::integer = 2
     from public.public_write_quota_buckets
    where endpoint = 'report')
  and (select pg_catalog.count(*) = 1
         from public.public_write_attempts
        where endpoint = 'report'),
  'exact failed report retry consumes no additional quota or attempt row'
);
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000207',
    '96000000-0000-4000-8000-000000000099',
    'other', 'changed missing target detail', null, null, true,
    pg_catalog.repeat('c', 64)
  )->>'writeAttemptError',
  'submission_conflict',
  'changed payload on a failed report operation is conflict, not a new attempt'
);

-- Rolling-old seven-argument reports are global-only, not one shared 20/day
-- anonymous pseudo-network.
delete from public.public_write_quota_buckets where endpoint = 'report';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values (
  'report',
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
  'global',
  20
);
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000205',
    '96000000-0000-4000-8000-000000000010',
    'other', 'legacy global only', null, null, true
  )->>'duplicate',
  'false',
  '21st rolling-old anonymous report is not trapped in a shared network cap'
);
select ok(
  (select request_count = 21
     from public.public_write_quota_buckets
    where endpoint = 'report' and actor_key = 'global')
  and
  (select pg_catalog.count(*) = 1
     from public.public_write_quota_buckets
    where endpoint = 'report'),
  'rolling-old report consumes only the global dimension'
);
update public.public_write_quota_buckets
   set request_count = 500
 where endpoint = 'report' and actor_key = 'global';
select is(
  public.submit_content_report(
    '96000000-0000-4000-8000-000000000205',
    '96000000-0000-4000-8000-000000000010',
    'other', 'legacy global only', null, null, false
  )->>'duplicate',
  'true',
  'rolling-old exact replay remains quota-free at global cap'
);
select throws_ok(
  $sql$
    select public.submit_content_report(
      '96000000-0000-4000-8000-000000000206',
      '96000000-0000-4000-8000-000000000010',
      'other', 'legacy rejected', null, null, true
    )
  $sql$,
  'P0001',
  'rate_limited',
  'rolling-old new report is still bounded by the global cap'
);
select ok(
  not exists (
    select 1 from public.content_report_submission_receipts
     where submission_id =
             '96000000-0000-4000-8000-000000000206'
  )
  and
  (select request_count = 500
     from public.public_write_quota_buckets
    where endpoint = 'report' and actor_key = 'global'),
  'rolling-old global rejection creates no receipt and never overflows'
);

select * from finish();
rollback;
