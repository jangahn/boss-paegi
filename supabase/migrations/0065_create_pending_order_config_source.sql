-- ─────────────────────────────────────────────────────────────────────────────
-- 0065: create_pending_order 가격 allowlist — 하드코딩 VALUES → growth_levers config 단일정본
--
-- 장애(prod): create_pending_order(0062)가 상품가격을 하드코딩 VALUES 로 검증했는데, 어드민이
--   /admin/content/growth_levers 에서 가격을 갱신(이벤트가·인상)하면서 config 와 RPC 하드코딩이
--   드리프트 → checkout 이 config 가격(예: credits_10=4500)을 넘기면 RPC 하드코딩(3000)과 어긋나
--   product_amount_mismatch / invalid_product(신규 event_credits_10) 로 **전 상품 결제 거절**.
--   결제 비활성(creditsEnabled=false) 기간이라 잠복하다 오픈 후 리뷰어 결제로 표면화
--   (Sentry `pay.order_insert_fail` ×6, release 3595d221).
--
-- 수정: allowlist 를 app_settings.growth_levers.products(active) 에서 조회 — 앱 checkout 의
--   activeCreditProducts 와 **동일 소스**라 구조적으로 재드리프트 불가(가격 정본 단일화).
--   보안 불변: config price 는 zod 로 이미 1,000~100,000원 바운드(lib/config/domains/growth.ts),
--   app_settings 는 어드민 전용(RLS)이라 클라 조작 불가 → 서버 권위·클라 amount 자유입력 차단(§18) 유지.
--
-- 데이터 무변경(함수 본문만). 나머지 검증(provider/channel/payment_id 형식/탈퇴/멱등/insert) 전부 불변.
-- 롤백: 0062 의 하드코딩 정의로 create or replace 재적용.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_pending_order(
  p_user uuid, p_order_uuid uuid, p_product_id text, p_amount integer, p_credits integer,
  p_payment_id text, p_provider text, p_pay_channel text, p_is_test boolean)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_amt int; v_cr int; v_deleted boolean; v_existing public.orders;
begin
  -- 가격/개수 정본 = app_settings.growth_levers 의 active 상품(어드민 전용 config, 서버 권위).
  --   클라는 productId 만 보내고 금액은 서버가 config 로 결정(§18) — 하드코딩 제거로 config 와 드리프트 불가.
  select (elem->>'price')::int, (elem->>'credits')::int
    into v_amt, v_cr
  from public.app_settings s
       cross join lateral pg_catalog.jsonb_array_elements(s.value->'products') as elem
  where s.key = 'growth_levers'
    and elem->>'productId' = p_product_id
    and coalesce((elem->>'active')::boolean, false) = true;
  if v_amt is null then raise exception 'invalid_product' using errcode = 'P0001'; end if;
  if p_amount <> v_amt or p_credits <> v_cr then raise exception 'product_amount_mismatch' using errcode = 'P0001'; end if;
  if p_provider <> 'portone' then raise exception 'invalid_provider' using errcode = 'P0001'; end if;
  if p_pay_channel not in ('card', 'tosspay', 'kakaopay') then raise exception 'invalid_channel' using errcode = 'P0001'; end if;
  if p_payment_id <> pg_catalog.replace(p_order_uuid::text, '-', '') then
    raise exception 'payment_id_format' using errcode = 'P0001';
  end if;
  select (p.deleted_at is not null) into v_deleted from public.profiles p where p.id = p_user;
  if coalesce(v_deleted, false) then raise exception 'account_deleted' using errcode = 'P0001'; end if;

  -- 멱등: 동일 payment_id 재호출은 기존 pending 반환(다른 소유자·금액이면 conflict)
  select * into v_existing from public.orders where payment_id = p_payment_id;
  if v_existing.order_uuid is not null then
    if v_existing.user_id <> p_user or v_existing.amount <> p_amount or v_existing.credits <> p_credits then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return v_existing.order_uuid;
  end if;

  insert into public.orders
    (order_uuid, user_id, product_id, amount, credits, status, provider, payment_id, is_test, pay_channel)
  values (p_order_uuid, p_user, p_product_id, p_amount, p_credits, 'pending', p_provider,
          p_payment_id, coalesce(p_is_test, false), p_pay_channel);
  return p_order_uuid;
end;
$function$;

-- EXECUTE 재확정(0063 과 동일 정책: service_role 전용) — 멱등.
revoke all on function public.create_pending_order(uuid,uuid,text,int,int,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.create_pending_order(uuid,uuid,text,int,int,text,text,text,boolean) to service_role;
