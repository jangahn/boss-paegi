-- roles_v2.pgtap.sql — 0120 롤 7종(boss·ceo·exec·teamlead·client·junior·friend) DB 어휘 계약.
--
-- 단언: ① 3테이블 CHECK 가 신규 3롤을 받고 coworker 를 거절한다
--       ② request_doll_role_update · claim_generation_preflight allowlist 가 같은 7종(구 coworker 거절)
--       ③ 리맵 뒤 coworker 행이 남지 않는다(백필 결과)
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(12);

create temporary table roles_v2_ctx (
  owner_id uuid not null default gen_random_uuid()
);
insert into roles_v2_ctx default values;

insert into auth.users (id, email)
select owner_id, 'roles-v2-' || owner_id || '@test.local' from roles_v2_ctx;

insert into public.profiles (id, display_name)
select owner_id, '롤 v2 픽스처' from roles_v2_ctx
on conflict (id) do update set display_name = excluded.display_name;

-- ── ① CHECK 제약 ──────────────────────────────────────────────────────────

select ok(
  (
    select bool_and(pg_get_constraintdef(c.oid) like '%''friend''%' and pg_get_constraintdef(c.oid) not like '%''coworker''%'
      and pg_get_constraintdef(c.oid) like '%''ceo''%' and pg_get_constraintdef(c.oid) like '%''junior''%')
    from pg_constraint c
    where c.conname in ('dolls_role_check', 'ai_generations_role_check', 'generation_preflight_reservations_role_check')
  )
  and (
    select count(*) = 3 from pg_constraint c
    where c.conname in ('dolls_role_check', 'ai_generations_role_check', 'generation_preflight_reservations_role_check')
  ),
  'all three role CHECK constraints admit the new roles and reject coworker'
);

select lives_ok(
  $$insert into public.dolls (owner_id, image_url, role)
    select owner_id, 'dolls/roles-v2/' || owner_id || '/ceo.png', 'ceo' from roles_v2_ctx$$,
  'dolls accepts role ceo'
);
select lives_ok(
  $$insert into public.dolls (owner_id, image_url, role)
    select owner_id, 'dolls/roles-v2/' || owner_id || '/junior.png', 'junior' from roles_v2_ctx$$,
  'dolls accepts role junior'
);
select lives_ok(
  $$insert into public.dolls (owner_id, image_url, role)
    select owner_id, 'dolls/roles-v2/' || owner_id || '/friend.png', 'friend' from roles_v2_ctx$$,
  'dolls accepts role friend'
);
select throws_ok(
  $$insert into public.dolls (owner_id, image_url, role)
    select owner_id, 'dolls/roles-v2/' || owner_id || '/coworker.png', 'coworker' from roles_v2_ctx$$,
  '23514',
  null,
  'dolls rejects the absorbed coworker role'
);
select throws_ok(
  $$insert into public.ai_generations (owner_id, status, role)
    select owner_id, 'queued', 'coworker' from roles_v2_ctx$$,
  '23514',
  null,
  'ai_generations rejects the absorbed coworker role'
);

-- ── ② 함수 allowlist ─────────────────────────────────────────────────────

select throws_ok(
  $$select public.request_doll_role_update(gen_random_uuid(), gen_random_uuid(), 'coworker')$$,
  'P0001',
  'invalid_role',
  'request_doll_role_update rejects coworker before any lookup'
);
select throws_ok(
  $$select public.request_doll_role_update(gen_random_uuid(), gen_random_uuid(), 'friend')$$,
  'P0001',
  'account_deleted',
  'request_doll_role_update accepts friend (fails only on the missing account, past the role check)'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.claim_generation_preflight(uuid,uuid,text,text,boolean,uuid)'::regprocedure),
    $needle$p_role not in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend')$needle$
  ) > 0,
  'claim_generation_preflight allowlist is the seven-role vocabulary'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.request_doll_role_update(uuid,uuid,text)'::regprocedure),
    'coworker'
  ) = 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.claim_generation_preflight(uuid,uuid,text,text,boolean,uuid)'::regprocedure),
    'coworker'
  ) = 0,
  'no role allowlist function still mentions coworker'
);

-- ── ③ 리맵 결과 ───────────────────────────────────────────────────────────

select is(
  (
    (select count(*) from public.dolls where role = 'coworker')
    + (select count(*) from public.ai_generations where role = 'coworker')
    + (select count(*) from public.generation_preflight_reservations where role = 'coworker')
  )::integer,
  0,
  'no coworker rows remain after the friend remap'
);

select is(
  (select count(*)::integer from public.dolls d join roles_v2_ctx c on c.owner_id = d.owner_id where d.role in ('ceo', 'junior', 'friend')),
  3,
  'the three new-role fixture dolls were stored'
);

select * from finish();
rollback;
