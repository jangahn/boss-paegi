-- 008901 private fal output persistence and raw-face terminal proof.

begin;
select plan(26);

select has_column(
  'public',
  'generation_submit_intents',
  'provider_output',
  'verified provider output has a durable column'
);
select has_column(
  'public',
  'generation_submit_intents',
  'provider_output_at',
  'provider output persistence is timestamped'
);
select has_column(
  'public',
  'generation_submit_intents',
  'provider_output_scrubbed_at',
  'provider output has a replay-resistant scrub seal'
);
select has_function(
  'public',
  'record_generation_submit_provider_output',
  array['uuid','integer','text','text','text','jsonb'],
  'verified output recording RPC exists'
);
select has_function(
  'public',
  'list_generation_submit_provider_outputs',
  array['uuid','uuid'],
  'recovery output listing RPC exists'
);
select has_function(
  'public',
  'get_generation_face_cleanup_readiness',
  array['uuid'],
  'raw-face cleanup readiness RPC exists'
);
select has_function(
  'public',
  'scrub_generation_submit_provider_outputs',
  array['uuid','uuid'],
  'terminal provider output scrub RPC exists'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.record_generation_submit_provider_output(uuid,integer,text,text,text,jsonb)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.list_generation_submit_provider_outputs(uuid,uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.get_generation_face_cleanup_readiness(uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.scrub_generation_submit_provider_outputs(uuid,uuid)',
    'EXECUTE'
  ),
  'service role can execute the private output/cleanup RPCs'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.record_generation_submit_provider_output(uuid,integer,text,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.list_generation_submit_provider_outputs(uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_generation_face_cleanup_readiness(uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.scrub_generation_submit_provider_outputs(uuid,uuid)',
    'EXECUTE'
  ),
  'browser roles cannot read or mutate provider output evidence'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.generation_submit_intents'::regclass
       and c.conname = 'generation_submit_provider_output_shape'
  ),
  'provider output has a canonical database shape constraint'
);

create temporary table generation_output_ctx (
  owner_id uuid not null,
  other_owner_id uuid not null,
  generation_id uuid not null,
  expiry_generation_id uuid not null,
  payload_hash text not null,
  callback_hash text not null,
  request_id text not null,
  output jsonb not null
) on commit drop;

insert into generation_output_ctx
select
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  repeat('a', 64),
  repeat('1', 64),
  'request-output-0',
  pg_catalog.jsonb_build_object(
    'image', pg_catalog.jsonb_build_object(
      'url', 'https://v3b.fal.media/files/b/opaque/output.jpg',
      'width', 768,
      'height', 1024,
      'content_type', 'image/jpeg',
      'file_size', 123456
    ),
    'seed', 4294967295,
    'nsfw', false
  );

insert into auth.users(id, email)
select owner_id, 'provider-output-' || owner_id || '@test.local'
  from generation_output_ctx
union all
select other_owner_id, 'provider-output-' || other_owner_id || '@test.local'
  from generation_output_ctx;

insert into public.ai_generations(id, owner_id, status, gen_params)
select
  generation_id,
  owner_id,
  'queued',
  '{"generation":{"candidates":[]}}'::jsonb
from generation_output_ctx;
insert into public.ai_generations(id, owner_id, status, gen_params)
select
  expiry_generation_id,
  owner_id,
  'queued',
  '{"generation":{"candidates":[]}}'::jsonb
from generation_output_ctx;

insert into public.generation_submit_intents(
  generation_id,
  candidate_index,
  owner_id,
  payload_hash,
  callback_token_hash,
  state,
  attempt_count,
  request_id,
  webhook_status,
  submit_started_at,
  acknowledged_at,
  last_webhook_at,
  provider_output,
  provider_output_at
)
select
  generation_id,
  0,
  owner_id,
  payload_hash,
  callback_hash,
  'acknowledged',
  1,
  request_id,
  'OK',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),
  null::jsonb,
  null::timestamptz
from generation_output_ctx
union all
select
  generation_id,
  1,
  owner_id,
  repeat('b', 64),
  repeat('2', 64),
  'rejected',
  1,
  null,
  null,
  pg_catalog.clock_timestamp(),
  null,
  null,
  null,
  null
from generation_output_ctx
union all
select
  generation_id,
  2,
  owner_id,
  repeat('c', 64),
  repeat('3', 64),
  'acknowledged',
  1,
  'request-output-2',
  'ERROR',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),
  null,
  null
from generation_output_ctx
union all
select
  expiry_generation_id,
  0,
  owner_id,
  repeat('d', 64),
  repeat('4', 64),
  'acknowledged',
  1,
  'request-expired-output',
  'OK',
  pg_catalog.clock_timestamp() - interval '7 hours',
  pg_catalog.clock_timestamp() - interval '7 hours',
  pg_catalog.clock_timestamp() - interval '7 hours',
  output,
  pg_catalog.clock_timestamp() - interval '7 hours'
from generation_output_ctx;

create or replace function pg_temp.invalid_provider_output_constraint()
returns text
language plpgsql
as $$
declare
  v_constraint text;
