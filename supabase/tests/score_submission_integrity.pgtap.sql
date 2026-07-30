-- 0074 score/telemetry integrity contracts.
-- Run only on a disposable database with migrations through 0074 applied.

begin;
select plan(86);

select has_column(
  'public',
  'telemetry_sessions',
  'submitter_binding',
  'telemetry session has a submitter binding'
);
select has_column(
  'public',
  'scores',
  'submission_id',
  'score has a telemetry-independent idempotency key'
);
select has_column(
  'public',
  'scores',
  'submission_fingerprint',
  'score persists its immutable canonical report-input fingerprint'
);
select has_column(
  'public',
  'scores',
  'submission_origin_owner_id',
  'score keeps the owner namespace that originally minted its submission key'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.scores'::regclass
       and conname = 'scores_submission_identity_complete'
       and convalidated
  ),
  'submission key, fingerprint, and immutable origin are all-or-none'
);
select has_function(
  'public',
  'commit_score_report',
  array['uuid','uuid','jsonb','text','text[]','integer','text[]'],
  'atomic score report RPC exists'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])'::regprocedure
    ),
    $needle$pg_catalog.hashtext('member:' || p_owner_id::text)::bigint$needle$
  ) > 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])'::regprocedure
    ),
    $needle$pg_catalog.hashtext('member:' || p_owner_id::text)::bigint$needle$
  ) < pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])'::regprocedure
    ),
    'from public.profiles p'
  ),
  'score report takes the canonical user lock before its profile snapshot'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      coalesce(
        pg_catalog.to_regprocedure(
          'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'
        ),
        pg_catalog.to_regprocedure(
          'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)'
        )
      )
    ),
    $needle$pg_catalog.hashtext('member:' || p_owner_id::text)::bigint$needle$
  ) > 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      coalesce(
        pg_catalog.to_regprocedure(
          'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'
        ),
        pg_catalog.to_regprocedure(
          'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)'
        )
      )
    ),
    $needle$pg_catalog.hashtext('member:' || p_owner_id::text)::bigint$needle$
  ) < pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      coalesce(
        pg_catalog.to_regprocedure(
          'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'
        ),
        pg_catalog.to_regprocedure(
          'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)'
        )
      )
    ),
    'from public.profiles p'
  ),
  'telemetry core takes the canonical user lock before its profile snapshot'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.score_stats'::regclass
       and tgname = 'trg_score_stats_reject_deleted_owner_insert'
       and not tgisinternal
       and tgenabled <> 'D'
  ),
  'score_stats deleted-owner insert trigger is enabled'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.user_badges'::regclass
       and tgname = 'trg_user_badges_reject_deleted_owner_insert'
       and not tgisinternal
       and tgenabled <> 'D'
  ),
  'user_badges deleted-owner insert trigger is enabled'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.telemetry_sessions'::regclass
       and tgname = 'trg_telemetry_reject_deleted_owner_insert'
       and not tgisinternal
       and tgenabled <> 'D'
  ),
  'telemetry deleted-owner insert trigger is enabled'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.telemetry_sessions'::regclass
       and tgname = 'trg_telemetry_reject_deleted_owner_ingest_update'
       and not tgisinternal
       and tgenabled <> 'D'
  ),
  'telemetry deleted-owner ingest-update trigger is enabled'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_reject_deleted_score_report_insert()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.bp_reject_deleted_telemetry_write()',
    'EXECUTE'
  ),
  'deleted-owner trigger helpers are not callable through Data API'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.scores'::regclass
       and conname = 'scores_telemetry_session_fk'
       and not convalidated
  ),
  'new score links are FK-enforced without rejecting historical orphans'
);
select is(
  public.bp_telemetry_submitter_binding(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid
  ),
  'bad7313391508e4129c338752b2cc8094d16dff2c1ff59d93aa4402ce632bfc9',
  'SQL binding matches the TypeScript golden vector'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
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
  ),
  'service role can submit only through the network-bounded score RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])',
    'EXECUTE'
  ),
  'client roles cannot invoke write RPCs'
);
select ok(
  not has_table_privilege('anon', 'public.scores', 'SELECT')
  and not has_table_privilege('authenticated', 'public.scores', 'SELECT')
  and has_table_privilege('service_role', 'public.scores', 'SELECT'),
  'raw scores are server-readable but unavailable through client Data API'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.scores',
    'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'
  )
  and not has_table_privilege(
    'authenticated',
    'public.scores',
    'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'
  )
  and not has_table_privilege(
    'service_role',
    'public.scores',
    'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'
  ),
  'scores is SELECT-only for every PostgREST role'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_leaderboard(text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_score_percentile(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_leaderboard(text,integer)',
    'EXECUTE'
  ),
  'ranking projections are callable only by server routes'
);
select ok(
  not exists (
    select 1
      from pg_catalog.pg_policy
     where polrelid = 'public.scores'::regclass
       and polcmd in ('a', '*')
  ),
  'legacy scores INSERT policy is absent'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.score_stats',
    'INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.user_badges',
    'INSERT,UPDATE,DELETE'
  ),
  'report tables cannot bypass the atomic report RPC'
);

