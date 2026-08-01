-- 008903: fixed-size account/moderation Storage cleanup sagas.
-- Exercises >10k targets, deterministic bounded claims, lease recovery,
-- stale-finish fencing, residual-object proof, token horizon and intent drain.

begin;
select plan(82);

select has_column(
  'public', 'account_deletion_cleanup_jobs', 'lease_version',
  'account cleanup has a monotonic lease version'
);
select has_column(
  'public', 'account_deletion_cleanup_jobs', 'lease_targets',
  'account cleanup has a per-lease target batch'
);
select has_column(
  'public', 'account_deletion_cleanup_jobs', 'removed_target_count',
  'account cleanup records confirmed target removals'
);
select has_column(
  'public', 'account_deletion_cleanup_jobs', 'lease_generation_ids',
  'account cleanup has a per-lease generation privacy batch'
);
select has_column(
  'public', 'ai_generations', 'privacy_scrubbed_at',
  'generation receipts expose a terminal privacy tombstone'
);
select has_column(
  'public', 'moderation_purge_jobs', 'final_sweep_after',
  'moderation purge has a signed-token final horizon'
);
select has_column(
  'public', 'moderation_purge_jobs', 'purged_target_count',
  'moderation purge records confirmed target removals'
);
select ok(
  (
    select pg_catalog.pg_get_constraintdef(c.oid) like
             '%jsonb_array_length(lease_targets) <= 100%'
      from pg_catalog.pg_constraint c
     where c.conrelid =
             'public.account_deletion_cleanup_jobs'::regclass
       and c.conname =
             'account_deletion_cleanup_lease_targets_check'
  ),
  'account lease payload is DB-bounded to 100'
);
select ok(
  (
    select pg_catalog.pg_get_constraintdef(c.oid) like
             '%jsonb_array_length(lease_generation_ids) <= 100%'
      from pg_catalog.pg_constraint c
     where c.conrelid =
             'public.account_deletion_cleanup_jobs'::regclass
       and c.conname =
             'account_deletion_cleanup_lease_generation_ids_check'
  ),
  'generation privacy lease payload is DB-bounded to 100'
);
select ok(
  (
    select pg_catalog.pg_get_constraintdef(c.oid) like
             '%jsonb_array_length(manifest) <= 100%'
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.moderation_purge_jobs'::regclass
       and c.conname = 'moderation_purge_bounded_manifest_check'
  ),
  'moderation lease payload is DB-bounded to 100'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)',
    'EXECUTE'
  ),
  'account v2 claim is server-only'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_moderation_purge_v2(uuid,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_moderation_purge_v2(uuid,integer,integer)',
    'EXECUTE'
  ),
  'moderation v2 claim is server-only'
);
select ok(
  pg_catalog.to_regprocedure(
    'public.claim_account_deletion_cleanup(uuid,integer)'
  ) is null
  or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure(
           'public.claim_account_deletion_cleanup(uuid,integer)'
         )
       ),
       'RETURN NULL'
     ) > 0,
  'legacy account worker is idle in expand and absent in contract'
);
select ok(
  pg_catalog.to_regprocedure(
    'public.claim_moderation_purge(uuid,integer)'
  ) is null
  or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure(
           'public.claim_moderation_purge(uuid,integer)'
         )
       ),
       'RETURN NULL'
     ) > 0,
  'legacy moderation worker is idle in expand and absent in contract'
);

create temporary table bounded_cleanup_ctx (
  account_user_id uuid not null,
  account_aba_user_id uuid not null,
  account_intent_id uuid not null,
  account_job_id uuid not null,
  account_financial_generation_id uuid not null,
  account_open_issue_id uuid not null,
  account_resolved_issue_id uuid not null,
  account_preflight_cost_before bigint not null,
  account_pick_cost_before bigint not null,
  account_start jsonb not null,
  account_lease_one jsonb,
  account_lease_two jsonb,
  account_batches integer not null default 0,
  admin_id uuid not null,
  owner_id uuid not null,
  doll_id uuid not null,
  moderation_intent_id uuid not null,
  moderation_job_id uuid not null,
  moderation_start jsonb not null,
  moderation_lease_one jsonb,
  moderation_lease_two jsonb,
  moderation_batches integer not null default 0
) on commit drop;

do $fixture$
declare
  v_account uuid := gen_random_uuid();
  v_account_aba uuid := gen_random_uuid();
  v_account_intent uuid := gen_random_uuid();
  v_account_lot uuid := gen_random_uuid();
  v_financial_generation uuid :=
    md5('bounded-account-generation-1')::uuid;
  v_open_issue uuid := gen_random_uuid();
  v_resolved_issue uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_doll uuid := gen_random_uuid();
  v_moderation_intent uuid := gen_random_uuid();
  v_first_score uuid := md5('bounded-purge-score-1')::uuid;
  v_account_start jsonb;
  v_moderation_start jsonb;