begin
  perform public.record_generation_submit_provider_output(
    c.generation_id,
    0,
    c.payload_hash,
    c.callback_hash,
    c.request_id,
    c.output
      #- array['image','url']
      || '{"image":{"url":"https://example.invalid/output.jpg"}}'::jsonb
  )
  from generation_output_ctx c;
  return 'not_rejected';
exception
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    return v_constraint;
end;
$$;

select is(
  pg_temp.invalid_provider_output_constraint(),
  'generation_submit_provider_output_shape',
  'non-canonical provider output is rejected by the database'
);
select is(
  (
    select public.record_generation_submit_provider_output(
      generation_id,
      0,
      payload_hash,
      callback_hash,
      request_id,
      output
    )->>'outcome'
    from generation_output_ctx
  ),
  'recorded',
  'first verified provider output is recorded'
);
select ok(
  (
    select i.provider_output = c.output
       and i.provider_output_at is not null
      from public.generation_submit_intents i
      join generation_output_ctx c
        on c.generation_id = i.generation_id
     where i.candidate_index = 0
  ),
  'only the exact canonical output and timestamp are durable'
);
select is(
  (
    select public.record_generation_submit_provider_output(
      generation_id,
      0,
      payload_hash,
      callback_hash,
      request_id,
      output
    )->>'outcome'
    from generation_output_ctx
  ),
  'already_recorded',
  'identical webhook replay is idempotent'
);
select is(
  (
    select public.record_generation_submit_provider_output(
      generation_id,
      0,
      payload_hash,
      callback_hash,
      request_id,
      pg_catalog.jsonb_set(output, '{seed}', '7'::jsonb)
    )->>'outcome'
    from generation_output_ctx
  ),
  'result_conflict',
  'different output for the same request is a durable conflict'
);
select is(
  (
    select public.record_generation_submit_provider_output(
      generation_id,
      0,
      payload_hash,
      callback_hash,
      'different-request',
      output
    )->>'outcome'
    from generation_output_ctx
  ),
  'binding_conflict',
  'output cannot cross its signed request binding'
);
select ok(
  (
    select
      listed->>'outcome' = 'listed'
      and pg_catalog.jsonb_array_length(listed->'outputs') = 1
      and listed #>> '{outputs,0,candidate_index}' = '0'
      and listed #>> '{outputs,0,request_id}' = c.request_id
      and listed #> '{outputs,0,output}' = c.output
    from generation_output_ctx c
    cross join lateral public.list_generation_submit_provider_outputs(
      c.generation_id,
      c.owner_id
    ) listed
  ),
  'recovery list preserves exact candidate/request/output binding'
);
select is(
  (
    select public.list_generation_submit_provider_outputs(
      generation_id,
      other_owner_id
    )->>'outcome'
    from generation_output_ctx
  ),
  'not_found',
  'another owner cannot list provider output evidence'
);
select ok(
  (
    select
      readiness->>'ok' = 'true'
      and (readiness->>'ready')::boolean
      and readiness->>'owner_id' = c.owner_id::text
    from generation_output_ctx c
    cross join lateral public.get_generation_face_cleanup_readiness(
      c.generation_id
    ) readiness
  ),
  'three terminal submissions authorize immediate raw-face cleanup'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.generation_submit_intents i
      join generation_output_ctx c
        on c.generation_id = i.generation_id
     where i.provider_output is not null
  ),
  1,
  'ERROR and pre-provider rejection never fabricate provider output'
);

update public.ai_generations g
   set status = 'done'
  from generation_output_ctx c
 where g.id = c.generation_id;
select is(
  (
    select public.scrub_generation_submit_provider_outputs(
      generation_id,
      owner_id
    )->>'outcome'
    from generation_output_ctx
  ),
  'scrubbed',
  'terminal materialization immediately scrubs provider output'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.generation_submit_intents i
      join generation_output_ctx c
        on c.generation_id = i.generation_id
     where i.provider_output is null
       and i.provider_output_at is null
       and i.provider_output_scrubbed_at is not null
  ),
  3,
  'terminal scrub seals every candidate binding'
);
select is(
  (
    select public.record_generation_submit_provider_output(
      generation_id,
      0,
      payload_hash,
      callback_hash,
      request_id,
      output
    )->>'outcome'
    from generation_output_ctx
  ),
  'already_scrubbed',
  'late webhook replay cannot reintroduce a private CDN URL'
);
select is(
  (
    select pg_catalog.jsonb_array_length(
      public.list_generation_submit_provider_outputs(
        generation_id,
        owner_id
      )->'outputs'
    )
    from generation_output_ctx
  ),
  0,
  'scrubbed provider URLs are absent from the recovery projection'
);
select ok(
  (
    select
      (pruned->>'provider_output_scrubbed')::integer >= 1
      and (pruned->>'provider_output_scrub_backlog')::integer = 0
    from public.prune_generation_cost_controls(100) pruned
  ),
  'bounded maintenance scrubs six-hour output and reports zero backlog'
);
select ok(
  (
    select
      i.provider_output is null
      and i.provider_output_at is null
      and i.provider_output_scrubbed_at is not null
      from public.generation_submit_intents i
      join generation_output_ctx c
        on c.expiry_generation_id = i.generation_id
     where i.candidate_index = 0
  ),
  'six-hour lifecycle backstop erases and seals the queued output'
);

select * from finish();
rollback;
