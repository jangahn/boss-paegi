-- 0081 legal state-machine contract. Cross-session lock ordering is covered by
-- scripts/qa/test-legal-state-machine-race.sh.

begin;
select plan(60);

-- Catalog, security boundary, and lock discipline.
select has_table(
  'public',
  'legal_operation_receipts',
  'legal operation receipt table exists'
);
select is(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'public.legal_operation_receipts'::regclass
  ),
  true,
  'receipt table has RLS enabled'
);
select has_column(
  'public',
  'legal_operation_receipts',
  'request_payload',
  'receipt retains the exact canonical request'
);
select is(
  (
    select count(*)::int
      from pg_catalog.pg_attribute
     where attrelid = 'public.legal_operation_receipts'::regclass
       and attname = 'request_hash'
       and not attisdropped
  ),
  0,
  'receipt correctness does not depend on a collision-prone digest'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.legal_operation_receipts',
    'SELECT'
  ),
  'service role cannot inspect legal receipts directly'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.legal_documents',
    'INSERT'
  ),
  'service role cannot bypass save/publish with direct insert'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.legal_documents',
    'UPDATE'
  ),
  'service role cannot bypass CAS with direct update'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.legal_documents',
    'DELETE'
  ),
  'service role cannot bypass unpublish with direct delete'
);
select has_function(
  'public',
  'admin_save_legal_draft',
  array[
    'text',
    'text',
    'jsonb',
    'text',
    'text',
    'uuid',
    'uuid',
    'timestamp with time zone'
  ],
  'strict draft-save overload exists'
);
select has_function(
  'public',
  'admin_publish_legal',
  array[
    'text',
    'date',
    'uuid',
    'uuid',
    'uuid',
    'timestamp with time zone'
  ],
  'strict publish overload exists'
);
select has_function(
  'public',
  'admin_unpublish_legal',
  array['text', 'uuid', 'uuid', 'uuid', 'integer'],
  'strict unpublish overload exists'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)'::regprocedure
  ),
  'strict draft save is SECURITY DEFINER'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)'::regprocedure
  ),
  'strict publish is SECURITY DEFINER'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)'::regprocedure
  ),
  'strict unpublish is SECURITY DEFINER'
);
select ok(
  (
    select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)'::regprocedure
  ),
  'strict draft save pins an empty search_path'
);
select ok(
  (
    select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)'::regprocedure
  ),
  'strict publish pins an empty search_path'
);
select ok(
  (
    select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)'::regprocedure
  ),
  'strict unpublish pins an empty search_path'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  'service role can call strict draft save'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  'anon cannot call strict draft save'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  'authenticated cannot call strict publish'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_legal_operation_replay(uuid,text,text,jsonb,uuid)',
    'EXECUTE'
  ),
  'receipt replay helper is not externally callable'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)'::regprocedure
    )
  ),
  'pg_advisory_xact_lock',
  'draft save takes the legal document lock'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)'::regprocedure
    )
  ),
  'pg_advisory_xact_lock',
  'publish takes the same legal document lock family'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)'::regprocedure
    )
  ),
  'pg_advisory_xact_lock',
  'unpublish takes the same legal document lock family'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.bp_legal_operation_replay(uuid,text,text,jsonb,uuid)'::regprocedure
    )
  ),
  'legal-operation:',
  'operation UUID reuse is globally serialized'
);

create temporary table legal_ctx (
  admin_id uuid not null,
  draft_id uuid,
  base_one timestamptz,
  base_two timestamptz,
  op_save_one uuid not null,
  op_save_two uuid not null,
  op_publish uuid not null,
  op_future_save uuid not null,
  op_future_publish uuid not null,
  op_unpublish uuid not null,
  first_save jsonb,
  first_replay jsonb,
  second_save jsonb,
  published jsonb,
  publish_replay jsonb,
  future_save jsonb,
  future_publish jsonb,
  unpublished jsonb,
  unpublish_replay jsonb
) on commit drop;

do $fixture$
declare
  v_admin uuid := gen_random_uuid();