create temporary table score_integrity_ctx (
  member_a uuid not null default gen_random_uuid(),
  member_b uuid not null default gen_random_uuid(),
  anon_a uuid not null default gen_random_uuid(),
  admin_id uuid not null default gen_random_uuid(),
  doll_a uuid not null default gen_random_uuid(),
  doll_b uuid not null default gen_random_uuid(),
  member_session uuid not null default gen_random_uuid(),
  member_b_session uuid not null default gen_random_uuid(),
  anon_session uuid not null default gen_random_uuid(),
  missing_session uuid not null default gen_random_uuid(),
  unbound_session uuid not null default gen_random_uuid(),
  member_submission uuid not null default gen_random_uuid(),
  anon_submission uuid not null default gen_random_uuid(),
  banned_submission uuid not null default gen_random_uuid(),
  no_tel_submission uuid not null default gen_random_uuid(),
  late_link_session uuid not null default gen_random_uuid(),
  late_link_submission uuid not null default gen_random_uuid(),
  migrate_source uuid not null default gen_random_uuid(),
  migrate_target_a uuid not null default gen_random_uuid(),
  migrate_target_b uuid not null default gen_random_uuid(),
  migrate_session uuid not null default gen_random_uuid(),
  migrate_legacy_session uuid not null default gen_random_uuid(),
  migrate_submission uuid not null default gen_random_uuid(),
  stale_source_session uuid not null default gen_random_uuid(),
  stale_source_submission uuid not null default gen_random_uuid(),
  member_evidence jsonb,
  anon_evidence jsonb,
  banned_evidence jsonb,
  no_tel_evidence jsonb,
  late_link_evidence jsonb,
  migrate_evidence jsonb,
  stale_source_evidence jsonb,
  member_ack jsonb,
  anon_ack jsonb,
  score_result jsonb,
  anon_score_result jsonb,
  no_tel_result jsonb,
  late_link_result jsonb,
  report_result jsonb,
  migrate_score_result jsonb,
  target_collision_result jsonb,
  migrate_result jsonb
) on commit drop;

insert into score_integrity_ctx default values;
update score_integrity_ctx
   set member_evidence = pg_catalog.jsonb_build_object(
         'submissionId', member_submission,
         'submissionFingerprint', pg_catalog.repeat('a', 64)
       ),
       anon_evidence = pg_catalog.jsonb_build_object(
         'submissionId', anon_submission,
         'submissionFingerprint', pg_catalog.repeat('b', 64)
       ),
       banned_evidence = pg_catalog.jsonb_build_object(
         'submissionId', banned_submission,
         'submissionFingerprint', pg_catalog.repeat('c', 64)
       ),
       no_tel_evidence = pg_catalog.jsonb_build_object(
         'submissionId', no_tel_submission,
         'submissionFingerprint', pg_catalog.repeat('d', 64)
       ),
       late_link_evidence = pg_catalog.jsonb_build_object(
         'submissionId', late_link_submission,
         'submissionFingerprint', pg_catalog.repeat('1', 64)
       ),
       migrate_evidence = pg_catalog.jsonb_build_object(
         'submissionId', migrate_submission,
         'submissionFingerprint', pg_catalog.repeat('e', 64)
       ),
       stale_source_evidence = pg_catalog.jsonb_build_object(
         'submissionId', stale_source_submission,
         'submissionFingerprint', pg_catalog.repeat('2', 64)
       );

insert into auth.users(id, email)
select member_a, 'score-member-a-' || member_a || '@test.local'
  from score_integrity_ctx
union all
select member_b, 'score-member-b-' || member_b || '@test.local'
  from score_integrity_ctx
union all
select anon_a, 'score-anon-' || anon_a || '@test.local'
  from score_integrity_ctx
union all
select admin_id, 'score-admin-' || admin_id || '@test.local'
  from score_integrity_ctx
union all
select migrate_source, 'score-migrate-source-' || migrate_source || '@test.local'
  from score_integrity_ctx