begin
  insert into storage.buckets(id, name)
  values ('dolls', 'dolls'), ('highlights', 'highlights')
  on conflict (id) do nothing;

  insert into auth.users(id, email, raw_user_meta_data)
  values (
    v_account,
    'bounded-account-' || v_account::text || '@test.local',
    '{"private":"erase-me"}'::jsonb
  ), (
    v_account_aba,
    'bounded-account-aba-' || v_account_aba::text || '@test.local',
    '{}'::jsonb
  ), (
    v_admin,
    'bounded-admin-' || v_admin::text || '@test.local',
    '{}'::jsonb
  ), (
    v_owner,
    'bounded-owner-' || v_owner::text || '@test.local',
    '{}'::jsonb
  );
  insert into public.member_accounts(user_id, is_admin)
  values
    (v_account, false),
    (v_account_aba, false),
    (v_admin, true),
    (v_owner, false)
  on conflict (user_id) do update
    set is_admin = excluded.is_admin;

  -- Represents a completed cleanup followed by a successful reactivation.
  -- There is deliberately no active lease or Auth cleanup fence.
  insert into public.account_deletion_cleanup_jobs(
    user_id,
    status,
    manifest,
    final_sweep_after,
    completed_at
  )
  values (
    v_account_aba,
    'completed',
    '{}'::jsonb,
    pg_catalog.clock_timestamp() - interval '1 second',
    pg_catalog.clock_timestamp()
  );

  insert into public.storage_upload_intents(
    id, owner_user_id, purpose, bucket, path, status,
    expires_at, cleanup_after, next_attempt_at,
    token_issue_count, last_token_horizon
  )
  values (
    v_account_intent,
    v_account,
    'avatar_upload',
    'avatars',
    v_account::text || '/pending.jpg',
    'issued',
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.clock_timestamp() - interval '1 minute',
    1,
    pg_catalog.clock_timestamp() - interval '1 minute'
  );
  insert into storage.objects(bucket_id, name)
  select
    'dolls',
    v_account::text || '/objects/' ||
      pg_catalog.lpad(g::text, 5, '0') || '.png'
    from pg_catalog.generate_series(1, 10101) g;

  insert into public.credit_lots(
    id,
    user_id,
    source,
    qty,
    consumed,
    granted_at,
    expires_at
  )
  values (
    v_account_lot,
    v_account,
    'signup_bonus',
    1,
    1,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp() + interval '1 year'
  );
  insert into public.ai_generations(
    id,
    owner_id,
    fal_request_id,
    status,
    cost_cents,
    candidate_urls,
    fal_request_ids,
    fail_reason,
    picked_index,
    credit_lot_id,
    consumed_at,
    gen_params
  )
  select
    md5('bounded-account-generation-' || g::text)::uuid,
    v_account,
    'provider-request-' || g::text,
    case when g = 1 then 'picked' else 'failed' end,
    1,
    pg_catalog.jsonb_build_array(
      v_account::text || '/candidates/' ||
        md5('bounded-account-generation-' || g::text)::uuid::text ||
        '/0.jpg'
    ),
    array['provider-request-' || g::text],
    case when g = 1 then null else 'no_face' end,
    0,
    case when g = 1 then v_account_lot else null end,
    case when g = 1 then pg_catalog.clock_timestamp() else null end,
    pg_catalog.jsonb_build_object(
      'prompt', 'private prompt ' || g::text,
      'analysis', pg_catalog.jsonb_build_object('face', true),
      'candidatePath',
        v_account::text || '/candidates/' ||
          md5('bounded-account-generation-' || g::text)::uuid::text ||
          '/0.jpg'
    )
    from pg_catalog.generate_series(1, 10001) g;
  perform public.bp_credit_ledger_write(
    v_account,
    -1,
    'gen_consume',
    null,
    null,
    null,
    v_financial_generation,
    null,
    null,
    'bounded privacy fixture'
  );

  insert into public.generation_preflight_reservations(
    id,
    owner_id,
    role,
    image_digest,
    requires_credit,
    state,
    generation_id,
    expires_at,
    finalized_at
  )
  select
    md5('bounded-account-reservation-' || g::text)::uuid,
    v_account,
    'boss',
    pg_catalog.repeat('a', 64),
    false,
    'committed',
    md5('bounded-account-generation-' || g::text)::uuid,
    pg_catalog.clock_timestamp() + interval '1 hour',
    pg_catalog.clock_timestamp()
    from pg_catalog.generate_series(1, 10001) g;
  insert into public.generation_pick_intents(
    generation_id,
    owner_id,
    candidate_index,
    attempt_id,
    state,
    expires_at
  )
  select
    md5('bounded-account-generation-' || g::text)::uuid,
    v_account,
    0,
    md5('bounded-account-pick-attempt-' || g::text)::uuid,
    'expired',
    pg_catalog.clock_timestamp() - interval '1 second'
    from pg_catalog.generate_series(1, 10001) g;
  insert into public.generation_pick_cost_attempts(
    attempt_id,
    generation_id,
    owner_id,
    day_kst,
    created_at
  )
  select
    md5('bounded-account-pick-attempt-' || g::text)::uuid,
    md5('bounded-account-generation-' || g::text)::uuid,
    v_account,
    (
      pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
    )::date,
    pg_catalog.clock_timestamp()
    from pg_catalog.generate_series(1, 10001) g;

  insert into public.generation_face_check_intents(
    reservation_id,
    check_key,
    state,
    input_payload,
    payload_hash,
    callback_token_hash,
    external_request_id,
    raw_output,
    claimed_at,
    completed_at
  )
  values (
    md5('bounded-account-reservation-2')::uuid,
    'face',
    'succeeded',
    pg_catalog.jsonb_build_object(
      'image_url', 'https://private.example/input.jpg'
    ),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    'private-face-provider-id',
    'true',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );
  insert into public.generation_face_check_cost_attempts(
    reservation_id,
    check_key,
    payload_hash
  )
  values (
    md5('bounded-account-reservation-2')::uuid,
    'face',
    pg_catalog.repeat('b', 64)
  );
  insert into public.generation_submit_intents(
    generation_id,
    candidate_index,
    owner_id,
    payload_hash,
    callback_token_hash,
    state,
    attempt_count,
    request_id,
    submit_started_at,
    acknowledged_at,
    input_payload
  )
  values (
    md5('bounded-account-generation-2')::uuid,
    0,
    v_account,
    pg_catalog.repeat('d', 64),
    pg_catalog.repeat('e', 64),
    'acknowledged',
    1,
    'private-generation-provider-id',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    pg_catalog.jsonb_build_object(
      'prompt', 'private submit prompt',
      'image_url', 'https://private.example/input.jpg'
    )
  );
  insert into public.generation_cost_reconciliation_issues(
    id,
    issue_kind,
    object_key,
    owner_id,
    generation_id,
    candidate_index,
    state_snapshot,
    payload_hash,
    external_request_id,
    status,
    resolved_at,
    resolution_note
  )
  values (
    v_open_issue,
    'flux_submit',
    'flux_submit:' ||
      pg_catalog.replace(v_financial_generation::text, '-', '') ||
      ':0',
    v_account,
    v_financial_generation,
    0,
    'uncertain',
    pg_catalog.repeat('f', 64),
    'private-open-provider-id',
    'open',
    null,
    null
  ), (
    v_resolved_issue,
    'flux_submit',
    'flux_submit:' ||
      pg_catalog.replace(
        md5('bounded-account-generation-2')::uuid::text,
        '-',
        ''
      ) ||
      ':0',
    v_account,
    md5('bounded-account-generation-2')::uuid,
    0,
    'acknowledged',
    pg_catalog.repeat('1', 64),
    'private-resolved-provider-id',
    'resolved',
    pg_catalog.clock_timestamp(),
    'provider verified'
  );

  v_account_start :=
    public.admin_soft_delete_account(v_account);

  insert into public.dolls(id, owner_id, image_url)
  values (v_doll, v_owner, 'https://example.invalid/external.png');
  insert into public.scores(
    id, owner_id, doll_id, score, weapon, duration_ms
  )
  select
    md5('bounded-purge-score-' || g::text)::uuid,
    v_owner,
    v_doll,
    1,
    'fist',
    1
    from pg_catalog.generate_series(1, 10001) g;
  insert into storage.objects(bucket_id, name)
  select
    'highlights',
    md5('bounded-purge-score-' || g::text)::uuid::text || '/' ||
      md5('bounded-purge-object-' || g::text)::uuid::text || '.webm'
    from pg_catalog.generate_series(1, 10001) g;
  insert into storage.objects(bucket_id, name)
  values ('dolls', v_owner::text || '/' || v_doll::text || '.png');

  insert into public.storage_upload_intents(
    id, owner_user_id, subject_id, purpose, bucket, path, status,
    expires_at, cleanup_after, next_attempt_at,
    token_issue_count, last_token_horizon
  )
  values (
    v_moderation_intent,
    v_owner,
    v_first_score,
    'highlight_upload',
    'highlights',
    v_first_score::text || '/' ||
      md5('bounded-purge-object-1')::uuid::text || '.webm',
    'issued',
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.clock_timestamp() - interval '1 minute',
    1,
    pg_catalog.clock_timestamp() - interval '1 minute'
  );
  update public.dolls
     set deleted_at = pg_catalog.clock_timestamp(),
         deleted_by = v_admin,
         deletion_reason = 'bounded purge fixture'
   where id = v_doll;
  v_moderation_start := public.admin_begin_doll_purge(
    v_admin, v_doll, 'bounded permanent purge fixture'
  );

  insert into bounded_cleanup_ctx(
    account_user_id,
    account_aba_user_id,
    account_intent_id,
    account_job_id,
    account_financial_generation_id,
    account_open_issue_id,
    account_resolved_issue_id,
    account_preflight_cost_before,
    account_pick_cost_before,
    account_start,
    admin_id,
    owner_id,
    doll_id,
    moderation_intent_id,
    moderation_job_id,
    moderation_start
  )
  values (
    v_account,
    v_account_aba,
    v_account_intent,
    (v_account_start->>'job_id')::uuid,
    v_financial_generation,
    v_open_issue,
    v_resolved_issue,
    (
      select pg_catalog.count(*)::bigint
        from public.generation_preflight_reservations
    ),
    (
      select pg_catalog.count(*)::bigint
        from public.generation_pick_cost_attempts
    ),
    v_account_start,
    v_admin,
    v_owner,
    v_doll,
    v_moderation_intent,
    (v_moderation_start->>'job_id')::uuid,
    v_moderation_start
  );
