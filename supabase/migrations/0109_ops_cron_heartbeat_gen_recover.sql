-- 0109: ops_cron_heartbeat 허용 잡에 gen-recover 추가 — 이웃 cron 침묵 감시(v1.02).
-- reconcile/gen-recover(5분)·credit-expire(일 1회)가 서로의 last_started_at 을 확인해,
-- 잡 삭제·비활성처럼 "스스로 알릴 수 없는 침묵"을 ops.cron_heartbeat_stale(error) 로 승격한다.
-- (2026-08-28 점검: gen-recover 는 DB 심박 자체가 없어 침묵 감지 수단이 전무했다.)
-- 0062 원본 함수의 job 허용 목록만 확장 — 그 외 로직·권한 불변.

-- 0062 는 테이블 CHECK(job_name in (...))로도 잡을 제한한다 — 함수와 같은 목록으로 확장.
alter table public.ops_cron_heartbeats
  drop constraint ops_cron_heartbeats_job_name_check;
alter table public.ops_cron_heartbeats
  add constraint ops_cron_heartbeats_job_name_check
  check (job_name in ('credit-expire', 'reconcile', 'gen-recover'));

create or replace function public.ops_cron_heartbeat(p_job text, p_phase text, p_error_code text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job not in ('credit-expire', 'reconcile', 'gen-recover') then raise exception 'invalid_job' using errcode = 'P0001'; end if;
  if p_phase not in ('start', 'success', 'failure') then raise exception 'invalid_phase' using errcode = 'P0001'; end if;
  insert into public.ops_cron_heartbeats (job_name, last_started_at, run_count)
  values (p_job, case when p_phase = 'start' then now() end, case when p_phase = 'start' then 1 else 0 end)
  on conflict (job_name) do update set
    last_started_at   = case when p_phase = 'start'   then now() else public.ops_cron_heartbeats.last_started_at end,
    last_succeeded_at = case when p_phase = 'success' then now() else public.ops_cron_heartbeats.last_succeeded_at end,
    last_failed_at    = case when p_phase = 'failure' then now() else public.ops_cron_heartbeats.last_failed_at end,
    last_error_code   = case when p_phase = 'failure' then p_error_code else public.ops_cron_heartbeats.last_error_code end,
    run_count         = public.ops_cron_heartbeats.run_count + case when p_phase = 'start' then 1 else 0 end;
end;
$$;
revoke all on function public.ops_cron_heartbeat(text, text, text) from public, anon, authenticated;
grant execute on function public.ops_cron_heartbeat(text, text, text) to service_role;
