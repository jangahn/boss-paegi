-- 0030: 계정 탈퇴(soft-delete) + 만14세 1회 확인 플래그 + 결제기록 보존 안전장치.
--
-- 원칙: 법정 필수 최소. auth.users 는 삭제하지 않는다(soft-delete) — 삭제 시 profiles→payapp_orders
--   CASCADE 로 결제기록이 파괴돼 전자상거래법 5년 보존을 위반하기 때문. profile 행을 남겨 결제기록을
--   구조적으로 보존하고, 추가로 FK 를 RESTRICT 로 바꿔 실수 hard-delete 도 DB 가 차단한다.
-- 적용: management API query 엔드포인트. additive(기존 활성 사용자 무영향).

-- ── 1. soft-delete 마커 ──────────────────────────────────────────────
alter table public.profiles add column if not exists deleted_at timestamptz;
create index if not exists idx_profiles_deleted on public.profiles(deleted_at) where deleted_at is not null;

-- ── 2. 만14세 1회 확인 플래그 (DOB/나이 아님 — 확인 시각만) ───────────
alter table public.member_accounts add column if not exists age_confirmed_at timestamptz;

-- ── 3. 결제기록 법정 5년 보존 — payapp_orders.user_id FK CASCADE → RESTRICT ──
--   실제 제약명을 pg_constraint 에서 동적 조회해 안전하게 교체(예상명 의존 X).
do $$
declare v_name text;
begin
  select con.conname into v_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
  where rel.relname = 'payapp_orders' and con.contype = 'f' and att.attname = 'user_id'
  limit 1;
  if v_name is not null then
    execute format('alter table public.payapp_orders drop constraint %I', v_name);
  end if;
  -- ON DELETE CASCADE 금지(결제기록 법정 보존). RESTRICT = 참조 시 profiles 삭제 차단.
  alter table public.payapp_orders
    add constraint payapp_orders_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete restrict;
end $$;

-- ── 4. 계정 soft-delete + PII 익명화 RPC (멱등) ──────────────────────
--   storage 파일·auth.users 스크럽은 SQL 불가 → API 라우트(best-effort). 결제기록·scores 불변.
create or replace function public.admin_soft_delete_account(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  -- 이미 탈퇴면 값 되살리지 않음(coalesce 로 deleted_at 최초값 유지) — 멱등.
  update public.profiles
     set deleted_at = coalesce(deleted_at, now()),
         display_name = '탈퇴한 사용자',
         avatar_url = null
   where id = p_user_id;

  update public.member_accounts
     set email = null, gen_credits = 0
   where user_id = p_user_id;

  -- 캐릭터 row 삭제(얼굴 기반 식별성). scores.doll_id 는 set null(0017). 여러번 안전.
  delete from public.dolls where owner_id = p_user_id;

  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_soft_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.admin_soft_delete_account(uuid) to service_role;

-- ── 5. mark_paid_and_grant 가드 — 탈퇴자는 결제 사실만 기록, 크레딧 미지급 ──
--   pending 차단에도 webhook 지연 도착 race 가능 → deleted_at 이면 grant 스킵 + 식별 마커.
--   자동환불은 구현하지 않음(운영자 수동 확인). 정상 경로는 0019 와 동일.
create or replace function public.mark_paid_and_grant(
  p_order_uuid uuid, p_mul_no text, p_price int, p_raw jsonb
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  o public.payapp_orders;
  v_deleted boolean;
begin
  select * into o from public.payapp_orders where order_uuid = p_order_uuid for update;
  if not found then return false; end if;
  if o.amount <> p_price then return false; end if;
  if o.status <> 'pending' then return false; end if;

  select (p.deleted_at is not null) into v_deleted from public.profiles p where p.id = o.user_id;

  if coalesce(v_deleted, false) then
    update public.payapp_orders
       set status = 'paid', pay_state = 4, paid_at = now(), raw = p_raw,
           mul_no = coalesce(mul_no, p_mul_no),
           error_message = 'account_deleted_no_grant'
     where order_uuid = p_order_uuid;
    return true;   -- 결제 기록은 보존, 크레딧 미지급. webhook 재시도 방지.
  end if;

  update public.payapp_orders
     set status = 'paid', pay_state = 4, paid_at = now(), raw = p_raw,
         mul_no = coalesce(mul_no, p_mul_no)
   where order_uuid = p_order_uuid;

  insert into public.member_accounts (user_id, gen_credits)
  values (o.user_id, o.credits)
  on conflict (user_id) do update
    set gen_credits = member_accounts.gen_credits + excluded.gen_credits;

  return true;
end; $$;
revoke all on function public.mark_paid_and_grant(uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.mark_paid_and_grant(uuid, text, int, jsonb) to service_role;