end;
$fixture$;

select throws_ok(
  format(
    'update public.generation_preflight_reservations set owner_id = %L::uuid where id = %L::uuid',
    (select account_aba_user_id from bounded_cleanup_ctx),
    md5('bounded-account-reservation-2')::uuid
  ),
  '23503',
  null,
  'preflight receipt cannot be reassigned away from its generation owner'
);
select throws_ok(
  format(
    'update public.generation_submit_intents set owner_id = %L::uuid where generation_id = %L::uuid',
    (select account_aba_user_id from bounded_cleanup_ctx),
    md5('bounded-account-generation-2')::uuid
  ),
  '23503',
  null,
  'submit receipt cannot be reassigned away from its generation owner'
);
select throws_ok(
  format(
    'update public.generation_pick_intents set owner_id = %L::uuid where generation_id = %L::uuid',
    (select account_aba_user_id from bounded_cleanup_ctx),
    md5('bounded-account-generation-2')::uuid
  ),
  '23503',
  null,
  'pick receipt cannot be reassigned away from its generation owner'
);
select throws_ok(
  format(
    'update public.generation_pick_cost_attempts set owner_id = %L::uuid where generation_id = %L::uuid',
    (select account_aba_user_id from bounded_cleanup_ctx),
    md5('bounded-account-generation-2')::uuid
  ),
  '23503',
  null,
  'pick cost receipt cannot be reassigned away from its generation owner'
);
select throws_ok(
  format(
    'update public.generation_cost_reconciliation_issues set owner_id = %L::uuid where id = %L::uuid',
    (select account_aba_user_id from bounded_cleanup_ctx),
    (select account_resolved_issue_id from bounded_cleanup_ctx)
  ),
  '23503',
  null,
  'provider reconciliation cannot be reassigned from its generation owner'
);