union all
select migrate_target_a, 'score-migrate-target-a-' || migrate_target_a || '@test.local'
  from score_integrity_ctx
union all
select migrate_target_b, 'score-migrate-target-b-' || migrate_target_b || '@test.local'
  from score_integrity_ctx;

insert into public.member_accounts(user_id, is_admin)
select member_a, false from score_integrity_ctx
union all
select member_b, false from score_integrity_ctx
union all
select admin_id, true from score_integrity_ctx;
insert into public.member_accounts(user_id, is_admin)
select migrate_target_a, false from score_integrity_ctx
union all
select migrate_target_b, false from score_integrity_ctx;

insert into public.dolls(id, owner_id, image_url)
select doll_a, member_a, member_a::text || '/doll-a.png'
  from score_integrity_ctx
union all
select doll_b, member_b, member_b::text || '/doll-b.png'
  from score_integrity_ctx;

update public.telemetry_budget
   set degrade_mode = 'full',
       over_budget = false,
       new_sessions_today = 0,
       day_kst = (now() at time zone 'Asia/Seoul')::date
 where id = true;

update score_integrity_ctx c
   set member_ack = public.ingest_telemetry_delta(
         c.member_session,
         c.member_a,
         true,
         jsonb_build_object(
           'deviceClass', 'desktop-pointer',
           'summary', jsonb_build_object(
             'seqHigh', 1,
             'durationMs', 1000,
             'totals', jsonb_build_object(
               'score', 100,
               'hitCount', 1,
               'maxCombo', 1
             )
           ),
           'events', '[]'::jsonb
         )
       ),
       anon_ack = public.ingest_telemetry_delta(
         c.anon_session,
         c.anon_a,
         false,
         jsonb_build_object(
           'deviceClass', 'desktop-pointer',
           'summary', jsonb_build_object(
             'seqHigh', 1,
             'durationMs', 1000,
             'totals', jsonb_build_object(
               'score', 90,
               'hitCount', 1,
               'maxCombo', 1
             )
           ),
           'events', '[]'::jsonb
         )
       );

select is(
  (
    select public.ingest_telemetry_delta(
      c.late_link_session,
      c.member_a,
      true,
      jsonb_build_object(
        'deviceClass', 'desktop-pointer',
        'summary', jsonb_build_object(
          'seqHigh', 1,
          'durationMs', 1000,
          'totals', jsonb_build_object(
            'score', 61,
            'hitCount', 1,
            'maxCombo', 1
          )
        ),
        'events', '[]'::jsonb
      )
    )->>'ok'
      from score_integrity_ctx c
  ),
  'true',
  'late-link telemetry fixture ingests successfully'
);

select is(
  (select member_ack->>'ok' from score_integrity_ctx),
  'true',
  'member telemetry ingest succeeds'
);
select ok(
  exists (
    select 1
      from public.telemetry_sessions t
      join score_integrity_ctx c on c.member_session = t.id
     where t.owner_id = c.member_a
       and t.is_anon = false
       and t.submitter_binding =
           public.bp_telemetry_submitter_binding(t.id, c.member_a)
  ),
  'member telemetry stores exact owner and binding'
);
select is(
  (select anon_ack->>'ok' from score_integrity_ctx),
  'true',
  'authenticated anonymous telemetry ingest succeeds'
);
select ok(
  exists (
    select 1
      from public.telemetry_sessions t
      join score_integrity_ctx c on c.anon_session = t.id
     where t.owner_id is null
       and t.is_anon = true
       and t.submitter_binding =
           public.bp_telemetry_submitter_binding(t.id, c.anon_a)
  ),
  'anonymous telemetry stores only a session binding'
);
select ok(
  not exists (
    select 1
      from public.telemetry_sessions t
      join score_integrity_ctx c on c.anon_session = t.id
     where pg_catalog.strpos(
       pg_catalog.row_to_json(t)::text,
       c.anon_a::text
     ) > 0
  ),
  'raw anonymous Auth subject is not stored in the telemetry row'
);
select is(
  (
    select public.ingest_telemetry_delta(
      c.member_session,
      c.member_a,
      false,
      '{"summary":{"seqHigh":2},"events":[]}'::jsonb
    )->>'reason'
      from score_integrity_ctx c
  ),
  'member_mismatch',
  'caller cannot downgrade an existing member to anonymous'
);
select is(
  (
    select public.ingest_telemetry_delta(
      c.member_session,
      c.member_b,
      true,
      '{"summary":{"seqHigh":2},"events":[]}'::jsonb
    )->>'reason'
      from score_integrity_ctx c
  ),
  'owner_mismatch',
  'another member cannot claim a known telemetry UUID'
);

