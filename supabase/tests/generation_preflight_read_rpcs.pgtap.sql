-- generation_preflight_read_rpcs.pgtap.sql — 0118 서버 주도 continuation 읽기 RPC 계약.
--
-- 핵심 단언: generation_preflight_reservations 는 여전히 service_role 직접 접근 불가(008901 불변)이고,
-- 읽기는 service_role 전용 SECURITY DEFINER RPC 3종으로만 한다. 미존재/빈 창은 ok 응답으로 닫힌다.
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(11);

-- ── ACL: 테이블은 여전히 닫혀 있고 RPC 만 열린다 ────────────────────────────
select ok(
  not has_table_privilege('service_role', 'public.generation_preflight_reservations', 'SELECT'),
  'service role still cannot read the reservations table directly (008901 posture)'
);
select ok(
  has_function_privilege('service_role', 'public.read_generation_preflight_for_continuation(uuid)', 'EXECUTE'),
  'service role can read one reservation for continuation'
);
select ok(
  has_function_privilege('service_role', 'public.list_generation_preflight_continuations(integer, integer, integer)', 'EXECUTE'),
  'service role can list continuation candidates'
);
select ok(
  has_function_privilege('service_role', 'public.list_stale_generation_preflight_owners(integer, integer)', 'EXECUTE'),
  'service role can list stale reservation owners'
);
select ok(
  not has_function_privilege('anon', 'public.read_generation_preflight_for_continuation(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.read_generation_preflight_for_continuation(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_generation_preflight_continuations(integer, integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_generation_preflight_continuations(integer, integer, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_stale_generation_preflight_owners(integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_stale_generation_preflight_owners(integer, integer)', 'EXECUTE'),
  'browser roles cannot execute the read RPCs'
);

-- ── Behaviour on empty/unknown input ─────────────────────────────────────────
select is(
  public.read_generation_preflight_for_continuation(null),
  '{"ok": false, "error": "request_id_required"}'::jsonb,
  'null request id is rejected without touching the table'
);
select is(
  public.read_generation_preflight_for_continuation('00000000-0000-4000-8000-000000000000'::uuid),
  '{"ok": true, "found": false}'::jsonb,
  'unknown reservation reads as found=false'
);
select is(
  public.list_generation_preflight_continuations(60, 1800, 3),
  '[]'::jsonb,
  'empty continuation window is an empty array'
);
select is(
  public.list_generation_preflight_continuations(null, null, null),
  '[]'::jsonb,
  'null bounds collapse to an empty window instead of erroring'
);
select is(
  public.list_stale_generation_preflight_owners(600, 10),
  '[]'::jsonb,
  'no stale owners is an empty array'
);
select is(
  public.list_stale_generation_preflight_owners(null, null),
  '[]'::jsonb,
  'null stale bounds are safe'
);

select * from finish();
rollback;
