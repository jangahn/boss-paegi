-- 0028: 텔레메트리 유지보수 RPC — 롤업(KST·최근 N일 delete-재계산) + prune(30일 timeline null·target 초과 삭제) + budget_refresh.
--
-- cron(app/api/ops/telemetry-maintain, x-cron-secret)이 순서대로 호출: rollup → (성공 시) prune → budget_refresh.
-- 전부 security definer + search_path 고정 + execute service_role 만. 0027(테이블) 위에서 동작.

-- ── 롤업: KST 각 대상일 delete 후 telemetry_sessions(summary)에서 재집계(late flush 안전) ──
create or replace function public.telemetry_rollup_days(p_days int default 3)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_rows int := 0;
  i int;
begin
  for i in 0 .. greatest(0, p_days - 1) loop
    v_d := v_today - i;
    v_lo := (v_d::timestamp at time zone 'Asia/Seoul');
    v_hi := ((v_d + 1)::timestamp at time zone 'Asia/Seoul');

    delete from public.telemetry_rollups where day_kst = v_d;

    -- 무기 차원(weapon_summary 의 key 별 — 익명·회원 모두)
    insert into public.telemetry_rollups(day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a, updated_at)
    select v_d, 'weapon', e.key,
      count(distinct s.id),
      coalesce(sum((e.value->>'hits')::numeric), 0),
      coalesce(sum((e.value->>'score')::numeric), 0),
      coalesce(sum((e.value->>'attempts')::numeric), 0),
      coalesce(sum((e.value->>'switches')::numeric), 0),
      0, now()
    from public.telemetry_sessions s, lateral jsonb_each(s.weapon_summary) e
    where s.started_at >= v_lo and s.started_at < v_hi
    group by e.key;

    -- 맵 차원(map_summary)
    insert into public.telemetry_rollups(day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a, updated_at)
    select v_d, 'map', e.key,
      count(distinct s.id),
      coalesce(sum((e.value->>'hits')::numeric), 0),
      coalesce(sum((e.value->>'score')::numeric), 0),
      coalesce(sum((e.value->>'attempts')::numeric), 0),
      coalesce(sum((e.value->>'switches')::numeric), 0),
      0, now()
    from public.telemetry_sessions s, lateral jsonb_each(s.map_summary) e
    where s.started_at >= v_lo and s.started_at < v_hi
    group by e.key;

    -- 펀널 단계(세션 카운트만 — sessions 컬럼) + 단일맵 고착률/전환율 measure_a
    insert into public.telemetry_rollups(day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a, updated_at)
    select v_d, 'funnel_step', step, cnt, 0, 0, 0, 0, 0, now()
    from (
      select 'entered' as step, count(*) as cnt from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi
      union all select 'first_hit', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and first_hit_ms is not null
      union all select 'first_switch', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and first_switch_ms is not null
      union all select 'first_ult', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and first_ult_ms is not null
      union all select 'completed', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and end_reason = 'normal'
      union all select 'forced', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and end_reason in ('time_limit','score_limit')
      union all select 'abandoned', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and end_reason in ('abandon','reload','hidden_timeout')
      union all select 'multi_map', count(*) from public.telemetry_sessions where started_at >= v_lo and started_at < v_hi and distinct_maps >= 2
    ) f;

    get diagnostics v_rows = row_count;
  end loop;
  return jsonb_build_object('ok', true, 'days', p_days);
end; $$;

revoke all on function public.telemetry_rollup_days(int) from public, anon, authenticated;
grant execute on function public.telemetry_rollup_days(int) to service_role;

-- ── prune: 30일 지난 timeline NULL화 → 오래된 익명 삭제 → target 초과 시 우선순위 삭제(롤업 선행 전제) ──
create or replace function public.telemetry_prune()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_retention_days int := 30;
  c_target_bytes bigint := 31457280;  -- 30MB 운영 target
  c_batch int := 2000;
  v_cutoff timestamptz := now() - (c_retention_days || ' days')::interval;
  v_timeline_nulled int := 0;
  v_anon_deleted int := 0;
  v_over_deleted int := 0;
  v_size bigint;
begin
  -- 1) 30일 지난 timeline NULL화(요약·롤업 보존)
  update public.telemetry_sessions set timeline = null, timeline_dropped = true
    where timeline is not null and started_at < v_cutoff;
  get diagnostics v_timeline_nulled = row_count;

  -- 2) 30일 지난 익명 세션 삭제(롤업이 집계 보존)
  delete from public.telemetry_sessions where is_anon and started_at < v_cutoff;
  get diagnostics v_anon_deleted = row_count;

  -- 3) target 초과 시 우선순위 배치 삭제: 익명 → 미연결 회원 → 연결 회원, 오래된 순
  v_size := pg_total_relation_size('public.telemetry_sessions');
  if v_size > c_target_bytes then
    delete from public.telemetry_sessions where id in (
      select s.id from public.telemetry_sessions s
      left join public.scores sc on sc.telemetry_session_id = s.id
      order by (case when s.is_anon then 0 when sc.id is null then 1 else 2 end), s.started_at asc
      limit c_batch
    );
    get diagnostics v_over_deleted = row_count;
  end if;

  return jsonb_build_object('ok', true, 'timeline_nulled', v_timeline_nulled,
    'anon_deleted', v_anon_deleted, 'over_budget_deleted', v_over_deleted, 'bytes', v_size);
end; $$;

revoke all on function public.telemetry_prune() from public, anon, authenticated;
grant execute on function public.telemetry_prune() to service_role;

-- ── budget_refresh: 크기 기준 over_budget·degrade_mode 갱신 + day rollover ──
create or replace function public.telemetry_budget_refresh()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_target_bytes bigint := 31457280;  -- 30MB
  v_size bigint := pg_total_relation_size('public.telemetry_sessions');
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_mode text;
begin
  v_mode := case
    when v_size > c_target_bytes * 1.5 then 'off'
    when v_size > c_target_bytes then 'summary'
    else 'full'
  end;
  insert into public.telemetry_budget(id) values (true) on conflict (id) do nothing;
  update public.telemetry_budget set
    over_budget = (v_size > c_target_bytes),
    degrade_mode = v_mode,
    day_kst = case when day_kst is distinct from v_today then v_today else day_kst end,
    new_sessions_today = case when day_kst is distinct from v_today then 0 else new_sessions_today end,
    updated_at = now()
  where id = true;
  return jsonb_build_object('ok', true, 'bytes', v_size, 'degrade_mode', v_mode);
end; $$;

revoke all on function public.telemetry_budget_refresh() from public, anon, authenticated;
grant execute on function public.telemetry_budget_refresh() to service_role;