insert into public.telemetry_sessions(
  id,
  owner_id,
  is_anon,
  device_class,
  submitter_binding
)
select unbound_session, null, true, 'other', null
  from score_integrity_ctx;

select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,60,%L,1000,1,%L,%L::uuid,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    'fist',
    'normal',
    unbound_session,
    'registered',
    '[]',
    no_tel_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'telemetry_session_owner_mismatch',
  'historical unbound telemetry cannot be claimed by UUID knowledge'
) from score_integrity_ctx;

select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,100,%L,1000,1,%L,%L::uuid,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    'fist',
    'normal',
    missing_session,
    'registered',
    '[]',
    member_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'telemetry_session_owner_mismatch',
  'missing telemetry UUID is rejected in the insert transaction'
) from score_integrity_ctx;

select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,100,%L,1000,1,%L,%L::uuid,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_b,
    'fist',
    'normal',
    member_session,
    'registered',
    '[]',
    member_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'telemetry_session_owner_mismatch',
  'cross-owner telemetry UUID is rejected in the insert transaction'
) from score_integrity_ctx;

select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,%L::uuid,100,%L,1000,1,%L,null,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    doll_b,
    'fist',
    'normal',
    'registered',
    '[]',
    member_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'doll_ownership_mismatch',
  'cross-owner doll is rejected in the insert transaction'
) from score_integrity_ctx;

select throws_ok(
  format(
    'insert into public.scores(owner_id,score,weapon,duration_ms,telemetry_session_id) values(%L::uuid,1,%L,1000,%L::uuid)',
    member_a,
    'fist',
    missing_session
  ),
  '23503',
  null,
  'new direct fixture inserts still obey the telemetry FK'
) from score_integrity_ctx;

select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,100,%L,1000,1,%L,null,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    'unknown',
    'normal',
    'registered',
    '[]',
    member_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'invalid_score_protocol',
  'DB rejects an unknown weapon even through the service RPC'
) from score_integrity_ctx;

select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,100,%L,1000,1,%L,null,%L,%L::jsonb,%L::jsonb,1,%L)',
    member_a,
    'fist',
    'normal',
    'registered',
    '[{"id":"forged"}]',
    member_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'review_payload_mismatch',
  'registered review cannot carry contradictory flags'
) from score_integrity_ctx;

-- The route fingerprints normalized requested UUIDs, while accepted links can
-- legitimately change from null to valid between response-loss retries.
update score_integrity_ctx c
   set late_link_result = public.submit_score_with_review(
     c.member_a,
     null,
     61,
     'fist',
     1000,
     1,
     'normal',
     null,
     'registered',
     '[]'::jsonb,
     c.late_link_evidence,
     0,
     '2026-07-anti-abuse-v6'
   );
select is(
  (
    select public.submit_score_with_review(
      c.member_a,
      c.doll_a,
      61,
      'fist',
      1000,
      1,
      'normal',
      c.late_link_session,
      'registered',
      '[]'::jsonb,
      c.late_link_evidence,
      0,
      '2026-07-anti-abuse-v6'
    )->>'scoreId'
      from score_integrity_ctx c
  ),
  (select late_link_result->>'scoreId' from score_integrity_ctx),
  'late-visible accepted links converge on the original score'
);
select ok(
  exists (
    select 1
      from public.scores s
      join score_integrity_ctx c
        on s.id = (c.late_link_result->>'scoreId')::uuid
     where s.doll_id is null
       and s.telemetry_session_id is null
  ),
  'response-loss retry preserves the first committed accepted links'
);

update score_integrity_ctx c
   set score_result = public.submit_score_with_review(
     c.member_a,
     c.doll_a,
     100,
     'fist',
     1000,
     1,
     'normal',
     c.member_session,
     'registered',
     '[]'::jsonb,
     c.member_evidence,
     0,
     '2026-07-anti-abuse-v6'
   ),
   anon_score_result = public.submit_score_with_review(
     c.anon_a,
     null,
     90,
     'fist',
     1000,
     1,
     'normal',
     c.anon_session,
     'registered',
     '[]'::jsonb,
     c.anon_evidence,
     0,
     '2026-07-anti-abuse-v6'
   );

