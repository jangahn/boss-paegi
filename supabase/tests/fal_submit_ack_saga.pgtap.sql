-- 0086 fal queue single-attempt + response-loss/webhook recovery contract.

begin;
select plan(44);

select has_table(
  'public',
  'generation_submit_intents',
  'generation submit intent table exists'
);
select has_function(
  'public',
  'prepare_generation_submit_intents',
  array['uuid','uuid','jsonb'],
  'prepare RPC exists'
);
select has_function(
  'public',
  'claim_generation_submit_intent',
  array['uuid','uuid','integer','text','text'],
  'single-attempt claim RPC exists'
);
select has_function(
  'public',
  'record_generation_submit_outcome',
  array['uuid','integer','text','text','text','text','integer','text'],
  'acknowledgement RPC exists'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.generation_submit_intents'::regclass
  ),
  'intent table has RLS enabled'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.pg_policy
     where polrelid = 'public.generation_submit_intents'::regclass
  ),
  0,
  'intent table has no client policy'
);
select ok(
  not pg_catalog.has_table_privilege(
    'service_role',
    'public.generation_submit_intents',
    'INSERT,UPDATE,DELETE'
  ),
  'service role cannot bypass intent RPC writes'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.prepare_generation_submit_intents(uuid,uuid,jsonb)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_generation_submit_intent(uuid,uuid,integer,text,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)',
    'EXECUTE'
  ),
  'service role can execute only the saga surface'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.prepare_generation_submit_intents(uuid,uuid,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_generation_submit_intent(uuid,uuid,integer,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)',
    'EXECUTE'
  ),
  'browser roles cannot execute the saga'
);
select ok(
  not pg_catalog.has_function_privilege(
    'service_role',
    'public.bp_0086_merge_generation_candidate(jsonb,integer,jsonb)',
    'EXECUTE'
  ),
  'private provenance merge cannot bypass the saga'
);

create temporary table fal_submit_ctx (
  owner_id uuid not null,
  generation_id uuid not null,
  late_generation_id uuid not null,
  payload0 text not null,
  payload1 text not null,
  payload2 text not null,
  token0 text not null,
  token1 text not null,
  token2 text not null,
  request1 text not null,
  request_late text not null,
  request_normal_terminal text not null
) on commit drop;

insert into fal_submit_ctx
select
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  repeat('a', 64),
  repeat('b', 64),
  repeat('c', 64),
  repeat('1', 64),
  repeat('2', 64),
  repeat('3', 64),
  gen_random_uuid()::text,
  gen_random_uuid()::text,
  gen_random_uuid()::text;

insert into auth.users(id, email)
select owner_id, 'fal-submit-' || owner_id || '@test.local'
  from fal_submit_ctx;

insert into public.ai_generations(id, owner_id, status, gen_params)
select
  generation_id,
  owner_id,
  'queued',
  pg_catalog.jsonb_build_object(
    'generation',
    pg_catalog.jsonb_build_object(
      'candidates',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'index', 0, 'requestId', null, 'status', 'submitted'),
        pg_catalog.jsonb_build_object(
          'index', 1, 'requestId', null, 'status', 'submitted'),
        pg_catalog.jsonb_build_object(
          'index', 2, 'requestId', null, 'status', 'submitted')
      )
    )
  )
from fal_submit_ctx;

select is(
  (
    select public.prepare_generation_submit_intents(
      generation_id,
      owner_id,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'candidateIndex', 0,
          'payloadHash', payload0,
          'callbackTokenHash', token0),
        pg_catalog.jsonb_build_object(
          'candidateIndex', 1,
          'payloadHash', payload1,
          'callbackTokenHash', token1),
        pg_catalog.jsonb_build_object(
          'candidateIndex', 2,
          'payloadHash', payload2,
          'callbackTokenHash', token2)
      )
    )->>'outcome'
    from fal_submit_ctx
  ),
  'prepared',
  'three exact intents are prepared before external I/O'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
  ),
  3,
  'exactly three candidate intents exist'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
     where i.state = 'planned'
       and i.attempt_count = 0
       and i.request_id is null
  ),
  3,
  'prepare does not claim or pretend to submit'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.ai_generations g
      join fal_submit_ctx c on c.generation_id = g.id
      cross join lateral pg_catalog.jsonb_array_elements(
        g.gen_params #> array['generation','candidates']
      ) candidate
     where candidate->>'submitState' = 'planned'
       and candidate->>'payloadHash' ~ '^[0-9a-f]{64}$'
  ),
  3,
  'provenance mirrors every durable planned intent without callback tokens'
);
select ok(
  not exists (
    select 1
      from public.ai_generations g
      join fal_submit_ctx c on c.generation_id = g.id
     where g.gen_params::text like '%' || c.token0 || '%'
        or g.gen_params::text like '%' || c.token1 || '%'
        or g.gen_params::text like '%' || c.token2 || '%'
  ),
  'callback token hashes are not copied into provenance'
);