select is(
  account_start->>'cleanup_status',
  'pending',
  'high-cardinality account delete creates a pending job'
) from bounded_cleanup_ctx;
select is(
  account_start->'manifest',
  '{"dolls":[],"highlights":[],"avatar":null}'::jsonb,
  'account begin does not materialize object history'
) from bounded_cleanup_ctx;
select is(
  (
    select j.manifest
      from public.account_deletion_cleanup_jobs j
     where j.id = c.account_job_id
  ),
  '{"dolls":[],"highlights":[],"avatar":null}'::jsonb,
  'durable account job starts with an empty compatibility manifest'
) from bounded_cleanup_ctx c;
select is(
  (
    select count(*)::bigint
      from storage.objects o
     where o.bucket_id = 'dolls'
       and o.name like c.account_user_id::text || '/%'
  ),
  10101::bigint,
  'account fixture exceeds ten thousand physical objects'
) from bounded_cleanup_ctx c;
select is(
  (
    select pg_catalog.count(*)::bigint
      from public.ai_generations g
      join bounded_cleanup_ctx c on c.account_user_id = g.owner_id
  ),
  10001::bigint,
  'account fixture exceeds ten thousand generation privacy receipts'
);
select is(
  (
    select pg_catalog.count(*)::bigint
      from public.bp_account_cleanup_generation_targets(
        c.account_user_id,
        10000
      )
  ),
  100::bigint,
  'generation selector clamps a 10k+ receipt set to 100'
) from bounded_cleanup_ctx c;

update bounded_cleanup_ctx
   set account_lease_one =
         public.claim_account_deletion_cleanup_v2(
           account_job_id, 120, 10000
         );
select is(
  pg_catalog.jsonb_array_length(account_lease_one->'targets'),
  100,
  'account claim clamps an oversized requested batch to 100'
) from bounded_cleanup_ctx;
select is(
  pg_catalog.jsonb_array_length(
    account_lease_one->'generation_ids'
  ),
  100,
  'account claim independently bounds generation tombstones to 100'
) from bounded_cleanup_ctx;
select is(
  (account_lease_one->>'lease_version')::integer,
  1,
  'first account claim has lease version one'
) from bounded_cleanup_ctx;
select is(
  public.claim_account_deletion_cleanup_v2(
    account_job_id, 120, 100
  ),
  null::jsonb,
  'unexpired account lease cannot be claimed twice'
) from bounded_cleanup_ctx;

update public.account_deletion_cleanup_jobs j
   set leased_until = pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.account_job_id;
update bounded_cleanup_ctx
   set account_lease_two =
         public.claim_account_deletion_cleanup_v2(
           account_job_id, 120, 100
         );
select is(
  (account_lease_two->>'lease_version')::integer,
  2,
  'expired account lease recovery advances the fence'
) from bounded_cleanup_ctx;
select is(
  account_lease_two->'targets',
  account_lease_one->'targets',
  'account lease recovery returns the same deterministic first batch'
) from bounded_cleanup_ctx;
select is(
  account_lease_two->'generation_ids',
  account_lease_one->'generation_ids',
  'account lease recovery returns the same generation privacy batch'
) from bounded_cleanup_ctx;
select throws_ok(
  format(
    'select public.finish_account_deletion_cleanup_v2(%L::uuid,%L::uuid,%s,true,null)',
    (select account_job_id from bounded_cleanup_ctx),
    (
      select account_lease_one->>'lease_token'
        from bounded_cleanup_ctx
    ),
    1
  ),
  'P0001',
  'cleanup_lease_lost',
  'stale account lease cannot finish after recovery'
);
select is(
  (
    select public.finish_account_deletion_cleanup_v2(
             account_job_id,
             (account_lease_two->>'lease_token')::uuid,
             (account_lease_two->>'lease_version')::integer,
             true,
             null
           )->>'status'
      from bounded_cleanup_ctx
  ),
  'pending_target_remains',
  'account success assertion cannot hide a residual object'
);
select ok(
  (
    select j.status = 'pending'
           and j.lease_targets = '[]'::jsonb
           and j.lease_generation_ids = '[]'::jsonb
           and j.scrubbed_generation_count = 0
           and j.lease_token is null
      from public.account_deletion_cleanup_jobs j
      join bounded_cleanup_ctx c on c.account_job_id = j.id
  ),
  'residual account batch releases and clears its lease payload'
);

do $drain_account$
declare
  v_job uuid := (select account_job_id from bounded_cleanup_ctx);
  v_lease jsonb;
  v_finish jsonb;
  v_batches integer := 0;
