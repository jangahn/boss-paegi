-- 0058: 결제 프로바이더 페이앱 → 포트원(PortOne V2) 전환 — 주문 원장 일반화 + RPC 재정의.
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- 배경: 페이앱이 '게임 캐릭터 생성권' PG 계약을 거절 → 포트원(토스페이·KPN·카카오페이) 전환.
--   실결제(paid) 주문 0건 확인(canceled 20·failed 2 — 전부 dev 실결제→환불 테스트 이력)이라
--   병행 운영 없이 컷오버. 기존 rows 는 전자상거래법 5년 보존 대상이므로 유지(provider='payapp').
--
-- 변경 요약:
--   1) payapp_orders → orders 리네임(+ 제약/인덱스/트리거 접두사 정리).
--   2) 컬럼 일반화 — mul_no→pg_tx_id(프로바이더 거래번호), pay_state(int)→pg_status(text),
--      payurl 제거(포트원엔 재사용 결제창 URL 개념 없음), provider('payapp'|'portone') 추가,
--      payment_id 추가(가맹점 채번 포트원 paymentId — order_uuid 의 하이픈 제거 hex.
--      KPN 이 paymentId 에 영숫자만 허용해 UUID 원문 사용 불가).
--   3) refund_state 값 'payapp_done' → 'pg_done'(외부 PG 환불 확정 — 개념은 동일, 명칭만 중립화).
--   4) 웹훅 선도착 취소가 canceled_at 을 안 채우던 갭 — 기존 rows 백필 + 신규 웹훅 코드가 직접 채움.
--   5) RPC 재정의(테이블 참조·파라미터명) + mark_paid_and_grant 에 credit_ledger 'purchase' 기록 추가
--      (0047 에서 타입만 정의되고 미기록이던 갭 — 지급과 한 트랜잭션).

begin;

-- ── 1. 테이블 리네임 + 제약/인덱스/트리거 접두사 정리 ─────────────────
alter table public.payapp_orders rename to orders;

do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname like 'payapp\_orders\_%' escape '\'
  loop
    execute format('alter table public.orders rename constraint %I to %I',
                   r.conname, regexp_replace(r.conname, '^payapp_orders_', 'orders_'));
  end loop;
  for r in
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'orders'
      and indexname like 'idx\_payapp\_orders\_%' escape '\'
  loop
    execute format('alter index public.%I rename to %I',
                   r.indexname, regexp_replace(r.indexname, '^idx_payapp_orders_', 'idx_orders_'));
  end loop;
end $$;

alter trigger trg_payapp_orders_audit on public.orders rename to trg_orders_audit;

-- ── 2. 컬럼 일반화 ────────────────────────────────────────────────────
alter table public.orders rename column mul_no to pg_tx_id;      -- 페이앱 mul_no / 포트원 transactionId
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_mul_no_key') then
    alter table public.orders rename constraint orders_mul_no_key to orders_pg_tx_id_key;
  end if;
end $$;

alter table public.orders rename column pay_state to pg_status;  -- 마지막 프로바이더 상태(페이앱 숫자코드는 text 로 보존)
alter table public.orders alter column pg_status type text using pg_status::text;

alter table public.orders drop column if exists payurl;

alter table public.orders add column if not exists provider text;
update public.orders set provider = 'payapp' where provider is null;
alter table public.orders alter column provider set not null;
alter table public.orders add constraint orders_provider_check check (provider in ('payapp', 'portone'));

-- 포트원 paymentId — 가맹점 채번(= order_uuid 하이픈 제거). 레거시 페이앱 rows 는 null.
alter table public.orders add column if not exists payment_id text unique;

-- ── 3. refund_state 'payapp_done' → 'pg_done' ────────────────────────
alter table public.orders drop constraint if exists orders_refund_state_check;
alter table public.orders drop constraint if exists payapp_orders_refund_state_check;
update public.orders set refund_state = 'pg_done' where refund_state = 'payapp_done';
alter table public.orders add constraint orders_refund_state_check
  check (refund_state in ('in_progress', 'pg_done', 'done'));

-- ── 4. canceled_at 백필(웹훅 선도착 취소 갭 — 0057 폴백 정렬의 원인 해소) ──
update public.orders set canceled_at = updated_at where status = 'canceled' and canceled_at is null;