begin
  -- Isolate one document type inside this rollback-only transaction.
  delete from public.legal_operation_receipts where doc_type = 'terms';
  delete from public.legal_documents_audit where doc_type = 'terms';
  delete from public.legal_documents where doc_type = 'terms';

  insert into auth.users(id, email)
  values (v_admin, 'legal-state-machine@example.test');
  insert into public.member_accounts(user_id, gen_credits, is_admin)
  values (v_admin, 0, true)
  on conflict (user_id) do update set is_admin = true;

  insert into legal_ctx(
    admin_id,
    op_save_one,
    op_save_two,
    op_publish,
    op_future_save,
    op_future_publish,
    op_unpublish
  )
  values (
    v_admin,
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid()
  );
end;
$fixture$;

update legal_ctx c
   set first_save = public.admin_save_legal_draft(
     'terms',
     'Terms draft one',
     '[{"heading":"Purpose","body":"First body"}]'::jsonb,
     'first public note',
     'first admin note',
     c.admin_id,
     c.op_save_one,
     null
   );
update legal_ctx
   set draft_id = (first_save->>'draft_id')::uuid,
       base_one = (first_save->>'draft_updated_at')::timestamptz;

select is(first_save->>'ok', 'true', 'first strict draft save succeeds')
  from legal_ctx;
select is(
  (
    select count(*)::int
      from public.legal_documents d
      join legal_ctx c on c.draft_id = d.id
     where d.doc_type = 'terms'
       and d.status = 'draft'
       and d.updated_at = c.base_one
  ),
  1,
  'save response identifies the exact committed draft revision'
);
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_draft_saved'
  ),
  1,
  'first save appends one audit row'
);

update legal_ctx c
   set first_replay = public.admin_save_legal_draft(
     'terms',
     'Terms draft one',
     '[{"heading":"Purpose","body":"First body"}]'::jsonb,
     'first public note',
     'first admin note',
     c.admin_id,
     c.op_save_one,
     null
   );
select is(first_replay, first_save, 'lost save response replays verbatim')
  from legal_ctx;
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_draft_saved'
  ),
  1,
  'save replay does not duplicate its audit row'
);
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Different body',
        '[{"heading":"Purpose","body":"First body"}]'::jsonb,
        'first public note',
        'first admin note',
        %L::uuid,
        %L::uuid,
        null
      )
    $sql$,
    admin_id,
    op_save_one
  ),
  'P0001',
  'request_conflict',
  'same operation UUID cannot be reused for a different request'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Stale save',
        '[{"heading":"Purpose","body":"Stale"}]'::jsonb,
        null,
        null,
        %L::uuid,
        %L::uuid,
        null
      )
    $sql$,
    admin_id,
    gen_random_uuid()
  ),
  'P0001',
  'version_conflict',
  'an existing draft cannot be overwritten with a missing base revision'
) from legal_ctx;

update legal_ctx c
   set second_save = public.admin_save_legal_draft(
     'terms',
     'Terms draft two',
     '[{"heading":"Purpose","body":"Second body"}]'::jsonb,
     'second public note',
     'second admin note',
     c.admin_id,
     c.op_save_two,
     c.base_one
   );
update legal_ctx
   set base_two = (second_save->>'draft_updated_at')::timestamptz;

select is(
  (
    select d.title
      from public.legal_documents d
      join legal_ctx c on c.draft_id = d.id
  ),
  'Terms draft two',
  'exact-base save updates the existing draft'
);
select is(
  (
    select (d.updated_at = c.base_two)::text
      from public.legal_documents d
      join legal_ctx c on c.draft_id = d.id
  ),
  'true',
  'updated save returns its exact new CAS timestamp'
);
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_draft_saved'
  ),
  2,
  'a distinct committed save appends exactly one audit row'
);
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Old editor save',
        '[{"heading":"Purpose","body":"Old editor"}]'::jsonb,
        null,
        null,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    admin_id,
    gen_random_uuid(),
    base_one
  ),
  'P0001',
  'version_conflict',
  'an old editor revision cannot overwrite a newer save'
) from legal_ctx;