begin
  perform pg_catalog.set_config(
    'storage.allow_delete_query', 'true', true
  );
  while exists (
          select 1
            from public.bp_account_cleanup_targets(
              (select account_user_id from bounded_cleanup_ctx),
              1
            )
        )
     or exists (
          select 1
            from public.bp_account_cleanup_generation_targets(
              (select account_user_id from bounded_cleanup_ctx),
              1
            )
        )
  loop
    update public.account_deletion_cleanup_jobs
       set next_attempt_at =
             pg_catalog.clock_timestamp() - interval '1 second'
     where id = v_job;
    v_lease :=
      public.claim_account_deletion_cleanup_v2(v_job, 120, 100);
    if v_lease is null
       or pg_catalog.jsonb_array_length(v_lease->'targets') > 100
       or pg_catalog.jsonb_array_length(
            v_lease->'generation_ids'
          ) > 100
       or (
         pg_catalog.jsonb_array_length(v_lease->'targets') = 0
         and pg_catalog.jsonb_array_length(
               v_lease->'generation_ids'
             ) = 0
       ) then
      raise exception 'account bounded claim invariant failed';
    end if;
    delete from storage.objects o
     using pg_catalog.jsonb_array_elements(v_lease->'targets') target
     where o.bucket_id = target->>'bucket'
       and o.name = target->>'path';
    v_finish := public.finish_account_deletion_cleanup_v2(
      v_job,
      (v_lease->>'lease_token')::uuid,
      (v_lease->>'lease_version')::integer,
      true,
      null
    );
    if v_finish->>'status' not in (
      'pending_batch',
      'pending_final_sweep',
      'pending_generation_reconciliation',
      -- 0101: final_sweep 이 intent horizon 단일 소스가 되면서, 과거
      -- horizon 픽스처는 final_sweep 주차 없이 정당한 후속 단계
      -- (intent 드레인)까지 진행한다.
      'pending_intent_drain'
    ) then
      raise exception 'account drain status invariant failed: %',
        v_finish;
    end if;
    v_batches := v_batches + 1;
    if v_batches > 200 then
      raise exception 'account drain did not converge';
    end if;
  end loop;
  update bounded_cleanup_ctx set account_batches = v_batches;
end;
$drain_account$;

select is(
  (
    select count(*)::bigint
      from storage.objects o
      join bounded_cleanup_ctx c
        on o.bucket_id = 'dolls'
       and o.name like c.account_user_id::text || '/%'
  ),
  0::bigint,
  'all 10k+ account objects drain without target loss'
);
select is(
  (
    select j.removed_target_count
      from public.account_deletion_cleanup_jobs j
      join bounded_cleanup_ctx c on c.account_job_id = j.id
  ),
  10101::bigint,
  'account removal count covers every bounded lease target'
);
select ok(
  account_batches > 100,
  'account cleanup required and completed more than 100 bounded claims'
) from bounded_cleanup_ctx;
select is(
  (
    select pg_catalog.count(*)::bigint
      from public.ai_generations g
      join bounded_cleanup_ctx c on c.account_user_id = g.owner_id
     where g.privacy_scrubbed_at is null
  ),
  0::bigint,
  'open reconciliation never delays generation de-identification'
);
select is(
  (
    select j.scrubbed_generation_count
      from public.account_deletion_cleanup_jobs j
      join bounded_cleanup_ctx c on c.account_job_id = j.id
  ),
  10001::bigint,
  'bounded cleanup records every generation tombstone exactly once'
);
select ok(
  (
    select pg_catalog.count(*)::bigint
      from public.generation_preflight_reservations
  ) >= c.account_preflight_cost_before,
  'privacy scrub never decreases the current-day global preflight upper bound'
) from bounded_cleanup_ctx c;
select ok(
  (
    select pg_catalog.count(*)::bigint
      from public.generation_pick_cost_attempts
  ) >= c.account_pick_cost_before,
  'privacy scrub never decreases the current-day global pick upper bound'
) from bounded_cleanup_ctx c;
select ok(
  (
    select g.owner_id is null
       and g.privacy_scrubbed_at is not null
       and g.fal_request_id is null
       and g.fal_request_ids is null
       and g.candidate_urls = '[]'::jsonb
       and g.gen_params is null
       and r.owner_id is null
       and r.image_digest = pg_catalog.repeat('0', 64)
       and r.analysis_result is null
       and r.generation_config is null
       and r.generation_plan is null
       and p.owner_id is null
       and p.state = 'expired'
       and pc.owner_id is null
       and f.input_payload = '{}'::jsonb
       and f.external_request_id is null
       and fc.payload_hash = pg_catalog.repeat('0', 64)
       and s.owner_id is null
       and s.input_payload is null
       and s.request_id is null
       and q.owner_id is null
       and q.external_request_id is null
       and q.resolution_note = 'account_deleted'
      from public.ai_generations g
      join public.generation_preflight_reservations r
        on r.generation_id = g.id
      join public.generation_pick_intents p
        on p.generation_id = g.id
      join public.generation_pick_cost_attempts pc
        on pc.generation_id = g.id
      join public.generation_face_check_intents f
        on f.reservation_id = r.id
      join public.generation_face_check_cost_attempts fc
        on fc.reservation_id = r.id
       and fc.check_key = f.check_key
      join public.generation_submit_intents s
        on s.generation_id = g.id
      cross join bounded_cleanup_ctx c
      join public.generation_cost_reconciliation_issues q
        on q.id = c.account_resolved_issue_id
     where g.id = md5('bounded-account-generation-2')::uuid
  ),
  'generation tombstone scrubs input, provider, provenance, and artifact linkage'
);
select throws_ok(
  format(
    'update public.ai_generations set gen_params = %L::jsonb where id = %L::uuid',
    '{"prompt":"stale private rewrite"}',
    md5('bounded-account-generation-2')::uuid
  ),
  'P0001',
  'generation_privacy_scrubbed',
  'a stale generation worker cannot resurrect scrubbed PII'
);

