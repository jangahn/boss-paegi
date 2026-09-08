-- gender_axis.pgtap.sql — 0121/0122 캐릭터 성별 축 DB 계약.
--
-- 단언: ① ai_generations.gender / dolls.gender 컬럼(NOT NULL DEFAULT 'male', male|female CHECK)
--       ② 얼굴검사 체크 어휘에 gender(intents·cost_attempts CHECK, claim allowlist), prepare 는 정확히 5 intent(0122)
--       ③ admin_update_doll_gender_idempotent — receipt 재생(idempotent)·noOp·dolls.version CAS·어휘·권한
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(23);

-- ── 픽스처: 관리자 1 + 소유자 1 + doll 1 ───────────────────────────────────
create temporary table gender_ctx (
  admin_id uuid not null default gen_random_uuid(),
  owner_id uuid not null default gen_random_uuid(),
  doll_id uuid not null default gen_random_uuid(),
  request_id uuid not null default gen_random_uuid(),
  request_id_2 uuid not null default gen_random_uuid(),
  request_id_3 uuid not null default gen_random_uuid()
) on commit drop;
insert into gender_ctx default values;

insert into auth.users (id, email)
select admin_id, 'gender-admin-' || admin_id || '@test.local' from gender_ctx
union all
select owner_id, 'gender-owner-' || owner_id || '@test.local' from gender_ctx;

insert into public.profiles (id, display_name)
select admin_id, '성별 축 관리자' from gender_ctx
on conflict (id) do update set display_name = excluded.display_name;
insert into public.profiles (id, display_name)
select owner_id, '성별 축 소유자' from gender_ctx
on conflict (id) do update set display_name = excluded.display_name;

insert into public.member_accounts (user_id, gen_credits, is_admin)
select admin_id, 0, true from gender_ctx
on conflict (user_id) do update set is_admin = excluded.is_admin;

insert into public.dolls (id, owner_id, image_url, role)
select doll_id, owner_id, 'dolls/gender/' || owner_id || '/' || doll_id || '.png', 'boss' from gender_ctx;

-- ── ① 컬럼 계약 ────────────────────────────────────────────────────────────
select col_not_null('public', 'dolls', 'gender', 'dolls.gender is NOT NULL');
select col_default_is('public', 'dolls', 'gender', 'male', 'dolls.gender defaults to male (legacy backfill)');
select col_not_null('public', 'ai_generations', 'gender', 'ai_generations.gender is NOT NULL');
select col_default_is('public', 'ai_generations', 'gender', 'male', 'ai_generations.gender defaults to male');
select is(
  (select d.gender from public.dolls d join gender_ctx c on c.doll_id = d.id),
  'male',
  'a doll inserted without gender is male'
);
select throws_ok(
  $$update public.dolls d set gender = 'other' from gender_ctx c where d.id = c.doll_id$$,
  '23514',
  null,
  'dolls.gender rejects values outside male/female'
);
select throws_ok(
  $$insert into public.ai_generations (owner_id, status, role, gender)
    select owner_id, 'queued', 'boss', 'unknown' from gender_ctx$$,
  '23514',
  null,
  'ai_generations.gender rejects unknown (converged to male before storage)'
);

