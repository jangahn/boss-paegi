-- 0036: Phase 2 flip — dolls/highlights 버킷 private 전환 + image_url/candidate_urls 경로 backfill
--
-- ⚠️ 순서: (코드 배포 → flip前 검증: 서명 URL 이 전 표면에서 렌더되는지 확인) **후에만** 적용.
-- ⚠️ 적용 전 dry-run 필수 — 아래 UPDATE 를 select 로 먼저 돌려 변환 샘플 확인(SPEC: 배포 절차).
-- 재실행 안전(idempotent): 이미 path 인 값은 regexp 비매치 → 불변. 빈 배열/null candidate_urls 불간섭.

-- ── 1. dolls.image_url: 공개 URL → 버킷상대경로 ──
update public.dolls
   set image_url = regexp_replace(image_url, '^.*/object/public/dolls/', '')
 where image_url like '%/object/public/dolls/%';

-- ── 2. ai_generations.candidate_urls(jsonb 배열): 각 원소 동일 strip ──
--   매치되는 원소만 치환(이미 path/fal URL 은 비매치 → 불변). 매칭 배열만 대상(빈 배열·null 불간섭).
update public.ai_generations
   set candidate_urls = (
     select jsonb_agg(regexp_replace(elem #>> '{}', '^.*/object/public/dolls/', ''))
       from jsonb_array_elements(candidate_urls) elem
   )
 where jsonb_typeof(candidate_urls) = 'array'
   and candidate_urls::text like '%/object/public/dolls/%';

-- ── 3. 버킷 private 전환 ──
--   신규 signed URL 만 접근 가능, 직접 public URL 사망. service-role 우회 + signed URL 은 private 동작
--   → RLS 정책 불요. avatars 는 public 유지(아바타/리더보드 무영향).
update storage.buckets set public = false where id in ('dolls', 'highlights');