-- ── 5. RPC 재정의 ─────────────────────────────────────────────────────

-- 5.1 mark_paid_and_grant — 파라미터명 p_mul_no→p_pg_tx_id(호출부 named param), 테이블 참조 교체,
--     pg_status='PAID', credit_ledger 'purchase' 원자 기록 추가. 탈퇴자 가드(0030)는 동일 유지.
--     상태 가드는 pending|failed — 포트원 paymentId 는 "성공 전까지 재시도 가능"이라 failed 마킹
--     (실패 웹훅/대사 시효) 이후 같은 paymentId 로 결제가 성공할 수 있다. failed 는 준종단으로 두고
--     PAID 재검증(호출부가 단건 조회 후 호출)을 통과하면 부활 지급. 지급 1회 보장은 paid 전환이 담보
--     (paid/canceled 는 여전히 차단 — canceled 는 환불 플로우 소유).
drop function if exists public.mark_paid_and_grant(uuid, text, int, jsonb);
create function public.mark_paid_and_grant(
  p_order_uuid uuid, p_pg_tx_id text, p_price int, p_raw jsonb
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
  v_deleted boolean;
  v_balance int;
begin
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then return false; end if;
  if o.amount <> p_price then return false; end if;
  if o.status <> 'pending' and o.status <> 'failed' then return false; end if;

  select (p.deleted_at is not null) into v_deleted from public.profiles p where p.id = o.user_id;

  if coalesce(v_deleted, false) then
    update public.orders
       set status = 'paid', pg_status = 'PAID', paid_at = now(), raw = p_raw,
           pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id),
           error_message = 'account_deleted_no_grant'
     where order_uuid = p_order_uuid;
    return true;   -- 결제 기록은 보존, 크레딧 미지급. 웹훅 재시도 방지.
  end if;

  update public.orders
     set status = 'paid', pg_status = 'PAID', paid_at = now(), raw = p_raw,
         pg_tx_id = coalesce(pg_tx_id, p_pg_tx_id),
         error_message = null  -- failed 부활 시 'pg_failed' 등 잔존 마커 제거
   where order_uuid = p_order_uuid;

  insert into public.member_accounts (user_id, gen_credits)
  values (o.user_id, o.credits)
  on conflict (user_id) do update
    set gen_credits = member_accounts.gen_credits + excluded.gen_credits
  returning gen_credits into v_balance;

  -- 충전 원장 기록(0047 'purchase' 갭 해소) — 지급과 한 트랜잭션이라 유실/중복 없음.
  insert into public.credit_ledger (user_id, delta, event_type, balance_after, ref_order_uuid, note)
  values (o.user_id, o.credits, 'purchase', v_balance, p_order_uuid, o.product_id);

  return true;