update public.account_deletion_cleanup_jobs j
   set final_sweep_after =
         pg_catalog.clock_timestamp() - interval '1 second',
       next_attempt_at =
         pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.account_job_id;
update bounded_cleanup_ctx
   set account_lease_one =
         public.claim_account_deletion_cleanup_v2(
           account_job_id, 120, 100
         );
select is(
  pg_catalog.jsonb_array_length(account_lease_one->'targets'),
  0,
  'account final claim observes an empty physical target set'
) from bounded_cleanup_ctx;
select is(
  pg_catalog.jsonb_array_length(
    account_lease_one->'generation_ids'
  ),
  0,
  'anonymized open provider receipt is not a generation PII target'
) from bounded_cleanup_ctx;
select is(
  (account_lease_one->>'scrub_auth')::boolean,
  false,
  'open upload intent alone prevents premature Auth scrub'
) from bounded_cleanup_ctx;
select is(
  (
    select public.finish_account_deletion_cleanup_v2(
             account_job_id,
             (account_lease_one->>'lease_token')::uuid,
             (account_lease_one->>'lease_version')::integer,
             true,
             null
           )->>'status'
      from bounded_cleanup_ctx
  ),
  'pending_intent_drain',
  'anonymous provider debt never blocks the upload-intent drain'
);
select ok(
  (
    select q.status = 'open'
       and q.owner_id is null
       and q.generation_id is null
       and q.reservation_id is null
       and q.candidate_index is null
       and q.external_request_id is null
       and q.payload_hash = pg_catalog.repeat('0', 64)
       and q.object_key =
             'privacy:' || pg_catalog.replace(q.id::text, '-', '')
       and q.privacy_scrubbed_at is not null
      from public.generation_cost_reconciliation_issues q
      join bounded_cleanup_ctx c on c.account_open_issue_id = q.id
  ),
  'open provider debt survives only as a non-identifying cost receipt'
);
select throws_ok(
  format(
    'update public.generation_cost_reconciliation_issues set external_request_id = %L where id = %L::uuid',
    'late-private-provider-replay',
    (select account_open_issue_id from bounded_cleanup_ctx)
  ),
  'P0001',
  'generation_privacy_scrubbed',
  'late provider replay cannot reattach PII to anonymous open debt'
);
select ok(
  (
    select g.owner_id is null
       and g.privacy_scrubbed_at is not null
       and g.credit_lot_id is not null
       and g.consumed_at is not null
       and exists (
         select 1
           from public.credit_ledger l
          where l.ref_gen_id = g.id
            and l.user_id = c.account_user_id
            and l.event_type = 'gen_consume'
       )
       and q.status = 'open'
       and q.owner_id is null
       and q.generation_id is null
       and q.external_request_id is null
       and q.privacy_scrubbed_at is not null
      from public.ai_generations g
      join bounded_cleanup_ctx c
        on c.account_financial_generation_id = g.id
      join public.generation_cost_reconciliation_issues q
        on q.id = c.account_open_issue_id
  ),
  'financial lot and ledger references survive exact generation PII scrub'
);
select is(
  (
    select pg_catalog.count(*)::bigint
      from public.ai_generations g
      join bounded_cleanup_ctx c on c.account_user_id = g.owner_id
     where g.privacy_scrubbed_at is null
  ),
  0::bigint,
  'all 10k+ generation receipts become non-identifying tombstones'
);
select throws_ok(
  format(
    $sql$
      insert into public.credit_ledger(
        user_id,
        delta,
        event_type,
        balance_after,
        ref_gen_id,
        schema_version
      )
      values (%L::uuid,0,'gen_refund',%s,%L::uuid,2)
    $sql$,
    (select owner_id from bounded_cleanup_ctx),
    (
      select m.gen_credits
        from public.member_accounts m
        join bounded_cleanup_ctx c on c.owner_id = m.user_id
    ),
    (select account_financial_generation_id from bounded_cleanup_ctx)
  ),
  'P0001',
  'credit_ledger_owner_mismatch',
  'scrubbed generation ledger still rejects a different financial owner'
);

update public.storage_upload_intents i
   set status = 'cleaned',
       cleaned_at = pg_catalog.clock_timestamp(),
       updated_at = pg_catalog.clock_timestamp()
  from bounded_cleanup_ctx c
 where i.id = c.account_intent_id;
update public.account_deletion_cleanup_jobs j
   set next_attempt_at =
         pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.account_job_id;
update bounded_cleanup_ctx
   set account_lease_two =
         public.claim_account_deletion_cleanup_v2(
           account_job_id, 120, 100
         );
select is(
  (account_lease_two->>'scrub_auth')::boolean,
  true,
  'drained account with unsanitized Auth receives an explicit scrub action'
) from bounded_cleanup_ctx;
select is(
  (
    select public.arm_account_deletion_cleanup_auth_fence(
             account_job_id,
             account_user_id,
             (account_lease_two->>'lease_token')::uuid,
             (account_lease_two->>'lease_version')::integer
           )->>'action'
      from bounded_cleanup_ctx
  ),
  'scrub',
  'account Auth scrub is armed by the exact live lease'
);
update auth.users u
   set email =
         'deleted+' || c.account_user_id::text || '@deleted.invalid',
       raw_user_meta_data = '{}'::jsonb
  from bounded_cleanup_ctx c
 where u.id = c.account_user_id;
