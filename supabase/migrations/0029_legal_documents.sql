-- 0027: 법무 문서(이용약관·개인정보처리방침) — 버전·시행일·초안/발행 + 예약 발행 + 전용 감사.
--
-- 설계: config(app_settings 단일 jsonb·즉시발행)와 달리 **버전 행·시행일·과거본 공개**가 필요 → 전용 테이블.
--  · server-only: anon/authenticated 전부 revoke, service_role grant. 공개 노출은 서버가 발행본만 투영.
--  · 발행 = append-only 버전 행. 문서당 초안 1개(부분 유니크). 예약 발행: 미래 effective_date, **KST 기준**.
--  · 감사: 전용 legal_documents_audit(머니 원장 admin_actions_ledger 는 order/credit NOT NULL·action 한정이라 부적합 — app_settings_audit 선례와 동일하게 분리).
--  · RPC hardening: security definer·search_path·execute revoke·**내부 admin 재검증**·advisory lock.
-- additive·무중관(신규 테이블, 기존 기능 무영향).

create table if not exists public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null check (doc_type in ('privacy','terms')),
  status text not null check (status in ('draft','published')),
  version int not null default 0,
  effective_date date,
  title text not null check (char_length(title) between 1 and 200),
  sections jsonb not null,
  public_note text check (public_note is null or char_length(public_note) <= 1000),  -- 공개 개정 사유
  admin_note text check (admin_note is null or char_length(admin_note) <= 2000),     -- 내부 메모(비공개)
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 발행본은 시행일·양수 버전 필수
  check (status = 'draft' or (effective_date is not null and version >= 1))
);
alter table public.legal_documents enable row level security;
revoke all on public.legal_documents from anon, authenticated;   -- 정책 없음 → 비-service_role 접근 0
grant all on public.legal_documents to service_role;
create unique index if not exists uq_legal_draft on public.legal_documents(doc_type) where status = 'draft';        -- 문서당 초안 1개
create unique index if not exists uq_legal_pub_version on public.legal_documents(doc_type, version) where status = 'published';  -- 동시 publish race 백스톱
create index if not exists idx_legal_pub on public.legal_documents(doc_type, effective_date desc) where status = 'published';     -- 현재본/이력 조회

-- 변경 감사 (누가 언제 저장/발행) — service_role 전용
create table if not exists public.legal_documents_audit (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null,
  action text not null check (action in ('legal_draft_saved','legal_published')),
  version int,
  effective_date date,
  public_note text,
  admin_note text,
  admin_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.legal_documents_audit enable row level security;
revoke all on public.legal_documents_audit from anon, authenticated;
grant all on public.legal_documents_audit to service_role;
create index if not exists idx_legal_audit on public.legal_documents_audit(doc_type, created_at desc);

-- 섹션 사이즈 가드(API zod 와 동일 한도) — 1~50개, heading 1~120, body 1~20000, 직렬화 ≤200KB.
create or replace function public.legal_sections_valid(p jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'array'
    and jsonb_array_length(p) between 1 and 50
    and octet_length(p::text) <= 200000
    and not exists (
      select 1 from jsonb_array_elements(p) e
      where char_length(coalesce(e->>'heading','')) not between 1 and 120
         or char_length(coalesce(e->>'body','')) not between 1 and 20000
    );
$$;
revoke all on function public.legal_sections_valid(jsonb) from public, anon, authenticated;
grant execute on function public.legal_sections_valid(jsonb) to service_role;

-- 초안 저장(문서당 1개 upsert) + 감사. 내부 admin 재검증.
create or replace function public.admin_save_legal_draft(
  p_doc_type text, p_title text, p_sections jsonb, p_public_note text, p_admin_note text, p_admin_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_doc_type not in ('privacy','terms') then raise exception 'invalid_doc_type'; end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  if char_length(coalesce(p_title,'')) not between 1 and 200 then raise exception 'invalid_title'; end if;
  if not public.legal_sections_valid(p_sections) then raise exception 'invalid_sections'; end if;

  insert into public.legal_documents
    (doc_type, status, version, effective_date, title, sections, public_note, admin_note, created_by, updated_at)
  values
    (p_doc_type, 'draft', 0, null, p_title, p_sections, p_public_note, p_admin_note, p_admin_id, now())
  on conflict (doc_type) where status = 'draft' do update set
    title = excluded.title, sections = excluded.sections,
    public_note = excluded.public_note, admin_note = excluded.admin_note,
    created_by = excluded.created_by, updated_at = now();

  insert into public.legal_documents_audit(doc_type, action, version, effective_date, public_note, admin_note, admin_user_id)
    values (p_doc_type, 'legal_draft_saved', 0, null, p_public_note, p_admin_note, p_admin_id);

  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_save_legal_draft(text, text, jsonb, text, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_save_legal_draft(text, text, jsonb, text, text, uuid) to service_role;

-- 발행: 현재 draft → 새 published 버전 스냅샷(예약 발행). advisory lock·KST·예약1개·무변경차단·내부 admin 검증.
create or replace function public.admin_publish_legal(
  p_doc_type text, p_effective_date date, p_admin_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_draft public.legal_documents;
  v_latest public.legal_documents;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_version int;
begin
  if p_doc_type not in ('privacy','terms') then raise exception 'invalid_doc_type'; end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  if p_effective_date is null then raise exception 'effective_date_required'; end if;
  if p_effective_date < v_today then raise exception 'effective_date_past'; end if;

  perform pg_advisory_xact_lock(hashtext('legal:' || p_doc_type));

  select * into v_draft from public.legal_documents where doc_type = p_doc_type and status = 'draft';
  if not found then raise exception 'no_draft'; end if;
  if not public.legal_sections_valid(v_draft.sections) then raise exception 'invalid_sections'; end if;

  -- 미래 예약본은 doc_type당 1개만
  if exists (select 1 from public.legal_documents
             where doc_type = p_doc_type and status = 'published' and effective_date > v_today) then
    raise exception 'reservation_exists';
  end if;

  -- 최신 발행본과 내용·시행일 모두 동일하면 무변경 발행 차단
  select * into v_latest from public.legal_documents
    where doc_type = p_doc_type and status = 'published' order by version desc limit 1;
  if found
     and v_latest.title = v_draft.title
     and v_latest.sections = v_draft.sections
     and coalesce(v_latest.public_note,'') = coalesce(v_draft.public_note,'')
     and v_latest.effective_date = p_effective_date then
    raise exception 'no_change';
  end if;

  v_version := coalesce(
    (select max(version) from public.legal_documents where doc_type = p_doc_type and status = 'published'), 0
  ) + 1;

  insert into public.legal_documents
    (doc_type, status, version, effective_date, title, sections, public_note, admin_note, created_by, updated_at)
  values
    (p_doc_type, 'published', v_version, p_effective_date, v_draft.title, v_draft.sections,
     v_draft.public_note, v_draft.admin_note, p_admin_id, now());

  insert into public.legal_documents_audit(doc_type, action, version, effective_date, public_note, admin_note, admin_user_id)
    values (p_doc_type, 'legal_published', v_version, p_effective_date, v_draft.public_note, v_draft.admin_note, p_admin_id);

  return jsonb_build_object('ok', true, 'version', v_version, 'effective_date', p_effective_date);
end; $$;
revoke all on function public.admin_publish_legal(text, date, uuid) from public, anon, authenticated;
grant execute on function public.admin_publish_legal(text, date, uuid) to service_role;
