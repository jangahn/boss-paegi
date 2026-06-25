-- 0031: 신규 가입 동의 기록 + 익명→신규회원 데이터 명시 마이그레이션 RPC.
--
-- 로그인/회원가입 분리: OAuth 는 항상 signInWithOAuth(단일 프롬프트). 익명으로 놀던 사용자가
--   "신규 가입"하면 그 익명 user 의 데이터를 새 회원 id 로 재-own(linkIdentity 미사용).
-- additive·무중단.

-- ── 1. 가입 동의 근거(timestamp/version) — DOB/나이는 저장 안 함 ──────
alter table public.member_accounts add column if not exists terms_agreed_at timestamptz;
alter table public.member_accounts add column if not exists privacy_agreed_at timestamptz;
alter table public.member_accounts add column if not exists terms_version int;     -- 동의 시점 발행본(없으면 null)
alter table public.member_accounts add column if not exists privacy_version int;

-- ── 2. 익명 데이터 재-own RPC — 신규 가입 onboard 에서만 호출(서버 검증 후) ──
--   이동 대상: scores·user_badges·telemetry_sessions(owner_id). score_stats/score_highlights 는
--   score_id 캐스케이드라 자동. dolls/payapp_orders/ai_generations 은 익명 불가 → 미대상.
--   재시도 안전(멱등): user_badges 는 new 가 이미 가진 badge 와 PK(owner_id,badge_id) 충돌 →
--   not exists 인 것만 이동 후 old 잔여(중복) 삭제.
create or replace function public.reassign_anon_data(p_old uuid, p_new uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_scores int; v_badges int; v_tel int;
begin
  if p_old is null or p_new is null or p_old = p_new then
    raise exception 'invalid_args';
  end if;

  update public.scores set owner_id = p_new where owner_id = p_old;
  get diagnostics v_scores = row_count;

  update public.user_badges ub set owner_id = p_new
   where ub.owner_id = p_old
     and not exists (
       select 1 from public.user_badges x
       where x.owner_id = p_new and x.badge_id = ub.badge_id
     );
  get diagnostics v_badges = row_count;
  delete from public.user_badges where owner_id = p_old;  -- 이동 못 한 중복분 정리

  update public.telemetry_sessions set owner_id = p_new where owner_id = p_old;
  get diagnostics v_tel = row_count;

  return jsonb_build_object('ok', true, 'scores', v_scores, 'badges', v_badges, 'telemetry', v_tel);
end; $$;
revoke all on function public.reassign_anon_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reassign_anon_data(uuid, uuid) to service_role;
