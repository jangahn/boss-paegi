-- fal queue submit acknowledgement saga.
--
-- The JavaScript SDK retries queue POSTs after transport/5xx failures. If fal
-- accepted the first POST but its response was lost, that creates a second
-- paid job and leaves the first request id unknown. This migration provides a
-- durable, single-attempt intent and a signed-webhook acknowledgement path.
--
-- Lock order follows 0084:
--   generation object advisory -> owner advisory -> generation row -> intent.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create table public.generation_submit_intents (
  generation_id uuid not null
    references public.ai_generations(id) on delete cascade,
  candidate_index smallint not null
    check (candidate_index between 0 and 2),
  owner_id uuid not null,
  payload_hash text not null
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  callback_token_hash text not null
    check (callback_token_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'planned'
    check (
      state in (
        'planned',
        'submitting',
        'uncertain',
        'acknowledged',
        'rejected',
        'conflict',
        'late_acknowledged'
      )
    ),
  attempt_count smallint not null default 0
    check (attempt_count between 0 and 1),
  request_id text,
  conflict_request_id text,
  http_status integer
    check (http_status is null or http_status between 100 and 599),
  webhook_status text
    check (webhook_status is null or webhook_status in ('OK', 'ERROR')),
  submit_started_at timestamptz,
  acknowledged_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (generation_id, candidate_index),
  unique (callback_token_hash),
  check (
    (state = 'planned'
      and attempt_count = 0
      and submit_started_at is null
      and request_id is null)
    or
    (state in ('submitting', 'uncertain', 'rejected')
      and attempt_count = 1
      and submit_started_at is not null
      and request_id is null)
    or
    (state in ('acknowledged', 'conflict', 'late_acknowledged')
      and attempt_count = 1
      and submit_started_at is not null
      and request_id is not null
      and acknowledged_at is not null)
  ),
  check (
    (state = 'conflict' and conflict_request_id is not null)
    or
    (state <> 'conflict' and conflict_request_id is null)
  )
);

create unique index generation_submit_intents_request_id_unique
  on public.generation_submit_intents(request_id)
  where request_id is not null;

create index generation_submit_intents_unresolved
  on public.generation_submit_intents(submit_started_at, generation_id)
  where state in ('submitting', 'uncertain', 'conflict', 'late_acknowledged');

create trigger generation_submit_intents_audit
  before update on public.generation_submit_intents
  for each row execute function public.set_updated_at_and_version();

alter table public.generation_submit_intents enable row level security;
revoke all on table public.generation_submit_intents
  from public, anon, authenticated, service_role;

comment on table public.generation_submit_intents is
  'One durable, at-most-one HTTP attempt per generation candidate. Raw callback tokens and generated payloads are never stored.';

create function public.bp_0086_merge_generation_candidate(
  p_gen_params jsonb,
  p_candidate_index integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_candidates jsonb;
  v_matches integer;
begin
  if p_gen_params is null
     or pg_catalog.jsonb_typeof(p_gen_params) <> 'object'
     or pg_catalog.jsonb_typeof(
       p_gen_params #> array['generation', 'candidates']
     ) <> 'array'
     or p_candidate_index is null
     or p_candidate_index not between 0 and 2
     or p_patch is null
     or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'generation_submit_provenance_invalid'
      using errcode = 'P0001';
  end if;

  select
    pg_catalog.jsonb_agg(
      case
        when candidate->>'index' = p_candidate_index::text
          then candidate || p_patch
        else candidate
      end
      order by ordinal
    ),
    pg_catalog.count(*) filter (
      where candidate->>'index' = p_candidate_index::text
    )
    into v_candidates, v_matches
    from pg_catalog.jsonb_array_elements(
      p_gen_params #> array['generation', 'candidates']
    ) with ordinality as c(candidate, ordinal);

  if v_matches <> 1 then
    raise exception 'generation_submit_candidate_missing_or_ambiguous'
      using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_set(
    p_gen_params,
    array['generation', 'candidates'],
    v_candidates,
    false
  );
end;
$$;
revoke all on function public.bp_0086_merge_generation_candidate(
  jsonb, integer, jsonb
) from public, anon, authenticated, service_role;

create function public.prepare_generation_submit_intents(
  p_gen_id uuid,
  p_owner_id uuid,
  p_intents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
  v_item jsonb;
  v_index integer;
  v_payload_hash text;
  v_token_hash text;
  v_existing public.generation_submit_intents;
  v_params jsonb;
  v_seen integer[] := array[]::integer[];
begin
  if p_gen_id is null or p_owner_id is null then
    raise exception 'generation_submit_identity_required'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);

  select * into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found');
  end if;
  if g.owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'owner_mismatch');
  end if;
  if g.status <> 'queued' or g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'terminal', 'status', g.status);
  end if;
  if pg_catalog.jsonb_typeof(p_intents) <> 'array'
     or pg_catalog.jsonb_array_length(p_intents) <> 3 then
    raise exception 'generation_submit_intents_invalid'
      using errcode = 'P0001';
  end if;

  v_params := g.gen_params;
  for v_item in
    select value
      from pg_catalog.jsonb_array_elements(p_intents)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or pg_catalog.jsonb_typeof(v_item->'candidateIndex') <> 'number'
       or (v_item->>'candidateIndex') !~ '^[0-2]$'
       or (v_item->>'payloadHash') !~ '^[0-9a-f]{64}$'
       or (v_item->>'callbackTokenHash') !~ '^[0-9a-f]{64}$' then
      raise exception 'generation_submit_intent_invalid'
        using errcode = 'P0001';
    end if;
    v_index := (v_item->>'candidateIndex')::integer;
    if v_index = any(v_seen) then
      raise exception 'generation_submit_candidate_duplicate'
        using errcode = 'P0001';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_index);
    v_payload_hash := v_item->>'payloadHash';
    v_token_hash := v_item->>'callbackTokenHash';

    insert into public.generation_submit_intents(
      generation_id,
      candidate_index,
      owner_id,
      payload_hash,
      callback_token_hash
    )
    values (
      p_gen_id,
      v_index,
      p_owner_id,
      v_payload_hash,
      v_token_hash
    )
    on conflict (generation_id, candidate_index) do nothing;

    select * into v_existing
      from public.generation_submit_intents
     where generation_id = p_gen_id
       and candidate_index = v_index
     for update;
    if v_existing.owner_id <> p_owner_id
       or v_existing.payload_hash <> v_payload_hash
       or v_existing.callback_token_hash <> v_token_hash then
      raise exception 'generation_submit_intent_conflict'
        using errcode = 'P0001';
    end if;

    v_params := public.bp_0086_merge_generation_candidate(
      v_params,
      v_index,
      pg_catalog.jsonb_build_object(
        'submitState', v_existing.state,
        'payloadHash', v_payload_hash
      )
    );
  end loop;

  update public.ai_generations
     set gen_params = v_params
   where id = p_gen_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared');