update public.account_deletion_cleanup_jobs j
   set leased_until = pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.account_job_id;
update bounded_cleanup_ctx
   set account_lease_two =
         public.claim_account_deletion_cleanup_v2(
           account_job_id, 120, 100
         );
select is(
  (account_lease_two->>'scrub_auth')::boolean,
  false,
  'lease recovery recognizes an already-scrubbed Auth identity'
) from bounded_cleanup_ctx;
select is(
  (
    select public.finish_account_deletion_cleanup_v2(
             account_job_id,
             (account_lease_two->>'lease_token')::uuid,
             (account_lease_two->>'lease_version')::integer,
             true,
             null
           )->>'status'
      from bounded_cleanup_ctx
  ),
  'completed',
  'account completes only after bounded drain, intent drain, and Auth scrub'
);
select ok(
  (
    select j.status = 'completed'
           and j.manifest = '{}'::jsonb
           and j.lease_targets = '[]'::jsonb
           and j.lease_generation_ids = '[]'::jsonb
           and j.scrubbed_generation_count = 10001
      from public.account_deletion_cleanup_jobs j
      join bounded_cleanup_ctx c on c.account_job_id = j.id
  ),
  'terminal account job scrubs every path and generation lease payload'
);
select ok(
  (
    select public.bp_account_cleanup_auth_is_scrubbed(
             account_user_id
           )
      from bounded_cleanup_ctx
  ),
  'terminal account Auth postcondition is exact'
);
select ok(
  (
    select not (
             coalesce(u.raw_app_meta_data, '{}'::jsonb)
               ? 'bp_account_cleanup_fence'
           )
      from auth.users u
      join bounded_cleanup_ctx c on c.account_user_id = u.id
  ),
  'terminal account completion removes its private Auth fence'
);
do $resolve_anonymous_cost_debt$
declare
  v_issue_id uuid;
begin
  select account_open_issue_id
    into v_issue_id
    from bounded_cleanup_ctx;

  perform public.resolve_generation_cost_reconciliation_issue(
    v_issue_id,
    'anonymous cost debt resolved'
  );
end
$resolve_anonymous_cost_debt$;

select ok(
  q.status = 'resolved'
  and q.owner_id is null
  and q.generation_id is null
  and q.external_request_id is null
  and q.privacy_scrubbed_at is not null,
  'anonymous provider debt remains resolvable after account completion'
)
  from bounded_cleanup_ctx c
  join public.generation_cost_reconciliation_issues q
    on q.id = c.account_open_issue_id;
select throws_ok(
  format(
    'update auth.users set email = %L where id = %L::uuid',
    'deleted+' ||
      (select account_aba_user_id::text from bounded_cleanup_ctx) ||
      '@deleted.invalid',
    (select account_aba_user_id from bounded_cleanup_ctx)
  ),
  'P0001',
  'stale_cleanup_auth_fence',
  'expired cleanup worker cannot scrub Auth after completion/reactivation'
);

select is(
  moderation_start->>'status',
  'pending',
  'high-cardinality moderation purge creates a pending job'
) from bounded_cleanup_ctx;
select is(
  (
    select j.manifest
      from public.moderation_purge_jobs j
      join bounded_cleanup_ctx c on c.moderation_job_id = j.id
  ),
  '[]'::jsonb,
  'moderation begin does not materialize score/highlight history'
);
select is(
  (
    select count(*)::bigint
      from public.bp_moderation_cleanup_targets(c.doll_id, 20000)
  ),
  100::bigint,
  'moderation selector clamps a 10k+ target set to 100'
) from bounded_cleanup_ctx c;

update bounded_cleanup_ctx
   set moderation_lease_one =
         public.claim_moderation_purge_v2(
           moderation_job_id, 120, 10000
         );
select is(
  pg_catalog.jsonb_array_length(moderation_lease_one->'manifest'),
  100,
  'moderation claim clamps an oversized requested batch to 100'
) from bounded_cleanup_ctx;
select is(
  (moderation_lease_one->>'lease_version')::integer,
  1,
  'first moderation claim has lease version one'
) from bounded_cleanup_ctx;
select is(
  public.claim_moderation_purge_v2(
    moderation_job_id, 120, 100
  ),
  null::jsonb,
  'unexpired moderation lease cannot be claimed twice'
) from bounded_cleanup_ctx;

update public.moderation_purge_jobs j
   set leased_until = pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.moderation_job_id;
update bounded_cleanup_ctx
   set moderation_lease_two =
         public.claim_moderation_purge_v2(
           moderation_job_id, 120, 100
         );
select is(
  (moderation_lease_two->>'lease_version')::integer,
  2,
  'expired moderation lease recovery advances the fence'
) from bounded_cleanup_ctx;
select is(
  moderation_lease_two->'manifest',
  moderation_lease_one->'manifest',
  'moderation lease recovery returns the same deterministic batch'
) from bounded_cleanup_ctx;
select throws_ok(
  format(
    'select public.finish_moderation_purge_v2(%L::uuid,%L::uuid,%s,true,null)',
    (select moderation_job_id from bounded_cleanup_ctx),
    (
      select moderation_lease_one->>'lease_token'
        from bounded_cleanup_ctx
    ),
    1
  ),
  'P0001',
  'purge_lease_lost',
  'stale moderation lease cannot finish after recovery'
);
select is(
  (
    select public.finish_moderation_purge_v2(
             moderation_job_id,
             (moderation_lease_two->>'lease_token')::uuid,
             (moderation_lease_two->>'lease_version')::integer,
             true,
             null
           )->>'status'
      from bounded_cleanup_ctx
  ),
  'pending_target_remains',
  'moderation success assertion cannot hide a residual object'
);

