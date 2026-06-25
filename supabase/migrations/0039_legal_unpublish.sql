-- 법무문서 버전관리 보강: 발행취소(예약본→draft 복원) + 발행 시 draft 소비(Model A: '발행 전 문서' 1개).
-- 배경: 미래 effective_date 로 예약 발행한 published 행을 되돌릴 방법이 없어(reservation_exists 데드락),
-- 시행 전 예약본을 취소→수정→재발행할 수 있게 한다. 시행본(effective_date<=오늘)은 불변(취소 불가).

-- 1) 감사 action 에 'legal_unpublished' 추가.
alter table public.legal_documents_audit drop constraint if exists legal_documents_audit_action_check;
alter table public.legal_documents_audit add constraint legal_documents_audit_action_check
  check (action in ('legal_draft_saved','legal_published','legal_unpublished'));

-- 2) 발행: draft → 새 published 버전 + **draft 소비**(Model A). 그 외 로직(예약·무변경차단·KST·admin)은 0029 동일.
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

  -- 미래 예약본은 doc_type당 1개만(취소는 admin_unpublish_legal 로)
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

  -- Model A: 발행 전 문서(draft)는 1개 — 발행하면 그 버전으로 확정되고 draft 는 소비(삭제).
  delete from public.legal_documents where doc_type = p_doc_type and status = 'draft';

  insert into public.legal_documents_audit(doc_type, action, version, effective_date, public_note, admin_note, admin_user_id)
    values (p_doc_type, 'legal_published', v_version, p_effective_date, v_draft.public_note, v_draft.admin_note, p_admin_id);

  return jsonb_build_object('ok', true, 'version', v_version, 'effective_date', p_effective_date);
end; $$;
revoke all on function public.admin_publish_legal(text, date, uuid) from public, anon, authenticated;
grant execute on function public.admin_publish_legal(text, date, uuid) to service_role;

-- 3) 발행취소: 시행 전(미래 effective_date) 예약본만. 예약본 행 삭제 + draft 가 없으면 예약본 내용을 draft 로 복원.
--    시행본(effective_date<=오늘)은 취소 대상 아님(불변·이력 보존). draft 가 이미 있으면 덮어쓰지 않고 예약만 취소.
create or replace function public.admin_unpublish_legal(
  p_doc_type text, p_admin_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_resv public.legal_documents;
  v_has_draft boolean;
  v_restored boolean := false;
begin
  if p_doc_type not in ('privacy','terms') then raise exception 'invalid_doc_type'; end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;

  perform pg_advisory_xact_lock(hashtext('legal:' || p_doc_type));

  select * into v_resv from public.legal_documents
    where doc_type = p_doc_type and status = 'published' and effective_date > v_today
    order by effective_date asc limit 1;
  if not found then raise exception 'no_reservation'; end if;

  select exists(select 1 from public.legal_documents where doc_type = p_doc_type and status = 'draft') into v_has_draft;

  if not v_has_draft then
    insert into public.legal_documents
      (doc_type, status, version, effective_date, title, sections, public_note, admin_note, created_by, updated_at)
    values
      (p_doc_type, 'draft', 0, null, v_resv.title, v_resv.sections, v_resv.public_note, v_resv.admin_note, p_admin_id, now());
    v_restored := true;
  end if;

  delete from public.legal_documents where id = v_resv.id;

  insert into public.legal_documents_audit(doc_type, action, version, effective_date, public_note, admin_note, admin_user_id)
    values (p_doc_type, 'legal_unpublished', v_resv.version, v_resv.effective_date, v_resv.public_note, v_resv.admin_note, p_admin_id);

  return jsonb_build_object('ok', true, 'restored_draft', v_restored, 'version', v_resv.version);
end; $$;
revoke all on function public.admin_unpublish_legal(text, uuid) from public, anon, authenticated;
grant execute on function public.admin_unpublish_legal(text, uuid) to service_role;

-- PostgREST 스키마 캐시 리로드(Management API DDL 후 신규 RPC 노출 필수).
notify pgrst, 'reload schema';