-- ── ② 얼굴검사 체크 어휘 ─────────────────────────────────────────────────────
select ok(
  (
    select bool_and(pg_get_constraintdef(c.oid) like '%''gender''%')
      from pg_constraint c
     where c.conname in (
       'generation_face_check_intents_check_key_check',
       'generation_face_check_cost_attempts_check_key_check'
     )
  )
  and (
    select count(*) = 2 from pg_constraint c
     where c.conname in (
       'generation_face_check_intents_check_key_check',
       'generation_face_check_cost_attempts_check_key_check'
     )
  ),
  'face-check CHECK constraints admit the gender check key'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.claim_generation_face_check(uuid,uuid,uuid,text)'::regprocedure),
    $needle$p_check_key not in ('face', 'count', 'covered', 'glasses', 'gender')$needle$
  ) > 0,
  'claim_generation_face_check allowlist includes gender'
);
select throws_ok(
  $$select public.claim_generation_face_check(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'age')$$,
  '22023',
  null,
  'claim_generation_face_check rejects an unknown check key'
);
-- 0122 contract: prepare 는 정확히 5 intent (4개는 예약 조회 전에 거절).
select throws_ok(
  $$select public.prepare_generation_face_checks(
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, 'default', null, false,
      '[{"check_key":"face"},{"check_key":"count"},{"check_key":"covered"},{"check_key":"glasses"}]'::jsonb)$$,
  '22023',
  null,
  'prepare_generation_face_checks rejects a four-check intent set after the contract'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.finalize_generation_face_checks(uuid,jsonb,text)'::regprocedure),
    $needle$when 5 then 'gender'$needle$
  ) > 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.finalize_generation_face_checks(uuid,jsonb,text)'::regprocedure),
    $needle$Is the person in this photo a man or a woman? Answer only man or woman.$needle$
  ) > 0,
  'finalize_generation_face_checks pins position 5 to the gender prompt'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.commit_generation_preflight(uuid,uuid,text,text,uuid,jsonb)'::regprocedure),
    $needle$analysis_result->>'gender' = 'female'$needle$
  ) > 0,
  'commit_generation_preflight derives ai_generations.gender from the face analysis'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.commit_generation_pick(uuid,uuid,integer,uuid,uuid,text)'::regprocedure),
    $needle$v_doll.gender <> v_generation.gender$needle$
  ) > 0,
  'commit_generation_pick copies and verifies the generation gender on the doll'
);

-- ── ③ 어드민 후처리 RPC ─────────────────────────────────────────────────────
select is(
  (
    select (r->>'nextGender', (r->>'noOp')::boolean, (r->>'idempotent')::boolean, (r->>'version')::integer)::text
      from gender_ctx c,
      lateral public.admin_update_doll_gender_idempotent(c.admin_id, c.doll_id, 'female', 1, c.request_id) r
  ),
  ('female', false, false, 2)::text,
  'admin gender update flips the doll to female and bumps dolls.version'
);
select is(
  (select d.gender from public.dolls d join gender_ctx c on c.doll_id = d.id),
  'female',
  'dolls.gender persisted'
);
select is(
  (
    select (r->>'nextGender', (r->>'noOp')::boolean, (r->>'idempotent')::boolean)::text
      from gender_ctx c,
      lateral public.admin_update_doll_gender_idempotent(c.admin_id, c.doll_id, 'female', 1, c.request_id) r
  ),
  ('female', false, true)::text,
  'replaying the same request id returns the stored receipt as idempotent'
);
select throws_ok(
  $$select public.admin_update_doll_gender_idempotent(c.admin_id, c.doll_id, 'male', 1, c.request_id_2) from gender_ctx c$$,
  'P0001',
  'state_conflict',
  'a stale dolls.version is rejected (CAS)'
);
select is(
  (
    select (r->>'nextGender', (r->>'noOp')::boolean, (r->>'version')::integer)::text
      from gender_ctx c,
      lateral public.admin_update_doll_gender_idempotent(c.admin_id, c.doll_id, 'female', 2, c.request_id_3) r
  ),
  ('female', true, 2)::text,
  'setting the current gender again is a noOp without a version bump'
);
select throws_ok(
  $$select public.admin_update_doll_gender_idempotent(c.admin_id, c.doll_id, 'other', 2, gen_random_uuid()) from gender_ctx c$$,
  'P0001',
  'gender_invalid',
  'the admin RPC rejects values outside male/female'
);
select throws_ok(
  $$select public.admin_update_doll_gender_idempotent(c.owner_id, c.doll_id, 'male', 2, gen_random_uuid()) from gender_ctx c$$,
  'P0001',
  'not_admin',
  'a non-admin caller is rejected'
);
select ok(
  not has_function_privilege('anon', 'public.admin_update_doll_gender_idempotent(uuid,uuid,text,integer,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_update_doll_gender_idempotent(uuid,uuid,text,integer,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_update_doll_gender_idempotent(uuid,uuid,text,integer,uuid)', 'EXECUTE'),
  'admin gender RPC is service_role only'
);
select is(
  (
    select r.operation from public.admin_mutation_requests r join gender_ctx c on c.request_id = r.request_id
  ),
  'doll_gender_update',
  'receipt stored under the doll_gender_update operation'
);

select * from finish();
rollback;