end; $$;
revoke all on function public.mark_paid_and_grant(uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.mark_paid_and_grant(uuid, text, int, jsonb) to service_role;

-- 5.2 admin_settle_stuck_order — 결제 시도 흔적 가드를 프로바이더 중립으로(pg_tx_id 또는 payment_id).
--     포트원 주문은 라우트가 단건 조회 API 로 PAID + 금액 일치 검증 후 호출(육안 확인 대체).
--     failed 도 허용(준종단 — mark_paid_and_grant 와 동일 근거): 웹훅·폴링 이중 유실 시 운영 복구 경로.
create or replace function public.admin_settle_stuck_order(
  p_admin uuid, p_order_uuid uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; v_before int; v_after int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;
  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status not in ('pending', 'failed') or (o.pg_tx_id is null and o.payment_id is null) then raise exception 'not_settleable'; end if;

  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found'; end if;

  update public.member_accounts set gen_credits = gen_credits + o.credits
    where user_id = o.user_id returning gen_credits into v_after;
  update public.orders set status = 'paid', paid_at = now(), pg_status = 'PAID', error_message = null
    where order_uuid = p_order_uuid and status = o.status;
  if not found then raise exception 'status_changed'; end if;

  insert into public.credit_ledger (user_id, delta, event_type, balance_after, ref_order_uuid, note)
  values (o.user_id, o.credits, 'purchase', v_after, p_order_uuid, o.product_id || ' (settle)');

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason)
  values (p_admin, 'settle_stuck', o.user_id, p_order_uuid, o.credits, o.amount, v_before, v_after, p_reason);
  return jsonb_build_object('ok', true, 'before', v_before, 'after', v_after, 'credits', o.credits);
end; $$;
revoke all on function public.admin_settle_stuck_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_settle_stuck_order(uuid, uuid, text) to service_role;

-- 5.3 admin_cancel_order 5-arg — p_payapp_done → p_pg_done(named param), 정책(0024 최종본) 동일:
--     외부 환불 확정(pg_done)이면 회수 필수(clamp+shortfall), 로컬 전용은 엄격 차단, 화해(v_recon) 유지.
drop function if exists public.admin_cancel_order(uuid, uuid, boolean, text, boolean);
create function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text, p_pg_done boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
  v_before int; v_after int;
  v_claw int := 0; v_shortfall int := 0; v_recon boolean := false;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;

  select * into o from public.orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status = 'failed' then raise exception 'not_cancelable'; end if;

  if o.status = 'canceled' then
    if p_pg_done and not exists (
      select 1 from public.admin_actions_ledger
      where order_uuid = p_order_uuid and action_type = 'cancel_refund'
    ) then
      v_recon := true;
    else
      raise exception 'already_canceled';
    end if;
  end if;

  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found'; end if;

  -- 회수: 외부 환불 확정(p_pg_done) 또는 명시 회수(p_clawback). pg_done 이면 회수 필수(돈 이미 환불됨).
  if (o.status = 'paid' or v_recon) and (p_clawback or p_pg_done) then
    if not p_pg_done and v_before < o.credits then
      raise exception 'insufficient_credits';      -- 로컬 전용 경로: 엄격 차단.
    end if;
    v_claw := least(o.credits, v_before);           -- pg_done: 가진 만큼만(이미 외부 환불).
    v_shortfall := greatest(0, o.credits - v_before);
    update public.member_accounts set gen_credits = gen_credits - v_claw
      where user_id = o.user_id returning gen_credits into v_after;
  else
    v_after := v_before;                             -- pending→cancel 또는 무회수: 크레딧 불변.
  end if;

  if v_recon then
    update public.orders
      set clawback_credits = v_claw, refund_state = 'done', updated_at = now()
      where order_uuid = p_order_uuid;
  else
    update public.orders
      set status = 'canceled', canceled_at = now(), clawback_credits = v_claw,
          refund_state = case when p_pg_done then 'done' else refund_state end,
          updated_at = now()
      where order_uuid = p_order_uuid and status = o.status;
    if not found then raise exception 'order_status_changed'; end if;
  end if;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata)
  values (p_admin, 'cancel_refund', o.user_id, p_order_uuid, -v_claw, o.amount,
          v_before, v_after, p_reason,
          jsonb_build_object('pg_done', p_pg_done, 'shortfall', v_shortfall, 'reconciled', v_recon));

  return jsonb_build_object('ok', true, 'clawback', v_claw, 'shortfall', v_shortfall,
                            'before', v_before, 'after', v_after);
end; $$;

-- 4-arg wrapper(로컬 전용 경로) — p_pg_done=false 위임. 기존 시그니처 유지(무중단).
create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text
) returns jsonb language sql security definer set search_path = public as $$
  select public.admin_cancel_order(p_admin, p_order_uuid, p_clawback, p_reason, false);
$$;

revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) to service_role;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text) to service_role;

-- 5.4 get_admin_funnel — 테이블 참조만 교체(0020 정의 유지).
create or replace function public.get_admin_funnel()
returns table (
  anon_users bigint, players bigint, members bigint, first_gen bigint, first_purchase bigint
) language sql stable security definer set search_path = public as $$
  select
    (select count(*) from auth.users where is_anonymous)::bigint,
    (select count(distinct owner_id) from public.scores)::bigint,
    (select count(*) from public.member_accounts)::bigint,
    (select count(distinct owner_id) from public.dolls)::bigint,
    (select count(distinct user_id) from public.orders where status = 'paid')::bigint;