select is(
  (select score_result->>'reviewStatus' from score_integrity_ctx),
  'registered',
  'valid member score is registered'
);
select is(
  (select anon_score_result->>'reviewStatus' from score_integrity_ctx),
  'registered',
  'valid anonymous score is registered'
);
select ok(
  exists (
    select 1
      from public.scores s
      join score_integrity_ctx c
        on s.id = (c.score_result->>'scoreId')::uuid
     where s.owner_id = c.member_a
       and s.doll_id = c.doll_a
       and s.telemetry_session_id = c.member_session
  ),
  'valid score preserves exact owner/doll/telemetry links'
);
select is(
  (
    select s.submission_fingerprint
      from public.scores s
      join score_integrity_ctx c
        on s.id = (c.score_result->>'scoreId')::uuid
  ),
  pg_catalog.repeat('a', 64),
  'score persists the server canonical submission fingerprint'
);
select is(
  (
    select public.submit_score_with_review(
      c.member_a,
      c.doll_a,
      100,
      'fist',
      1000,
      1,
      'normal',
      c.member_session,
      'registered',
      '[]'::jsonb,
      c.member_evidence,
      0,
      '2026-07-anti-abuse-v6'
    )->>'duplicate'
      from score_integrity_ctx c
  ),
  'true',
  'exact telemetry retry is idempotent'
);
select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,%L::uuid,100,%L,1000,1,%L,%L::uuid,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    doll_a,
    'fist',
    'normal',
    member_session,
    'registered',
    '[]',
    pg_catalog.jsonb_build_object(
      'submissionId', member_submission,
      'submissionFingerprint', pg_catalog.repeat('0', 64)
    ),
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'submission_id_conflict',
  'same submission key cannot replace canonical gameplay stats/fingerprint'
) from score_integrity_ctx;
select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,%L::uuid,101,%L,1000,1,%L,%L::uuid,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    doll_a,
    'fist',
    'normal',
    member_session,
    'registered',
    '[]',
    pg_catalog.jsonb_build_object(
      'submissionId', pg_catalog.gen_random_uuid(),
      'submissionFingerprint', pg_catalog.repeat('f', 64)
    ),
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'telemetry_session_conflict',
  'same telemetry UUID with a changed request is a conflict'
) from score_integrity_ctx;

update score_integrity_ctx c
   set no_tel_result = public.submit_score_with_review(
     c.member_a,
     null,
     60,
     'fist',
     1000,
     1,
     'normal',
     null,
     'registered',
     '[]'::jsonb,
     c.no_tel_evidence,
     0,
     '2026-07-anti-abuse-v6'
   );
select is(
  (
    select public.submit_score_with_review(
      c.member_a,
      null,
      60,
      'fist',
      1000,
      1,
      'normal',
      null,
      'registered',
      '[]'::jsonb,
      c.no_tel_evidence,
      0,
      '2026-07-anti-abuse-v6'
    )->>'scoreId'
      from score_integrity_ctx c
  ),
  (select no_tel_result->>'scoreId' from score_integrity_ctx),
  'null/unbound telemetry downgrade retries converge on the same score'
);
select is(
  (
    select count(*)::int
      from public.scores s
      join score_integrity_ctx c
        on s.owner_id = c.member_a
       and s.submission_id = c.no_tel_submission
  ),
  1,
  'null telemetry response-loss retry inserts exactly one row'
);
select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,60,%L,1000,1,%L,null,%L,%L::jsonb,%L::jsonb,0,%L)',
    member_a,
    'fist',
    'normal',
    'registered',
    '[]',
    pg_catalog.jsonb_build_object(
      'submissionId', no_tel_submission,
      'submissionFingerprint', pg_catalog.repeat('1', 64)
    ),
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'submission_id_conflict',
  'null telemetry retry cannot replace its report inputs'
) from score_integrity_ctx;

update score_integrity_ctx c
   set report_result = public.commit_score_report(
     (c.score_result->>'scoreId')::uuid,
     c.member_a,
     '{"version":2,"hitCount":1,"maxCombo":1,"durationMs":1000,"weaponCounts":{"fist":1},"weaponScores":{"fist":100},"ultScore":0,"ultimateCount":0,"firstHitMs":10,"bgVisits":["office"],"intervalCV":null}'::jsonb,
     'steady',
     array['score_1','hits_1'],
     50,
     array['score_1','hits_1','combo_1']
   );