select is(
  (
    select public.claim_generation_submit_intent(
      generation_id, owner_id, 0, payload0, token0
    )->>'outcome'
      from fal_submit_ctx
  ),
  'claimed',
  'first claim authorizes one external HTTP attempt'
);
select is(
  (
    select public.claim_generation_submit_intent(
      generation_id, owner_id, 0, payload0, token0
    )->>'outcome'
      from fal_submit_ctx
  ),
  'not_claimable',
  'claim replay cannot authorize a second HTTP attempt'
);
select is(
  (
    select i.attempt_count
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
     where i.candidate_index = 0
  ),
  1::smallint,
  'attempt count remains exactly one'
);
select is(
  (
    select public.record_generation_submit_outcome(
      generation_id, 0, payload0, token0, 'uncertain', null, 503, null
    )->>'outcome'
      from fal_submit_ctx
  ),
  'uncertain',
  'response loss remains unresolved instead of retry/refund'
);
select is(
  (
    select i.state
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
     where i.candidate_index = 0
  ),
  'uncertain',
  'uncertain state is durable'
);

select is(
  (
    select public.claim_generation_submit_intent(
      generation_id, owner_id, 1, payload1, token1
    )->>'outcome'
      from fal_submit_ctx
  ),
  'claimed',
  'second candidate has an independent one-attempt fence'
);
select is(
  (
    select public.record_generation_submit_outcome(
      generation_id,
      1,
      payload1,
      token1,
      'acknowledged',
      request1,
      200,
      'OK'
    )->>'outcome'
      from fal_submit_ctx
  ),
  'acknowledged',
  'signed webhook/response records the request id'
);
select is(
  (
    select g.fal_request_ids[2]
      from public.ai_generations g
      join fal_submit_ctx c on c.generation_id = g.id
  ),
  (select request1 from fal_submit_ctx),
  'acknowledgement fills the exact candidate request slot'
);
select ok(
  (
    select
      g.fal_request_ids[1] is null
      and g.fal_request_ids[3] is null
      and candidate->>'requestId' = c.request1
      and candidate->>'submitState' = 'acknowledged'
      from public.ai_generations g
      join fal_submit_ctx c on c.generation_id = g.id
      cross join lateral pg_catalog.jsonb_array_elements(
        g.gen_params #> array['generation','candidates']
      ) candidate
     where candidate->>'index' = '1'
  ),
  'ack merge preserves null neighbor slots and exact candidate index'
);
select is(
  (
    select public.record_generation_submit_outcome(
      generation_id,
      1,
      payload1,
      token1,
      'acknowledged',
      request1,
      200,
      'OK'
    )->>'outcome'
      from fal_submit_ctx
  ),
  'already_acknowledged',
  'duplicate webhook delivery is idempotent'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
     where i.request_id = c.request1
  ),
  1,
  'duplicate webhook cannot duplicate the request mapping'
);
select is(
  (
    select public.record_generation_submit_outcome(
      generation_id,
      1,
      payload1,
      token1,
      'acknowledged',
      gen_random_uuid()::text,
      200,
      'OK'
    )->>'outcome'
      from fal_submit_ctx
  ),
  'request_id_conflict',
  'a second request id for one candidate is surfaced as a cost conflict'
);
select ok(
  (
    select i.state = 'conflict'
       and i.request_id = c.request1
       and i.conflict_request_id is not null
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
     where i.candidate_index = 1
  ),
  'conflict preserves the canonical id and the duplicate evidence'
);

select is(
  (
    select public.claim_generation_submit_intent(
      generation_id, owner_id, 2, payload2, token2
    )->>'outcome'
      from fal_submit_ctx
  ),
  'claimed',
  'third candidate claim succeeds once'
);
select is(
  (
    select public.record_generation_submit_outcome(
      generation_id, 2, payload2, token2, 'rejected', null, 422, null
    )->>'outcome'
      from fal_submit_ctx
  ),
  'rejected',
  'definite validation rejection is terminal for that candidate'
);
select ok(
  (
    select i.state = 'rejected'
       and i.request_id is null
       and candidate->>'status' = 'failed'
       and candidate->>'submitState' = 'rejected'
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
      join public.ai_generations g on g.id = i.generation_id
      cross join lateral pg_catalog.jsonb_array_elements(
        g.gen_params #> array['generation','candidates']
      ) candidate
     where i.candidate_index = 2
       and candidate->>'index' = '2'
  ),
  'definite rejection is mirrored without fabricating a request id'
);
select is(
  (
    select public.record_generation_submit_outcome(
      generation_id,
      2,
      payload2,
      repeat('9', 64),
      'uncertain',
      null,
      503,
      null
    )->>'outcome'
      from fal_submit_ctx
  ),
  'intent_mismatch',
  'wrong callback token hash cannot mutate an intent'
);
select is(
  (
    select i.state
      from public.generation_submit_intents i
      join fal_submit_ctx c on c.generation_id = i.generation_id
     where i.candidate_index = 2
  ),
  'rejected',
  'token mismatch leaves prior state unchanged'
);

