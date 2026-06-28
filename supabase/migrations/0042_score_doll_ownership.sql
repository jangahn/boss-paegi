-- 0042: scores INSERT IDOR 차단 — doll_id 소유 강제 (적대감사 #1, defense in depth)
--
-- 적용: Management API query 엔드포인트(POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN, User-Agent 헤더).
-- 배경: POST /api/score 가 body.dollId 를 소유 검증 없이 insert → 공격자가 타인 doll UUID 위조 제출 시
--   공개 /share·/history(admin service-role 서명, RLS 우회)에 피해자 실존인물 얼굴이 공격자 닉 아래 오귀속
--   (명예훼손·개인정보보호법). 라우트(app/api/score/route.ts)가 미소유 doll_id 를 null 강등하지만,
--   DB 레벨에서도 강제해 미래 코드가 라우트 검증을 누락해도 구조적 차단(defense in depth).
-- score insert 는 user 클라(RLS 적용)라 with-check 가 유효. additive·하위호환(정상 플레이어 무영향).
--
-- 기존 정책: "scores: owner insert" with check (auth.uid() = owner_id).
--   → doll_id 가 null 이거나, 그 doll 이 현재 유저 소유일 때만 허용하도록 확장.
--   with-check 서브쿼리는 dolls RLS(auth.uid()=owner_id) 컨텍스트라 사실상 본인 doll 만 보임 →
--   명시 owner_id 조건은 중복-안전(RLS 변경 대비).

alter policy "scores: owner insert" on public.scores
  with check (
    auth.uid() = owner_id
    and (
      doll_id is null
      or exists (
        select 1 from public.dolls
        where dolls.id = scores.doll_id and dolls.owner_id = auth.uid()
      )
    )
  );

notify pgrst, 'reload schema';