select is(
  (select report_result->>'personaId' from score_integrity_ctx),
  'steady',
  'atomic score report returns the persisted persona'
);
select is(
  (select (report_result->>'collectedCount')::int from score_integrity_ctx),
  2,
  'atomic score report counts known collected badges'
);
select is(
  (
    select count(*)::int
      from public.score_stats st
      join score_integrity_ctx c
        on st.score_id = (c.score_result->>'scoreId')::uuid
  ),
  1,
  'score report inserts exactly one stats row'
);
select is(
  (
    select count(*)::int
      from public.user_badges ub
      join score_integrity_ctx c on ub.owner_id = c.member_a
  ),
  2,
  'score report grants all earned badges atomically'
);
select is(
  (
    select public.commit_score_report(
      (c.score_result->>'scoreId')::uuid,
      c.member_a,
      '{"version":2}'::jsonb,
      'changed-on-retry',
      array['score_1','hits_1','combo_1'],
      1,
      array['score_1','hits_1','combo_1']
    )->>'personaId'
      from score_integrity_ctx c
  ),
  'steady',
  'report retry preserves the first immutable snapshot'
);
select is(
  (
    select public.commit_score_report(
      (c.score_result->>'scoreId')::uuid,
      c.member_a,
      '{"version":2}'::jsonb,
      'changed-on-retry',
      array['score_1','hits_1','combo_1'],
      1,
      array['score_1','hits_1','combo_1']
    )->'newBadges'
      from score_integrity_ctx c
  ),
  '["hits_1", "score_1"]'::jsonb,
  'response-loss retry restores badges first earned by this score'
);
select is(
  (
    select count(*)::int
      from public.user_badges ub
      join score_integrity_ctx c on ub.owner_id = c.member_a
  ),
  2,
  'changed retry cannot grant a badge absent from the first snapshot'
);
select is(
  (
    select count(*)::int
      from public.score_stats st
      join score_integrity_ctx c
        on st.score_id = (c.score_result->>'scoreId')::uuid
  ),
  1,
  'report retry does not duplicate stats'
);

update score_integrity_ctx c
   set member_ack = public.ingest_telemetry_delta(
     c.migrate_session,
     c.migrate_source,
     false,
     '{"deviceClass":"other","summary":{"seqHigh":1,"durationMs":1000,"totals":{"score":50,"hitCount":1,"maxCombo":1}},"events":[]}'::jsonb
   );
insert into public.telemetry_sessions(
  id,
  owner_id,
  is_anon,
  device_class,
  submitter_binding
)
select migrate_legacy_session,
       migrate_source,
       false,
       'other',
       public.bp_telemetry_submitter_binding(
         migrate_legacy_session,
         migrate_source
       )
  from score_integrity_ctx;
update score_integrity_ctx c
   set target_collision_result = public.submit_score_with_review(
     c.migrate_target_a,
     null,
     50,
     'fist',
     1000,
     1,
     'normal',
     null,
     'registered',
     '[]'::jsonb,
     c.migrate_evidence,
     0,
     '2026-07-anti-abuse-v6'
   );
select is(
  (select target_collision_result->>'reviewStatus' from score_integrity_ctx),
  'registered',
  'target submission-key collision fixture is registered'
);
update score_integrity_ctx c
   set migrate_score_result = public.submit_score_with_review(
     c.migrate_source,
     null,
     50,
     'fist',
     1000,
     1,
     'normal',
     c.migrate_session,
     'registered',
     '[]'::jsonb,
     c.migrate_evidence,
     0,
     '2026-07-anti-abuse-v6'
   );
update score_integrity_ctx c
   set migrate_result = public.reassign_anon_data(
     c.migrate_source,
     c.migrate_target_a
   );