insert into public.ai_generations(id, owner_id, status, gen_params)
select
  late_generation_id,
  owner_id,
  'queued',
  pg_catalog.jsonb_build_object(
    'generation',
    pg_catalog.jsonb_build_object(
      'candidates',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'index', 0, 'requestId', null, 'status', 'submitted'),
        pg_catalog.jsonb_build_object(
          'index', 1, 'requestId', null, 'status', 'submitted'),
        pg_catalog.jsonb_build_object(
          'index', 2, 'requestId', null, 'status', 'submitted')
      )
    )
  )
from fal_submit_ctx;
select is(
  (
    select public.prepare_generation_submit_intents(
      late_generation_id,
      owner_id,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'candidateIndex', 0,
          'payloadHash', payload0,
          'callbackTokenHash', repeat('4', 64)),
        pg_catalog.jsonb_build_object(
          'candidateIndex', 1,
          'payloadHash', payload1,
          'callbackTokenHash', repeat('5', 64)),
        pg_catalog.jsonb_build_object(
          'candidateIndex', 2,
          'payloadHash', payload2,
          'callbackTokenHash', repeat('6', 64))
      )
    )->>'outcome'
      from fal_submit_ctx
  ),
  'prepared',
  'late-ack fixture is prepared'
);
select is(
  (
    select public.claim_generation_submit_intent(
      late_generation_id, owner_id, 1, payload1, repeat('5', 64)
    )->>'outcome'
      from fal_submit_ctx
  ),
  'claimed',
  'normally acknowledged terminal fixture is claimed'
);
select is(
  (
    select public.record_generation_submit_outcome(
      late_generation_id,
      1,
      payload1,
      repeat('5', 64),
      'acknowledged',
      request_normal_terminal,
      200,
      null
    )->>'outcome'
      from fal_submit_ctx
  ),
  'acknowledged',
  'normal response acknowledgement is recorded before terminal transition'
);
select is(
  (
    select public.claim_generation_submit_intent(
      late_generation_id, owner_id, 0, payload0, repeat('4', 64)
    )->>'outcome'
      from fal_submit_ctx
  ),
  'claimed',
  'late-ack fixture has a possible accepted request'
);
update public.ai_generations g
   set status = 'failed'
  from fal_submit_ctx c
 where g.id = c.late_generation_id;
select is(
  (
    select public.record_generation_submit_outcome(
      late_generation_id,
      1,
      payload1,
      repeat('5', 64),
      'acknowledged',
      request_normal_terminal,
      null,
      'OK'
    )->>'outcome'
      from fal_submit_ctx
  ),
  'already_acknowledged',
  'webhook after completion stays idempotent when response ack was durable'
);
select is(
  (
    select i.state
      from public.generation_submit_intents i
      join fal_submit_ctx c
        on c.late_generation_id = i.generation_id
     where i.candidate_index = 1
  ),
  'acknowledged',
  'normal terminal duplicate is not mislabeled as a late paid orphan'
);
select is(
  (
    select public.record_generation_submit_outcome(
      late_generation_id,
      0,
      payload0,
      repeat('4', 64),
      'acknowledged',
      request_late,
      null,
      'OK'
    )->>'outcome'
      from fal_submit_ctx
  ),
  'late_acknowledged',
  'webhook after terminal refund is never hidden as a normal duplicate'
);
select ok(
  (
    select i.state = 'late_acknowledged'
       and i.request_id = c.request_late
       and i.last_webhook_at is not null
      from public.generation_submit_intents i
      join fal_submit_ctx c
        on c.late_generation_id = i.generation_id
     where i.candidate_index = 0
  ),
  'late paid work remains durable for reconciliation'
);
select ok(
  (
    select
      g.fal_request_ids[1] is null
      and g.fal_request_ids[2] = c.request_normal_terminal
      and g.fal_request_ids[3] is null
      from public.ai_generations g
      join fal_submit_ctx c on c.late_generation_id = g.id
  ),
  'late acknowledgement never resurrects a terminal generation'
);

select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.prepare_generation_submit_intents(uuid,uuid,jsonb)'::regprocedure
    )
  ),
  'bp_mutation_object_lock[\s\S]*bp_user_mutation_lock[\s\S]*for update',
  'prepare follows object-before-user-before-row lock order'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)'::regprocedure
    )
  ),
  'bp_mutation_object_lock[\s\S]*bp_user_mutation_lock[\s\S]*for update',
  'webhook acknowledgement follows the global lock order'
);

select * from finish();
rollback;
