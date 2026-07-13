-- 0056: 어드민 탈퇴자 검색(admin_find_withdrawn_by_email) 정렬 교정.
-- 기존(0037)은 DISTINCT ON (p.id) 요건 때문에 ORDER BY 첫 키가 p.id(uuid)여서 최종 결과가
-- 사실상 무작위 순으로 나갔는데, UI(/admin/users 탈퇴 회원 섹션)는 탈퇴일을 표시한다
-- (정렬키≠표시키). 30건 초과 시 어느 행이 잘리는지도 uuid 순이라 비의미적이었다.
-- → 서브쿼리로 감싸 바깥에서 탈퇴일 최신순 정렬 + LIMIT. DISTINCT ON 의 identity 픽도
--   i.created_at ASC 로 결정화(가장 오래된 identity = 가입 당시 "원본" 이메일 의도와 정합 —
--   기존엔 한 유저에 매칭 identity 가 여럿이면 어느 이메일이 뽑힐지 비결정적이었음).
create or replace function public.admin_find_withdrawn_by_email(p_email text)
returns table (user_id uuid, original_email text, deleted_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.user_id, t.original_email, t.deleted_at, t.last_sign_in_at
  from (
    select distinct on (p.id)
      p.id as user_id,
      coalesce(i.email, i.identity_data->>'email') as original_email,
      p.deleted_at,
      u.last_sign_in_at
    from public.profiles p
    join auth.identities i on i.user_id = p.id
    left join auth.users u on u.id = p.id
    where p.deleted_at is not null
      and length(btrim(coalesce(p_email, ''))) >= 3
      and strpos(lower(coalesce(i.email, i.identity_data->>'email', '')), lower(btrim(p_email))) > 0
    order by p.id, i.created_at asc
  ) t
  order by t.deleted_at desc, t.user_id
  limit 30;
$$;
revoke all on function public.admin_find_withdrawn_by_email(text) from public, anon, authenticated;
grant execute on function public.admin_find_withdrawn_by_email(text) to service_role;

notify pgrst, 'reload schema';