update legal_ctx c
   set published = public.admin_publish_legal(
     'terms',
     (clock_timestamp() at time zone 'Asia/Seoul')::date,
     c.admin_id,
     c.op_publish,
     c.draft_id,
     c.base_two
   );
select is(published->>'ok', 'true', 'publish consumes the exact saved draft')
  from legal_ctx;
select is(
  (select count(*)::int from public.legal_documents
    where doc_type = 'terms' and status = 'draft'),
  0,
  'publish consumes the draft'
);
select is(
  (
    select count(*)::int
      from public.legal_documents d
      join legal_ctx c
        on d.id = (c.published->>'published_id')::uuid
       and d.version = (c.published->>'version')::int
     where d.doc_type = 'terms'
       and d.status = 'published'
  ),
  1,
  'publish response identifies the committed published version'
);
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_published'
  ),
  1,
  'publish appends one audit row'
);
update legal_ctx c
   set publish_replay = public.admin_publish_legal(
     'terms',
     (clock_timestamp() at time zone 'Asia/Seoul')::date,
     c.admin_id,
     c.op_publish,
     c.draft_id,
     c.base_two
   );
select is(
  publish_replay,
  published,
  'lost publish response replays after the draft was consumed'
) from legal_ctx;
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_published'
  ),
  1,
  'publish replay does not duplicate its audit row'
);
select throws_ok(
  format(
    $sql$
      select public.admin_publish_legal(
        'terms',
        ((clock_timestamp() at time zone 'Asia/Seoul')::date + 1),
        %L::uuid,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    admin_id,
    op_publish,
    draft_id,
    base_two
  ),
  'P0001',
  'request_conflict',
  'publish operation UUID cannot be reused with a changed effective date'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_publish_legal(
        'terms',
        (clock_timestamp() at time zone 'Asia/Seoul')::date,
        %L::uuid,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    admin_id,
    gen_random_uuid(),
    draft_id,
    base_two
  ),
  'P0001',
  'no_draft',
  'a new operation cannot mistake a completed publish for an uncommitted one'
) from legal_ctx;

update legal_ctx c
   set future_save = public.admin_save_legal_draft(
     'terms',
     'Future terms',
     '[{"heading":"Future","body":"Future body"}]'::jsonb,
     'future public note',
     null,
     c.admin_id,
     c.op_future_save,
     null
   );
select is(future_save->>'ok', 'true', 'a fresh draft can follow a publish')
  from legal_ctx;
update legal_ctx c
   set future_publish = public.admin_publish_legal(
     'terms',
     ((clock_timestamp() at time zone 'Asia/Seoul')::date + 31),
     c.admin_id,
     c.op_future_publish,
     (c.future_save->>'draft_id')::uuid,
     (c.future_save->>'draft_updated_at')::timestamptz
   );
select is(
  future_publish->>'ok',
  'true',
  'future effective date creates a cancellable reservation'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_unpublish_legal(
        'terms',
        %L::uuid,
        %L::uuid,
        %L::uuid,
        %L::integer
      )
    $sql$,
    admin_id,
    gen_random_uuid(),
    (future_publish->>'published_id')::uuid,
    (future_publish->>'version')::int + 1
  ),
  'P0001',
  'version_conflict',
  'stale reservation version cannot cancel a different version'
) from legal_ctx;

update legal_ctx c
   set unpublished = public.admin_unpublish_legal(
     'terms',
     c.admin_id,
     c.op_unpublish,
     (c.future_publish->>'published_id')::uuid,
     (c.future_publish->>'version')::int
   );
select is(
  unpublished->>'restored_draft',
  'true',
  'unpublish restores a draft when none exists'
) from legal_ctx;
select is(
  (
    select count(*)::int
      from public.legal_documents d
      join legal_ctx c
        on d.title = 'Future terms'
     where d.doc_type = 'terms'
       and d.status = 'draft'
       and not exists (
         select 1
           from public.legal_documents r
          where r.id = (c.future_publish->>'published_id')::uuid
       )
  ),
  1,
  'unpublish atomically removes the reservation and restores its content'
);
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_unpublished'
  ),
  1,
  'unpublish appends one audit row'
);
update legal_ctx c
   set unpublish_replay = public.admin_unpublish_legal(
     'terms',
     c.admin_id,
     c.op_unpublish,
     (c.future_publish->>'published_id')::uuid,
     (c.future_publish->>'version')::int
   );