$$;
revoke all on function public.get_admin_funnel() from public, anon, authenticated;
grant execute on function public.get_admin_funnel() to service_role;

-- 5.5 get_admin_order_summary — 테이블 참조만 교체(0021 KST 통일본 유지).
create or replace function public.get_admin_order_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  with k as (
    select (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as today_start
  )
  select jsonb_build_object(
    'revenue_today', coalesce((select sum(amount) from public.orders, k where status='paid' and paid_at >= k.today_start), 0),
    'revenue_7d',    coalesce((select sum(amount) from public.orders, k where status='paid' and paid_at >= k.today_start - interval '6 days'), 0),
    'revenue_30d',   coalesce((select sum(amount) from public.orders, k where status='paid' and paid_at >= k.today_start - interval '29 days'), 0),
    'orders_today',  (select count(*) from public.orders, k where created_at >= k.today_start),
    'orders_7d',     (select count(*) from public.orders, k where created_at >= k.today_start - interval '6 days'),
    'orders_30d',    (select count(*) from public.orders, k where created_at >= k.today_start - interval '29 days'),
    'by_status',     coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from public.orders group by status) s), '{}'::jsonb)
  );
$$;
revoke all on function public.get_admin_order_summary() from public, anon, authenticated;
grant execute on function public.get_admin_order_summary() to service_role;

-- 5.6 search_orders — 반환 컬럼 mul_no→pg_tx_id + payment_id/provider 추가, 검색에 payment_id prefix 포함.
--     반환 형태 변경이라 drop 후 재생성(호출부 lib/admin-orders.ts 동시 배포).
drop function if exists public.search_orders(text, text, int, int);
create function public.search_orders(
  p_q text default null, p_status text default null,
  p_limit int default 10, p_offset int default 0
) returns table (
  order_uuid uuid, status text, amount int, credits int, product_id text,
  pg_tx_id text, payment_id text, provider text, created_at timestamptz, paid_at timestamptz,
  user_id uuid, display_name text, refund_state text, total_count bigint
) language sql stable security invoker set search_path = public as $$
  with filtered as (
    select o.order_uuid, o.status, o.amount, o.credits, o.product_id,
           o.pg_tx_id, o.payment_id, o.provider, o.created_at, o.paid_at, o.user_id,
           p.display_name, o.refund_state
    from public.orders o
    left join public.profiles p on p.id = o.user_id
    where (p_status is null or p_status = '' or o.status = p_status)
      and (
        p_q is null or p_q = ''
        or o.order_uuid::text ilike public.like_escape(p_q) || '%'
        or o.pg_tx_id ilike public.like_escape(p_q) || '%'
        or o.payment_id ilike public.like_escape(p_q) || '%'
      )
  )
  select f.order_uuid, f.status, f.amount, f.credits, f.product_id,
         f.pg_tx_id, f.payment_id, f.provider, f.created_at, f.paid_at, f.user_id,
         f.display_name, f.refund_state,
         count(*) over() as total_count
  from filtered f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.search_orders(text, text, int, int) from public, anon, authenticated;
grant execute on function public.search_orders(text, text, int, int) to service_role;

-- 5.7 admin_unreconciled_canceled_orders — setof public.orders 로 재생성(0057 로직 동일).
--     canceled_at 은 이제 웹훅 취소 경로도 채우지만(코드 + §4 백필) coalesce 폴백은 방어로 유지.
drop function if exists public.admin_unreconciled_canceled_orders(int);
create function public.admin_unreconciled_canceled_orders(p_limit int default 20)
returns setof public.orders
language sql stable security definer set search_path = public as $$
  select o.*
  from public.orders o
  where o.status = 'canceled'
    and o.paid_at is not null
    and o.refund_state is null
    and not exists (
      select 1 from public.admin_actions_ledger l
      where l.order_uuid = o.order_uuid and l.action_type = 'cancel_refund'
    )
  order by coalesce(o.canceled_at, o.updated_at) asc, o.order_uuid
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;
revoke all on function public.admin_unreconciled_canceled_orders(int) from public, anon, authenticated;
grant execute on function public.admin_unreconciled_canceled_orders(int) to service_role;

commit;

notify pgrst, 'reload schema';
