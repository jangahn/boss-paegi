-- 0081: legal document state-machine serialization, CAS, and receipts.
--
-- Fixes:
--   * save_draft previously skipped the publish/unpublish advisory lock. A
--     publish could snapshot an old draft and then delete a concurrently saved
--     replacement.
--   * stale editor saves/publishes had no compare-and-swap identity.
--   * publish/unpublish committed successfully but an HTTP/revalidation response
--     loss made retries fail with no_draft/no_reservation.
--
-- New overloads carry operation_id plus exact draft/reservation identity. A
-- receipt is committed with the state transition and is replayed verbatim.
-- Legacy signatures remain as serialized wrappers for rolling-deploy safety.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if to_regclass('public.legal_documents') is null
     or to_regclass('public.legal_documents_audit') is null
     or to_regprocedure('public.bp_assert_active_admin(uuid)') is null then
    raise exception '0081 preflight: legal/admin dependencies missing';
  end if;
end;
$$;

-- The original SQL predicate could evaluate jsonb_array_length on a non-array
-- input before returning false. Keep the validator total for every JSON value
-- so malformed service calls receive invalid_sections, never an internal DB
-- exception.
create or replace function public.legal_sections_valid(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'array' then
    return false;
  end if;
  return pg_catalog.jsonb_array_length(p) between 1 and 50
    and pg_catalog.octet_length(p::text) <= 200000
    and not exists (
      select 1
        from pg_catalog.jsonb_array_elements(p) e
       where pg_catalog.char_length(
               coalesce(e->>'heading', '')
             ) not between 1 and 120
          or pg_catalog.char_length(
               coalesce(e->>'body', '')
             ) not between 1 and 20000
    );
end;
$$;
revoke all on function public.legal_sections_valid(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.legal_sections_valid(jsonb)
  to service_role;

create table public.legal_operation_receipts (
  operation_id uuid primary key,
  doc_type text not null check (doc_type in ('privacy', 'terms')),
  action text not null check (
    action in ('save_draft', 'publish', 'unpublish')
  ),
  -- Keep the exact canonical request, not only a digest. Digest equality can
  -- never prove request equality in every possible collision scenario.
  request_payload jsonb not null check (
    pg_catalog.jsonb_typeof(request_payload) = 'object'
  ),
  response jsonb not null check (
    pg_catalog.jsonb_typeof(response) = 'object'
    and response->>'ok' = 'true'
  ),
  admin_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table public.legal_operation_receipts is
  'Committed legal mutation responses keyed by client operation UUID; enables exact response-loss replay without duplicate audit rows.';

alter table public.legal_operation_receipts enable row level security;
revoke all on table public.legal_operation_receipts
  from public, anon, authenticated, service_role;

create index idx_legal_operation_receipts_created
  on public.legal_operation_receipts(created_at, operation_id);

create or replace function public.bp_legal_operation_replay(
  p_operation_id uuid,
  p_doc_type text,
  p_action text,
  p_request_payload jsonb,
  p_admin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.legal_operation_receipts%rowtype;
begin
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = 'P0001';
  end if;
  -- operation_id is global across both document types. Serialize it as well
  -- as the per-document state lock so concurrent conflicting uses cannot race
  -- past this lookup and surface a raw unique-key error.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legal-operation:' || p_operation_id::text,
      0::bigint
    )
  );
  select *
    into v_receipt
    from public.legal_operation_receipts
   where operation_id = p_operation_id;
  if not found then
    return null;
  end if;
  if v_receipt.doc_type <> p_doc_type
     or v_receipt.action <> p_action
     or v_receipt.request_payload is distinct from p_request_payload
     or v_receipt.admin_user_id <> p_admin_id then
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  return v_receipt.response;
end;
$$;
revoke all on function public.bp_legal_operation_replay(
  uuid, text, text, jsonb, uuid
) from public, anon, authenticated, service_role;

create or replace function public.bp_record_legal_operation(
  p_operation_id uuid,
  p_doc_type text,
  p_action text,
  p_request_payload jsonb,
  p_response jsonb,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.legal_operation_receipts(
    operation_id,
    doc_type,
    action,
    request_payload,
    response,
    admin_user_id
  )
  values (
    p_operation_id,
    p_doc_type,
    p_action,
    p_request_payload,
    p_response,
    p_admin_id
  );
end;
$$;
revoke all on function public.bp_record_legal_operation(
  uuid, text, text, jsonb, jsonb, uuid
) from public, anon, authenticated, service_role;

-- ── Strict save overload ─────────────────────────────────────────────────────
create or replace function public.admin_save_legal_draft(
  p_doc_type text,
  p_title text,
  p_sections jsonb,
  p_public_note text,
  p_admin_note text,
  p_admin_id uuid,
  p_operation_id uuid,
  p_base_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.legal_documents%rowtype;
  v_now timestamptz;
  v_request jsonb;
  v_replay jsonb;
  v_response jsonb;
begin
  if p_doc_type is null or p_doc_type not in ('privacy', 'terms') then
    raise exception 'invalid_doc_type' using errcode = 'P0001';
  end if;
  perform public.bp_assert_active_admin(p_admin_id);
  if pg_catalog.char_length(coalesce(p_title, '')) not between 1 and 200 then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;
  if not coalesce(public.legal_sections_valid(p_sections), false) then
    raise exception 'invalid_sections' using errcode = 'P0001';
  end if;
  if p_public_note is not null
     and pg_catalog.char_length(p_public_note) > 1000 then
    raise exception 'invalid_public_note' using errcode = 'P0001';
  end if;
  if p_admin_note is not null
     and pg_catalog.char_length(p_admin_note) > 2000 then
    raise exception 'invalid_admin_note' using errcode = 'P0001';
  end if;

  v_request := pg_catalog.jsonb_build_object(
    'title', p_title,
    'sections', p_sections,
    'public_note', p_public_note,
    'admin_note', p_admin_note,
    'base_updated_at', p_base_updated_at
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legal:' || p_doc_type,
      0::bigint
    )
  );
  v_replay := public.bp_legal_operation_replay(
    p_operation_id,
    p_doc_type,
    'save_draft',
    v_request,
    p_admin_id
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select *
    into v_draft
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'draft'
   for update;

  if found then
    if p_base_updated_at is null
       or v_draft.updated_at <> p_base_updated_at then
      raise exception 'version_conflict' using errcode = 'P0001';
    end if;
    v_now := clock_timestamp();
    update public.legal_documents
       set title = p_title,
           sections = p_sections,
           public_note = p_public_note,
           admin_note = p_admin_note,
           created_by = p_admin_id,
           updated_at = v_now
     where id = v_draft.id
    returning * into v_draft;
  else
    if p_base_updated_at is not null then
      raise exception 'version_conflict' using errcode = 'P0001';
    end if;
    v_now := clock_timestamp();
    insert into public.legal_documents(
      doc_type,
      status,
      version,
      effective_date,
      title,
      sections,
      public_note,
      admin_note,
      created_by,
      updated_at
    )
    values (
      p_doc_type,
      'draft',
      0,
      null,
      p_title,
      p_sections,
      p_public_note,
      p_admin_note,
      p_admin_id,
      v_now
    )
    returning * into v_draft;
  end if;

  insert into public.legal_documents_audit(
    doc_type,
    action,
    version,
    effective_date,
    public_note,
    admin_note,
    admin_user_id
  )
  values (
    p_doc_type,
    'legal_draft_saved',
    0,
    null,
    p_public_note,
    p_admin_note,
    p_admin_id
  );

  v_response := pg_catalog.jsonb_build_object(
    'ok', true,
    'draft_id', v_draft.id,
    'draft_updated_at', v_draft.updated_at
  );
  perform public.bp_record_legal_operation(
    p_operation_id,
    p_doc_type,
    'save_draft',
    v_request,
    v_response,
    p_admin_id
  );
  return v_response;
end;
$$;

-- ── Strict publish overload ──────────────────────────────────────────────────
create or replace function public.admin_publish_legal(
  p_doc_type text,
  p_effective_date date,
  p_admin_id uuid,
  p_operation_id uuid,
  p_expected_draft_id uuid,
  p_expected_draft_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.legal_documents%rowtype;
  v_latest public.legal_documents%rowtype;
  v_today date :=
    (clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_version int;
  v_published_id uuid;
  v_request jsonb;
  v_replay jsonb;
  v_response jsonb;
begin
  if p_doc_type is null or p_doc_type not in ('privacy', 'terms') then
    raise exception 'invalid_doc_type' using errcode = 'P0001';
  end if;
  perform public.bp_assert_active_admin(p_admin_id);
  if p_effective_date is null then
    raise exception 'effective_date_required' using errcode = 'P0001';
  end if;
  if p_effective_date < v_today then
    raise exception 'effective_date_past' using errcode = 'P0001';
  end if;

  v_request := pg_catalog.jsonb_build_object(
    'effective_date', p_effective_date,
    'expected_draft_id', p_expected_draft_id,
    'expected_draft_updated_at', p_expected_draft_updated_at
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legal:' || p_doc_type,
      0::bigint
    )
  );
  v_replay := public.bp_legal_operation_replay(
    p_operation_id,
    p_doc_type,
    'publish',
    v_request,
    p_admin_id
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select *
    into v_draft
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'draft'
   for update;
  if not found then
    raise exception 'no_draft' using errcode = 'P0001';
  end if;
  if p_expected_draft_id is null
     or p_expected_draft_updated_at is null
     or v_draft.id <> p_expected_draft_id
     or v_draft.updated_at <> p_expected_draft_updated_at then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if not coalesce(public.legal_sections_valid(v_draft.sections), false) then
    raise exception 'invalid_sections' using errcode = 'P0001';
  end if;

  if exists (
    select 1
      from public.legal_documents
     where doc_type = p_doc_type
       and status = 'published'
       and effective_date > v_today
  ) then
    raise exception 'reservation_exists' using errcode = 'P0001';
  end if;

  select *
    into v_latest
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'published'
   order by version desc, id desc
   limit 1;
  if found
     and v_latest.title = v_draft.title
     and v_latest.sections = v_draft.sections
     and coalesce(v_latest.public_note, '') =
       coalesce(v_draft.public_note, '')
     and v_latest.effective_date = p_effective_date then
    raise exception 'no_change' using errcode = 'P0001';
  end if;

  select coalesce(max(version), 0) + 1
    into v_version
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'published';

  insert into public.legal_documents(
    doc_type,
    status,
    version,
    effective_date,
    title,
    sections,
    public_note,
    admin_note,
    created_by,
    updated_at
  )
  values (
    p_doc_type,
    'published',
    v_version,
    p_effective_date,
    v_draft.title,
    v_draft.sections,
    v_draft.public_note,
    v_draft.admin_note,
    p_admin_id,
    clock_timestamp()
  )
  returning id into v_published_id;

  delete from public.legal_documents
   where id = v_draft.id;
  if not found then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  insert into public.legal_documents_audit(
    doc_type,
    action,
    version,
    effective_date,
    public_note,
    admin_note,
    admin_user_id
  )
  values (
    p_doc_type,
    'legal_published',
    v_version,
    p_effective_date,
    v_draft.public_note,
    v_draft.admin_note,
    p_admin_id
  );

  v_response := pg_catalog.jsonb_build_object(
    'ok', true,
    'published_id', v_published_id,
    'version', v_version,
    'effective_date', p_effective_date
  );
  perform public.bp_record_legal_operation(
    p_operation_id,
    p_doc_type,
    'publish',
    v_request,
    v_response,
    p_admin_id
  );
  return v_response;
end;
$$;

-- ── Strict unpublish overload ────────────────────────────────────────────────
create or replace function public.admin_unpublish_legal(
  p_doc_type text,
  p_admin_id uuid,
  p_operation_id uuid,
  p_expected_reservation_id uuid,
  p_expected_reservation_version int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date :=
    (clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_reservation public.legal_documents%rowtype;
  v_draft public.legal_documents%rowtype;
  v_restored boolean := false;
  v_request jsonb;
  v_replay jsonb;
  v_response jsonb;
begin
  if p_doc_type is null or p_doc_type not in ('privacy', 'terms') then
    raise exception 'invalid_doc_type' using errcode = 'P0001';
  end if;
  perform public.bp_assert_active_admin(p_admin_id);

  v_request := pg_catalog.jsonb_build_object(
    'expected_reservation_id', p_expected_reservation_id,
    'expected_reservation_version', p_expected_reservation_version
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legal:' || p_doc_type,
      0::bigint
    )
  );
  v_replay := public.bp_legal_operation_replay(
    p_operation_id,
    p_doc_type,
    'unpublish',
    v_request,
    p_admin_id
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select *
    into v_reservation
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'published'
     and effective_date > v_today
   order by effective_date asc, version asc, id asc
   limit 1
   for update;
  if not found then
    raise exception 'no_reservation' using errcode = 'P0001';
  end if;
  if p_expected_reservation_id is null
     or p_expected_reservation_version is null
     or v_reservation.id <> p_expected_reservation_id
     or v_reservation.version <> p_expected_reservation_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  select *
    into v_draft
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'draft'
   for update;
  if not found then
    insert into public.legal_documents(
      doc_type,
      status,
      version,
      effective_date,
      title,
      sections,
      public_note,
      admin_note,
      created_by,
      updated_at
    )
    values (
      p_doc_type,
      'draft',
      0,
      null,
      v_reservation.title,
      v_reservation.sections,
      v_reservation.public_note,
      v_reservation.admin_note,
      p_admin_id,
      clock_timestamp()
    );
    v_restored := true;
  end if;

  delete from public.legal_documents
   where id = v_reservation.id;
  if not found then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  insert into public.legal_documents_audit(
    doc_type,
    action,
    version,
    effective_date,
    public_note,
    admin_note,
    admin_user_id
  )
  values (
    p_doc_type,
    'legal_unpublished',
    v_reservation.version,
    v_reservation.effective_date,
    v_reservation.public_note,
    v_reservation.admin_note,
    p_admin_id
  );

  v_response := pg_catalog.jsonb_build_object(
    'ok', true,
    'restored_draft', v_restored,
    'version', v_reservation.version
  );
  perform public.bp_record_legal_operation(
    p_operation_id,
    p_doc_type,
    'unpublish',
    v_request,
    v_response,
    p_admin_id
  );
  return v_response;
end;
$$;

-- ── Rolling-deploy legacy wrappers ──────────────────────────────────────────
create or replace function public.admin_save_legal_draft(
  p_doc_type text,
  p_title text,
  p_sections jsonb,
  p_public_note text,
  p_admin_note text,
  p_admin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:' || p_doc_type, 0::bigint)
  );
  select updated_at
    into v_base
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'draft'
   for update;
  return public.admin_save_legal_draft(
    p_doc_type,
    p_title,
    p_sections,
    p_public_note,
    p_admin_note,
    p_admin_id,
    gen_random_uuid(),
    v_base
  );
end;
$$;

create or replace function public.admin_publish_legal(
  p_doc_type text,
  p_effective_date date,
  p_admin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft_id uuid;
  v_draft_updated_at timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:' || p_doc_type, 0::bigint)
  );
  select id, updated_at
    into v_draft_id, v_draft_updated_at
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'draft'
   for update;
  return public.admin_publish_legal(
    p_doc_type,
    p_effective_date,
    p_admin_id,
    gen_random_uuid(),
    v_draft_id,
    v_draft_updated_at
  );
end;
$$;

create or replace function public.admin_unpublish_legal(
  p_doc_type text,
  p_admin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date :=
    (clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_reservation_id uuid;
  v_reservation_version int;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:' || p_doc_type, 0::bigint)
  );
  select id, version
    into v_reservation_id, v_reservation_version
    from public.legal_documents
   where doc_type = p_doc_type
     and status = 'published'
     and effective_date > v_today
   order by effective_date asc, version asc, id asc
   limit 1
   for update;
  return public.admin_unpublish_legal(
    p_doc_type,
    p_admin_id,
    gen_random_uuid(),
    v_reservation_id,
    v_reservation_version
  );
end;
$$;

-- The server keeps SELECT for pages/gates; every mutation is RPC-only.
revoke insert, update, delete on table public.legal_documents
  from service_role;
revoke insert, update, delete on table public.legal_documents_audit
  from service_role;

revoke all on function public.admin_save_legal_draft(
  text, text, jsonb, text, text, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_legal_draft(
  text, text, jsonb, text, text, uuid, uuid, timestamptz
) to service_role;
revoke all on function public.admin_publish_legal(
  text, date, uuid, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.admin_publish_legal(
  text, date, uuid, uuid, uuid, timestamptz
) to service_role;
revoke all on function public.admin_unpublish_legal(
  text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.admin_unpublish_legal(
  text, uuid, uuid, uuid, integer
) to service_role;

-- Legacy wrappers remain service-only during rolling deployment.
revoke all on function public.admin_save_legal_draft(
  text, text, jsonb, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_legal_draft(
  text, text, jsonb, text, text, uuid
) to service_role;
revoke all on function public.admin_publish_legal(text, date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_publish_legal(text, date, uuid)
  to service_role;
revoke all on function public.admin_unpublish_legal(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_unpublish_legal(text, uuid)
  to service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)',
    'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)',
    'public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      raise exception '0081 postflight: function missing (%)', v_signature;
    end if;
    if not has_function_privilege(
      'service_role',
      to_regprocedure(v_signature),
      'EXECUTE'
    )
       or has_function_privilege(
         'anon',
         to_regprocedure(v_signature),
         'EXECUTE'
       )
       or has_function_privilege(
         'authenticated',
         to_regprocedure(v_signature),
         'EXECUTE'
       ) then
      raise exception '0081 postflight: function ACL drift (%)', v_signature;
    end if;
  end loop;

  if has_table_privilege(
       'service_role',
       'public.legal_documents',
       'INSERT'
     )
     or has_table_privilege(
       'service_role',
       'public.legal_documents',
       'UPDATE'
     )
     or has_table_privilege(
       'service_role',
       'public.legal_documents',
       'DELETE'
     )
     or has_table_privilege(
       'service_role',
       'public.legal_operation_receipts',
       'SELECT'
     ) then
    raise exception '0081 postflight: direct table mutation/receipt read leak';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0081_legal_state_machine_idempotency', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