select ok(
  (
    select (migrate_result->>'scores')::int = 1
       and (migrate_result->>'telemetry')::int = 2
      from score_integrity_ctx
  ),
  'anon reassignment moves both the score and bound/legacy telemetry rows'
);
select ok(
  not exists (
    select 1
      from score_integrity_ctx c
      join public.telemetry_sessions t
        on t.id in (c.migrate_session, c.migrate_legacy_session)
     where t.owner_id is distinct from c.migrate_target_a
        or t.is_anon is distinct from false
        or t.submitter_binding is distinct from
           public.bp_telemetry_submitter_binding(t.id, c.migrate_target_a)
  )
  and exists (
    select 1
      from score_integrity_ctx c
      join public.scores s
        on s.id = (c.migrate_score_result->>'scoreId')::uuid
     where s.owner_id = c.migrate_target_a
  ),
  'reassignment rotates every telemetry binding and preserves score ownership'
);
select ok(
  (
    select count(*) = 2
      from public.scores s
      join score_integrity_ctx c on s.owner_id = c.migrate_target_a
     where s.id in (
       (c.migrate_score_result->>'scoreId')::uuid,
       (c.target_collision_result->>'scoreId')::uuid
     )
  )
  and exists (
    select 1
      from public.scores s
      join score_integrity_ctx c
        on s.id = (c.migrate_score_result->>'scoreId')::uuid
     where s.submission_id = c.migrate_submission
       and s.submission_origin_owner_id = c.migrate_source
  )
  and exists (
    select 1
      from public.scores s
      join score_integrity_ctx c
        on s.id = (c.target_collision_result->>'scoreId')::uuid
     where s.submission_id = c.migrate_submission
       and s.submission_origin_owner_id = c.migrate_target_a
  ),
  'cross-owner submission UUID collision preserves both origin namespaces during merge'
);
select is(
  (
    select public.submit_score_with_review(
      c.migrate_target_a,
      null,
      50,
      'fist',
      1000,
      1,
      'normal',
      c.migrate_session,
      'registered',
      '[]'::jsonb,
      c.migrate_evidence || pg_catalog.jsonb_build_object(
        'migratedSourceOwnerId',
        c.migrate_source
      ),
      0,
      '2026-07-anti-abuse-v6'
    )->>'scoreId'
      from score_integrity_ctx c
  ),
  (select migrate_score_result->>'scoreId' from score_integrity_ctx),
  'receipt-authorized migrated replay converges on the already-moved score'
);
select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,50,%L,1000,1,%L,null,%L,%L::jsonb,%L::jsonb,0,%L)',
    migrate_target_b,
    'fist',
    'normal',
    'registered',
    '[]',
    migrate_evidence || pg_catalog.jsonb_build_object(
      'migratedSourceOwnerId',
      migrate_source
    ),
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'migrated_replay_not_authorized',
  'a foreign target cannot claim a migrated-source outbox replay'
) from score_integrity_ctx;
select ok(
  not exists (
    select 1
      from public.scores s
      join score_integrity_ctx c
        on s.owner_id = c.migrate_target_b
     where s.submission_id = c.migrate_submission
  ),
  'rejected migrated replay creates no target score'
);
select is(
  (
    select public.reassign_anon_data(
      c.migrate_source,
      c.migrate_target_a
    )
      from score_integrity_ctx c
  ),
  (select migrate_result from score_integrity_ctx),
  'same-target reassignment retry returns the durable first result'
);
select throws_ok(
  format(
    'select public.reassign_anon_data(%L::uuid,%L::uuid)',
    migrate_source,
    migrate_target_b
  ),
  'P0001',
  'anon_reassignment_conflict',
  'a second target cannot replay a consumed anonymous source'
) from score_integrity_ctx;
select ok(
  (
    select count(*) = 1
      from public.anon_data_reassignments r
      join score_integrity_ctx c
        on r.source_user_id = c.migrate_source
       and r.target_user_id = c.migrate_target_a
  )
  and has_function_privilege(
    'service_role',
    'public.reassign_anon_data(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.reassign_anon_data(uuid,uuid)',
    'EXECUTE'
  )
  and not has_table_privilege(
    'service_role',
    'public.anon_data_reassignments',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'reassignment winner receipt is durable and RPC-only'
);
select throws_ok(
  format(
    'select public.submit_score_with_review(%L::uuid,null,51,%L,1000,1,%L,null,%L,%L::jsonb,%L::jsonb,0,%L)',
    migrate_source,
    'fist',
    'normal',
    'registered',
    '[]',
    stale_source_evidence,
    '2026-07-anti-abuse-v6'
  ),
  'P0001',
  'account_migrated',
  'a migrated anonymous source cannot create a late score'
) from score_integrity_ctx;
select is(
  (
    select public.ingest_telemetry_delta(
      c.stale_source_session,
      c.migrate_source,
      false,
      '{"deviceClass":"other","summary":{"seqHigh":1},"events":[]}'::jsonb
    )->>'reason'
      from score_integrity_ctx c
  ),
  'account_migrated',
  'a migrated anonymous source cannot create late telemetry'
);

update public.member_accounts m
   set abuse_status = 'banned'
  from score_integrity_ctx c
 where m.user_id = c.member_b;
update score_integrity_ctx c
   set member_ack = public.ingest_telemetry_delta(
     c.member_b_session,
     c.member_b,
     true,
     '{"deviceClass":"other","summary":{"seqHigh":1,"durationMs":1000,"totals":{"score":80,"hitCount":1}},"events":[]}'::jsonb
   );

select is(
  (
    select public.submit_score_with_review(
      c.member_b,
      null,
      80,
      'fist',
      1000,
      1,
      'normal',
      c.member_b_session,
      'registered',
      '[]'::jsonb,
      c.banned_evidence,
      0,
      '2026-07-anti-abuse-v6'
    )->>'reviewStatus'
      from score_integrity_ctx c
  ),
  'voided',
  'DB-observed banned member is forced to voided'
);
select ok(
  exists (
    select 1
      from public.scores s
      join public.score_flags f on f.score_id = s.id
      join score_integrity_ctx c on s.owner_id = c.member_b
     where s.review_status = 'voided'
       and f.status = 'voided'
       and exists (
         select 1
           from jsonb_array_elements(f.signals) e
          where e->>'id' = 'BANNED_MEMBER'
       )
  ),
  'banned submit stores matching voided flag evidence'
);

select lives_ok(
  format(
    'select public.admin_ban_member(%L::uuid,%L::uuid,%L)',
    admin_id,
    member_a,
    'QA ban'
  ),
  'ban atomically voids an existing score and revokes badges'
) from score_integrity_ctx;
select is(
  (
    select count(*)::int
      from public.user_badges ub
      join score_integrity_ctx c on ub.owner_id = c.member_a
  ),
  0,
  'ban revokes member badges'
);
select ok(
  exists (
    select 1
      from public.scores s
      join public.score_flags f on f.score_id = s.id
      join score_integrity_ctx c
        on s.id = (c.score_result->>'scoreId')::uuid
     where s.review_status = 'voided'
       and f.status = 'voided'
  ),
  'ban keeps score and score_flags visibility state consistent'
);
select throws_ok(
  format(
    'select public.admin_clear_score(%L::uuid,%L::uuid,%L)',
    admin_id,
    (score_result->>'scoreId')::uuid,
    'must not clear banned'
  ),
  'P0001',
  'member_banned',
  'clear cannot expose a still-banned member score'
) from score_integrity_ctx;
select throws_ok(
  format(
    'select public.commit_score_report(%L::uuid,%L::uuid,%L::jsonb,%L,array[]::text[],50,array[]::text[])',
    (score_result->>'scoreId')::uuid,
    member_a,
    '{"version":2}',
    'steady'
  ),
  'P0001',
  'member_banned',
  'report cannot grant after the member is banned'
) from score_integrity_ctx;

select is(
  (
    select count(*)::int
      from public.get_leaderboard('daily', -1)
  ),
  0,
  'negative leaderboard limit is clamped to zero'
);
select ok(
  (
    select count(*) <= 100
      from public.get_leaderboard('daily', 2147483647)
  ),
  'leaderboard limit is capped at 100'
);
select ok(
  not exists (
    select 1
      from public.get_leaderboard('daily', 100) l
      join public.scores s on s.id = l.id
     where s.review_status in ('pending', 'voided')
  ),
  'leaderboard never returns hidden review states'
);

update public.telemetry_sessions t
   set suspicious = true,
       end_reason = 'normal',
       duration_ms = 1000,
       score = 90
  from score_integrity_ctx c
 where t.id = c.anon_session;

select is(
  (
    select (public.integrity_scan_recent(
      6,
      '2026-07-anti-abuse-v6'
    )->>'flagged')::int
  ),
  1,
  'first integrity scan transitions the suspicious registered score'
);
select is(
  (
    select (public.integrity_scan_recent(
      6,
      '2026-07-anti-abuse-v6'
    )->>'flagged')::int
  ),
  0,
  'second integrity scan in the same transaction is re-entrant and idempotent'
);
select is(
  (
    select count(*)::int
      from public.integrity_actions_ledger l
      join score_integrity_ctx c
        on l.target_id = (c.anon_score_result->>'scoreId')::uuid
     where l.action_type = 'cron_flag'
  ),
  1,
  'repeated scan writes one cron ledger action'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.integrity_scan_recent(integer,text)'::regprocedure
    ),
    'pg_temp._bp_iscan'
  ) > 0,
  'integrity scan temp relation is explicitly pg_temp-qualified'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)'::regprocedure
  )
  and (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])'::regprocedure
  ),
  'score write RPCs remain SECURITY DEFINER'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_telemetry_submitter_binding(uuid,uuid)',
    'EXECUTE'
  ),
  'binding primitive is not directly callable through Data API'
);
select ok(
  (
    select count(*) = 0
      from information_schema.role_column_grants g
     where g.table_schema = 'public'
       and g.table_name = 'scores'
       and g.grantee in ('PUBLIC','anon','authenticated','service_role')
       and g.privilege_type in ('INSERT','UPDATE','REFERENCES')
  ),
  'scores has no independent column DML grants'
);

select * from finish();
rollback;