select is(
  unpublish_replay,
  unpublished,
  'lost unpublish response replays after reservation removal'
) from legal_ctx;
select is(
  (
    select count(*)::int
      from public.legal_documents_audit
     where doc_type = 'terms'
       and action = 'legal_unpublished'
  ),
  1,
  'unpublish replay does not duplicate its audit row'
);
select throws_ok(
  format(
    $sql$
      select public.admin_unpublish_legal(
        'terms',
        %L::uuid,
        %L::uuid,
        %L::uuid,
        %L::integer
      )
    $sql$,
    admin_id,
    op_unpublish,
    gen_random_uuid(),
    (future_publish->>'version')::int
  ),
  'P0001',
  'request_conflict',
  'unpublish operation UUID cannot be reused for another reservation'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'No operation',
        '[{"heading":"No op","body":"Rejected"}]'::jsonb,
        null,
        null,
        %L::uuid,
        null,
        %L::timestamptz
      )
    $sql$,
    admin_id,
    (
      select updated_at
        from public.legal_documents
       where doc_type = 'terms'
         and status = 'draft'
    )
  ),
  'P0001',
  'operation_id_required',
  'strict mutations reject a missing operation UUID'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Not admin',
        '[{"heading":"No","body":"Not admin"}]'::jsonb,
        null,
        null,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    gen_random_uuid(),
    gen_random_uuid(),
    (
      select updated_at
        from public.legal_documents
       where doc_type = 'terms'
         and status = 'draft'
    )
  ),
  'P0001',
  'not_admin',
  'RPC revalidates active administrator status internally'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        null,
        'Null type',
        '[{"heading":"No","body":"Null type"}]'::jsonb,
        null,
        null,
        %L::uuid,
        %L::uuid,
        null
      )
    $sql$,
    admin_id,
    gen_random_uuid()
  ),
  'P0001',
  'invalid_doc_type',
  'null document type is rejected explicitly'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Null sections',
        null,
        null,
        null,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    admin_id,
    gen_random_uuid(),
    (
      select updated_at
        from public.legal_documents
       where doc_type = 'terms'
         and status = 'draft'
    )
  ),
  'P0001',
  'invalid_sections',
  'null sections are rejected explicitly'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Object sections',
        '{"heading":"not-an-array"}'::jsonb,
        null,
        null,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    admin_id,
    gen_random_uuid(),
    (
      select updated_at
        from public.legal_documents
       where doc_type = 'terms'
         and status = 'draft'
    )
  ),
  'P0001',
  'invalid_sections',
  'non-array sections are rejected without an internal JSON exception'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Long public note',
        '[{"heading":"No","body":"Long note"}]'::jsonb,
        %L,
        null,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    repeat('p', 1001),
    admin_id,
    gen_random_uuid(),
    (
      select updated_at
        from public.legal_documents
       where doc_type = 'terms'
         and status = 'draft'
    )
  ),
  'P0001',
  'invalid_public_note',
  'database rejects an oversized public note explicitly'
) from legal_ctx;
select throws_ok(
  format(
    $sql$
      select public.admin_save_legal_draft(
        'terms',
        'Long admin note',
        '[{"heading":"No","body":"Long note"}]'::jsonb,
        null,
        %L,
        %L::uuid,
        %L::uuid,
        %L::timestamptz
      )
    $sql$,
    repeat('a', 2001),
    admin_id,
    gen_random_uuid(),
    (
      select updated_at
        from public.legal_documents
       where doc_type = 'terms'
         and status = 'draft'
    )
  ),
  'P0001',
  'invalid_admin_note',
  'database rejects an oversized admin note explicitly'
) from legal_ctx;

select * from finish();
rollback;