end;
$$;
revoke all on function public.prepare_generation_submit_intents(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_generation_submit_intents(
  uuid, uuid, jsonb
) to service_role;

create function public.claim_generation_submit_intent(
  p_gen_id uuid,
  p_owner_id uuid,
  p_candidate_index integer,
  p_payload_hash text,
  p_callback_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
  i public.generation_submit_intents;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_params jsonb;
begin
  if p_gen_id is null or p_owner_id is null
     or p_candidate_index is null
     or p_candidate_index not between 0 and 2
     or p_payload_hash is null
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_callback_token_hash is null
     or p_callback_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'generation_submit_claim_invalid'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);

  select * into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found');
  end if;
  if g.owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'owner_mismatch');
  end if;

  select * into i
    from public.generation_submit_intents
   where generation_id = p_gen_id
     and candidate_index = p_candidate_index
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'intent_missing');
  end if;
  if i.payload_hash <> p_payload_hash
     or i.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'intent_mismatch');
  end if;
  if g.status <> 'queued' or g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'terminal', 'status', g.status);
  end if;
  if i.state = 'acknowledged' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'already_acknowledged',
      'requestId', i.request_id
    );
  end if;
  if i.state <> 'planned' or i.attempt_count <> 0 then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_claimable', 'state', i.state);
  end if;

  update public.generation_submit_intents
     set state = 'submitting',
         attempt_count = 1,
         submit_started_at = v_now
   where generation_id = p_gen_id
     and candidate_index = p_candidate_index;
  v_params := public.bp_0086_merge_generation_candidate(
    g.gen_params,
    p_candidate_index,
    pg_catalog.jsonb_build_object('submitState', 'submitting')
  );
  update public.ai_generations
     set gen_params = v_params
   where id = p_gen_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'claimed');