do $drain_moderation$
declare
  v_job uuid := (select moderation_job_id from bounded_cleanup_ctx);
  v_lease jsonb;
  v_finish jsonb;
  v_batches integer := 0;
begin
  perform pg_catalog.set_config(
    'storage.allow_delete_query', 'true', true
  );
  while exists (
    select 1
      from public.bp_moderation_cleanup_targets(
        (select doll_id from bounded_cleanup_ctx),
        1
      )
  )
  loop
    update public.moderation_purge_jobs
       set next_attempt_at =
             pg_catalog.clock_timestamp() - interval '1 second'
     where id = v_job;
    v_lease := public.claim_moderation_purge_v2(v_job, 120, 100);
    if v_lease is null
       or pg_catalog.jsonb_array_length(v_lease->'manifest')
            not between 1 and 100 then
      raise exception 'moderation bounded claim invariant failed';
    end if;
    delete from storage.objects o
     using pg_catalog.jsonb_array_elements(v_lease->'manifest') target
     where o.bucket_id = target->>'bucket'
       and o.name = target->>'path';
    v_finish := public.finish_moderation_purge_v2(
      v_job,
      (v_lease->>'lease_token')::uuid,
      (v_lease->>'lease_version')::integer,
      true,
      null
    );
    if v_finish->>'status' not in (
      'pending_batch', 'pending_final_sweep'
    ) then
      raise exception 'moderation drain status invariant failed: %',
        v_finish;
    end if;
    v_batches := v_batches + 1;
    if v_batches > 200 then
      raise exception 'moderation drain did not converge';
    end if;
  end loop;
  update bounded_cleanup_ctx set moderation_batches = v_batches;
end;
$drain_moderation$;

select is(
  (
    select count(*)::bigint
      from public.bp_moderation_cleanup_targets(c.doll_id, 100)
  ),
  0::bigint,
  'all 10k+ moderation objects drain without target loss'
) from bounded_cleanup_ctx c;
select is(
  (
    select j.purged_target_count
      from public.moderation_purge_jobs j
      join bounded_cleanup_ctx c on c.moderation_job_id = j.id
  ),
  10002::bigint,
  'moderation removal count covers every bounded lease target'
);
select ok(
  moderation_batches > 100,
  'moderation purge required and completed more than 100 bounded claims'
) from bounded_cleanup_ctx;
select throws_ok(
  format(
    'update public.storage_upload_intents set last_token_horizon = clock_timestamp() + interval ''1 hour'' where id = %L::uuid',
    (select moderation_intent_id from bounded_cleanup_ctx)
  ),
  'P0001',
  'purge_pending',
  'purge start rejects every late signed-token horizon extension'
);

update public.moderation_purge_jobs j
   set final_sweep_after =
         pg_catalog.clock_timestamp() - interval '1 second',
       next_attempt_at =
         pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.moderation_job_id;
update bounded_cleanup_ctx
   set moderation_lease_one =
         public.claim_moderation_purge_v2(
           moderation_job_id, 120, 100
         );
select is(
  pg_catalog.jsonb_array_length(moderation_lease_one->'manifest'),
  0,
  'moderation final claim observes an empty physical target set'
) from bounded_cleanup_ctx;
select is(
  (
    select public.finish_moderation_purge_v2(
             moderation_job_id,
             (moderation_lease_one->>'lease_token')::uuid,
             (moderation_lease_one->>'lease_version')::integer,
             true,
             null
           )->>'status'
      from bounded_cleanup_ctx
  ),
  'pending_intent_drain',
  'moderation finish waits for upload-intent drain'
);
update public.storage_upload_intents i
   set status = 'cleaned',
       cleaned_at = pg_catalog.clock_timestamp(),
       updated_at = pg_catalog.clock_timestamp()
  from bounded_cleanup_ctx c
 where i.id = c.moderation_intent_id;
update public.moderation_purge_jobs j
   set next_attempt_at =
         pg_catalog.clock_timestamp() - interval '1 second'
  from bounded_cleanup_ctx c
 where j.id = c.moderation_job_id;
update bounded_cleanup_ctx
   set moderation_lease_two =
         public.claim_moderation_purge_v2(
           moderation_job_id, 120, 100
         );
select is(
  pg_catalog.jsonb_array_length(moderation_lease_two->'manifest'),
  0,
  'drained moderation retry remains an empty bounded lease'
) from bounded_cleanup_ctx;
select is(
  (
    select public.finish_moderation_purge_v2(
             moderation_job_id,
             (moderation_lease_two->>'lease_token')::uuid,
             (moderation_lease_two->>'lease_version')::integer,
             true,
             null
           )->>'status'
      from bounded_cleanup_ctx
  ),
  'completed',
  'moderation completes only after target, horizon, and intent drain'
);
select ok(
  (
    select d.artifacts_purged_at is not null
      from public.dolls d
      join bounded_cleanup_ctx c on c.doll_id = d.id
  ),
  'terminal moderation job marks artifacts purged'
);
select ok(
  (
    select count(*) = 1
           and max(
             (l.metadata->>'purged_targets')::bigint
           ) = 10002
      from public.moderation_actions_ledger l
      join bounded_cleanup_ctx c
        on l.target_id = c.doll_id
       and l.action_type = 'purge_doll'
  ),
  'moderation terminal ledger is unique and carries the exact target count'
);

select * from finish();
rollback;