end;
$$;
revoke all on function public.claim_generation_submit_intent(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_submit_intent(
  uuid, uuid, integer, text, text
) to service_role;

create function public.record_generation_submit_outcome(
  p_gen_id uuid,
  p_candidate_index integer,
  p_payload_hash text,
  p_callback_token_hash text,
  p_outcome text,
  p_request_id text default null,
  p_http_status integer default null,
  p_webhook_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations;
  i public.generation_submit_intents;
  v_owner_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_params jsonb;
  v_slots text[];
  v_duplicate record;
  v_terminal boolean;
begin
  if p_gen_id is null
     or p_candidate_index is null
     or p_candidate_index not between 0 and 2
     or p_payload_hash is null
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_callback_token_hash is null
     or p_callback_token_hash !~ '^[0-9a-f]{64}$'
     or p_outcome is null
     or p_outcome not in ('acknowledged', 'rejected', 'uncertain')
     or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_webhook_status is not null
         and p_webhook_status not in ('OK', 'ERROR'))
     or (p_outcome = 'acknowledged' and
         (p_request_id is null
          or pg_catalog.length(p_request_id) not between 1 and 256
          or p_request_id ~ '[[:cntrl:]]'))
     or (p_outcome <> 'acknowledged' and p_request_id is not null) then
    raise exception 'generation_submit_outcome_invalid'
      using errcode = 'P0001';
  end if;

  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  select owner_id into v_owner_id
    from public.ai_generations
   where id = p_gen_id;
  if v_owner_id is not null then
    perform public.bp_user_mutation_lock(v_owner_id);
  end if;

  select * into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found');
  end if;
  select * into i
    from public.generation_submit_intents
   where generation_id = p_gen_id
     and candidate_index = p_candidate_index
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'intent_missing');
  end if;
  if i.payload_hash <> p_payload_hash
     or i.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'intent_mismatch');
  end if;

  v_terminal := g.status <> 'queued' or g.refunded_at is not null;

  if p_outcome = 'acknowledged' then
    if i.state = 'conflict' then
      update public.generation_submit_intents
         set http_status = coalesce(p_http_status, http_status),
             webhook_status = coalesce(p_webhook_status, webhook_status),
             last_webhook_at = case
               when p_webhook_status is null then last_webhook_at
               else v_now
             end
       where generation_id = p_gen_id
         and candidate_index = p_candidate_index;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'request_id_conflict');
    end if;
    if i.request_id = p_request_id then
      update public.generation_submit_intents
         set http_status = coalesce(p_http_status, http_status),
             webhook_status = coalesce(p_webhook_status, webhook_status),
             last_webhook_at = case
               when p_webhook_status is null then last_webhook_at
               else v_now
             end
       where generation_id = p_gen_id
         and candidate_index = p_candidate_index;
      if i.state = 'late_acknowledged' then
        return pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'late_acknowledged');
      end if;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'already_acknowledged',
        'requestId', i.request_id
      );
    end if;
    if i.request_id is not null and i.request_id <> p_request_id then
      update public.generation_submit_intents
         set state = 'conflict',
             conflict_request_id = p_request_id,
             http_status = coalesce(p_http_status, http_status),
             webhook_status = coalesce(p_webhook_status, webhook_status),
             last_webhook_at = case
               when p_webhook_status is null then last_webhook_at
               else v_now
             end
       where generation_id = p_gen_id
         and candidate_index = p_candidate_index;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'request_id_conflict');
    end if;

    select generation_id, candidate_index
      into v_duplicate
      from public.generation_submit_intents
     where request_id = p_request_id
       and (generation_id, candidate_index)
           <> (p_gen_id, p_candidate_index)
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'request_id_reused');
    end if;

    update public.generation_submit_intents
       set state = case
             when v_terminal then 'late_acknowledged'
             else 'acknowledged'
           end,
           attempt_count = 1,
           submit_started_at = coalesce(submit_started_at, v_now),
           request_id = p_request_id,
           acknowledged_at = coalesce(acknowledged_at, v_now),
           http_status = coalesce(p_http_status, http_status),
           webhook_status = coalesce(p_webhook_status, webhook_status),
           last_webhook_at = case
             when p_webhook_status is null then last_webhook_at
             else v_now
           end
     where generation_id = p_gen_id
       and candidate_index = p_candidate_index;

    if v_terminal then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'late_acknowledged',
        'status', g.status
      );
    end if;

    v_slots := array[
      case when p_candidate_index = 0 then p_request_id
        else g.fal_request_ids[1] end,
      case when p_candidate_index = 1 then p_request_id
        else g.fal_request_ids[2] end,
      case when p_candidate_index = 2 then p_request_id
        else g.fal_request_ids[3] end
    ];
    v_params := public.bp_0086_merge_generation_candidate(
      g.gen_params,
      p_candidate_index,
      pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'status', 'submitted',
        'submitState', 'acknowledged'
      )
    );
    update public.ai_generations
       set fal_request_ids = v_slots,
           gen_params = v_params
     where id = p_gen_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', case
        when i.request_id = p_request_id then 'already_acknowledged'
        else 'acknowledged'
      end,
      'requestId', p_request_id
    );
  end if;

  if v_terminal then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'terminal', 'status', g.status);
  end if;
  if i.request_id is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'already_acknowledged',
      'requestId', i.request_id
    );
  end if;

  update public.generation_submit_intents
     set state = p_outcome,
         attempt_count = 1,
         submit_started_at = coalesce(submit_started_at, v_now),
         http_status = coalesce(p_http_status, http_status)
   where generation_id = p_gen_id
     and candidate_index = p_candidate_index;
  v_params := public.bp_0086_merge_generation_candidate(
    g.gen_params,
    p_candidate_index,
    case
      when p_outcome = 'rejected' then
        pg_catalog.jsonb_build_object(
          'status', 'failed', 'submitState', 'rejected')
      else
        pg_catalog.jsonb_build_object('submitState', 'uncertain')
    end
  );
  update public.ai_generations
     set gen_params = v_params
   where id = p_gen_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', p_outcome);
end;
$$;
revoke all on function public.record_generation_submit_outcome(
  uuid, integer, text, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_submit_outcome(
  uuid, integer, text, text, text, text, integer, text
) to service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.prepare_generation_submit_intents(uuid,uuid,jsonb)',
    'public.claim_generation_submit_intent(uuid,uuid,integer,text,text)',
    'public.record_generation_submit_outcome(uuid,integer,text,text,text,text,integer,text)'
  ]
  loop
    if not pg_catalog.has_function_privilege(
      'service_role',
      v_signature,
      'EXECUTE'
    ) then
      raise exception '0086 postflight: service_role missing %', v_signature;
    end if;
    if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or pg_catalog.has_function_privilege(
         'authenticated', v_signature, 'EXECUTE') then
      raise exception '0086 postflight: client execute leaked %', v_signature;
    end if;
  end loop;
  if pg_catalog.has_table_privilege(
       'service_role', 'public.generation_submit_intents', 'INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege(
       'anon', 'public.generation_submit_intents', 'SELECT')
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.generation_submit_intents', 'SELECT') then
    raise exception '0086 postflight: direct intent table privilege leaked';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0086_fal_submit_ack_saga', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
