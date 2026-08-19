-- account_consent_lifecycle.pgtap.sql — 0079 atomic consent/OAuth seed lifecycle.

begin;
select plan(38);

select ok(
  has_function_privilege(
    'service_role',
    'public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)',
    'EXECUTE'
  ),
  'service role can call atomic consent/profile RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)',
    'EXECUTE'
  ),
  'browser cannot forge consent/profile RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.sync_active_member_oauth_profile(uuid,text,text,text)',
    'EXECUTE'
  ),
  'service role can call fenced OAuth sync'
);
select has_trigger(
  'public',
  'profiles',
  'trg_profiles_scrub_member_consent_on_delete',
  'profile deletion scrubs consent and PII at the DB boundary'
);

create temporary table consent_ctx (
  user_id uuid not null,
  invalid_seed_user_id uuid not null,
  sync_user_id uuid not null,
  terms_version int not null,
  privacy_version int not null
) on commit drop;

do $fixture$
declare
  v_user uuid := gen_random_uuid();
  v_invalid uuid := gen_random_uuid();
  v_sync uuid := gen_random_uuid();
  v_terms int;
  v_privacy int;
  v_today date :=
    (clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  insert into auth.users(id, email) values
    (v_user, 'consent-new-' || v_user::text || '@test.local'),
    (v_invalid, 'consent-invalid-' || v_invalid::text || '@test.local'),
    (v_sync, 'consent-sync-' || v_sync::text || '@test.local');
  insert into public.member_accounts(user_id, email)
  values (v_sync, 'old-sync@test.local');
  -- 기존 회원의 마이페이지 커스터마이징 시뮬레이션(0103 보존 규칙 대상).
  update public.profiles
     set display_name = '커스텀닉',
         avatar_url = 'https://avatar.test/custom.png'
   where id = v_sync;

  -- This suite tests consent lifecycle, not future legal publication. Bootstrap
  -- the notice-exempt initial version and then derive the same authoritative
  -- currently-effective versions that the consent RPC will recheck.
  insert into public.legal_documents(
    doc_type,
    status,
    version,
    effective_date,
    title,
    sections
  )
  values
    (
      'terms',
      'published',
      1,
      v_today,
      'QA terms',
      '[{"heading":"Terms","body":"Current terms"}]'::jsonb
    ),
    (
      'privacy',
      'published',
      1,
      v_today,
      'QA privacy',
      '[{"heading":"Privacy","body":"Current privacy"}]'::jsonb
    )
  on conflict (doc_type, version) where status = 'published'
  do update
    set effective_date = excluded.effective_date,
        title = excluded.title,
        sections = excluded.sections,
        updated_at = clock_timestamp();
  select l.version
    into strict v_terms
    from public.legal_documents l
   where l.doc_type = 'terms'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  select l.version
    into strict v_privacy
    from public.legal_documents l
   where l.doc_type = 'privacy'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  insert into consent_ctx
  values (v_user, v_invalid, v_sync, v_terms, v_privacy);
end;
$fixture$;

select is(
  (
    select public.create_or_update_member_consent_with_profile(
             user_id,
             7,
             true,
             true,
             terms_version,
             true,
             privacy_version,
             'QA User',
             'https://avatar.test/qa.png',
             'verified@test.local'
           )
      from consent_ctx
  ),
  true,
  'new member consent and OAuth seed commit atomically'
);
select is(
  (
    select m.gen_credits
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  7,
  'new member receives the configured signup bonus'
);
select is(
  (
    select count(*)::int
      from public.credit_lots l
      join consent_ctx c on c.user_id = l.user_id
     where l.source = 'signup_bonus'
       and l.qty = 7
  ),
  1,
  'signup bonus has exactly one durable lot'
);
select ok(
  (
    select age_confirmed_at is not null
       and terms_agreed_at is not null
       and privacy_agreed_at is not null
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  'all requested consent timestamps are stamped'
);
select is(
  (
    select m.terms_version::text || '|' || m.privacy_version::text
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  (
    select c.terms_version::text || '|' || c.privacy_version::text
      from consent_ctx c
  ),
  'persisted consent versions equal the currently effective versions'
);
select is(
  (
    select m.email
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  'verified@test.local',
  'verified OAuth email is seeded in the same transaction'
);
select is(
  (
    select p.display_name || '|' || p.avatar_url
      from public.profiles p
      join consent_ctx c on c.user_id = p.id
  ),
  'QA User|https://avatar.test/qa.png',
  'display name and avatar are seeded in the same transaction'
);
select is(
  (
    select public.create_or_update_member_consent_with_profile(
             user_id,
             99,
             true,
             true,
             terms_version,
             true,
             privacy_version,
             'QA User',
             'https://avatar.test/qa.png',
             'verified@test.local'
           )
      from consent_ctx
  ),
  false,
  'a repeated consent request updates rather than recreates the member'
);
select is(
  (
    select count(*)::int
      from public.credit_lots l
      join consent_ctx c on c.user_id = l.user_id
     where l.source = 'signup_bonus'
  ),
  1,
  'repeated consent cannot mint a second signup bonus'
);
select throws_ok(
  format(
    'select public.create_or_update_member_consent_with_profile(%L::uuid,0,true,true,%s,true,%s,%L,%L,%L)',
    (select user_id from consent_ctx),
    (select terms_version + 1 from consent_ctx),
    (select privacy_version from consent_ctx),
    'QA User',
    'https://avatar.test/qa.png',
    'verified@test.local'
  ),
  'P0001',
  'legal_version_changed',
  'server rechecks the exact effective legal version inside the transaction'
);
select is(
  (
    select m.terms_version
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  (select terms_version from consent_ctx),
  'failed stale-version consent leaves the prior stamp unchanged'
);

select throws_ok(
  format(
    'select public.create_or_update_member_consent_with_profile(%L::uuid,11,true,true,%s,true,%s,%L,%L,%L)',
    (select invalid_seed_user_id from consent_ctx),
    (select terms_version from consent_ctx),
    (select privacy_version from consent_ctx),
    'name-is-far-too-long',
    'https://avatar.test/qa.png',
    'invalid-seed@test.local'
  ),
  'P0001',
  'invalid_profile_seed',
  'invalid OAuth seed rolls back the entire member transaction'
);
select is(
  (
    select count(*)::int
      from public.member_accounts m
      join consent_ctx c on c.invalid_seed_user_id = m.user_id
  ),
  0,
  'invalid seed leaves no half-created member'
);
select is(
  (
    select count(*)::int
      from public.credit_lots l
      join consent_ctx c on c.invalid_seed_user_id = l.user_id
  ),
  0,
  'invalid seed leaves no orphan signup lot'
);

select is(
  (
    select public.sync_active_member_oauth_profile(
             sync_user_id,
             'Synced',
             'https://avatar.test/synced.png',
             'new-sync@test.local'
           )->>'ok'
      from consent_ctx
  ),
  'true',
  'active existing member OAuth sync succeeds'
);
select is(
  (
    select m.email || '|' || p.display_name || '|' || p.avatar_url
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
      join consent_ctx c on c.sync_user_id = m.user_id
  ),
  'new-sync@test.local|커스텀닉|https://avatar.test/custom.png',
  'fenced OAuth sync updates member email without clobbering the customized profile'
);

-- 0103: 기본 프사로 되돌린 상태(avatar_url null)도 사용자 선택 — sync 가 되살리지 않는다.
update public.profiles p
   set avatar_url = null
  from consent_ctx c
 where p.id = c.sync_user_id;
select is(
  (
    select public.sync_active_member_oauth_profile(
             sync_user_id,
             'Synced',
             'https://avatar.test/synced.png',
             'new-sync2@test.local'
           )->>'ok'
      from consent_ctx
  ),
  'true',
  'OAuth sync succeeds against a default-avatar profile'
);
select is(
  (
    select m.email || '|' || p.display_name || '|'
             || coalesce(p.avatar_url, '<null>')
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
      join consent_ctx c on c.sync_user_id = m.user_id
  ),
  'new-sync2@test.local|커스텀닉|<null>',
  'OAuth sync does not resurrect a removed avatar'
);

-- 0103: 재동의(update 경로)도 프로필 불가침 — email/동의 스탬프만 갱신한다.
select is(
  (
    select public.create_or_update_member_consent_with_profile(
             sync_user_id,
             0,
             true,
             true,
             terms_version,
             true,
             privacy_version,
             'OAuth Name',
             'https://avatar.test/oauth.png',
             'sync-reconsent@test.local'
           )
      from consent_ctx
  ),
  false,
  'reconsent takes the member update path'
);
select is(
  (
    select m.email || '|' || p.display_name || '|'
             || coalesce(p.avatar_url, '<null>')
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
      join consent_ctx c on c.sync_user_id = m.user_id
  ),
  'sync-reconsent@test.local|커스텀닉|<null>',
  'reconsent preserves the customized profile while syncing email'
);

-- 0103: 탈퇴 스크럽 플레이스홀더만은 OAuth 로 재시드된다(재활성 복원) — sync 경로.
update public.profiles p
   set display_name = '탈퇴한 사용자',
       avatar_url = null
  from consent_ctx c
 where p.id = c.sync_user_id;
select is(
  (
    select public.sync_active_member_oauth_profile(
             sync_user_id,
             'Reborn',
             'https://avatar.test/reborn.png',
             'reborn@test.local'
           )->>'ok'
      from consent_ctx
  ),
  'true',
  'OAuth sync succeeds against a scrub-placeholder profile'
);
select is(
  (
    select p.display_name || '|' || p.avatar_url
      from public.profiles p
      join consent_ctx c on c.sync_user_id = p.id
  ),
  'Reborn|https://avatar.test/reborn.png',
  'scrub placeholder is reseeded from OAuth by the sync path'
);

-- 0103: consent update 경로의 플레이스홀더 재시드도 동일 규칙.
update public.profiles p
   set display_name = '탈퇴한 사용자',
       avatar_url = null
  from consent_ctx c
 where p.id = c.sync_user_id;
select is(
  (
    select public.create_or_update_member_consent_with_profile(
             sync_user_id,
             0,
             true,
             true,
             terms_version,
             true,
             privacy_version,
             'Reborn2',
             'https://avatar.test/reborn2.png',
             'reborn2@test.local'
           )
      from consent_ctx
  ),
  false,
  'placeholder reconsent still takes the member update path'
);
select is(
  (
    select p.display_name || '|' || p.avatar_url
      from public.profiles p
      join consent_ctx c on c.sync_user_id = p.id
  ),
  'Reborn2|https://avatar.test/reborn2.png',
  'scrub placeholder is reseeded from OAuth by the reconsent path'
);

select lives_ok(
  format(
    'select public.admin_soft_delete_account(%L::uuid)',
    (select user_id from consent_ctx)
  ),
  'account deletion commits after consent'
);
select ok(
  (
    select deleted_at is not null
      from public.profiles p
      join consent_ctx c on c.user_id = p.id
  ),
  'profile is soft-deleted'
);
select is(
  (
    select m.email
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  null::text,
  'account deletion scrubs member email'
);
select is(
  (
    select m.terms_version
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  null::int,
  'account deletion scrubs terms consent evidence'
);
select is(
  (
    select m.privacy_version
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  null::int,
  'account deletion scrubs privacy consent evidence'
);
select is(
  (
    select m.reconsent_required
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  true,
  'deleted member is marked for reconsent if later reactivated'
);
select throws_ok(
  format(
    'select public.sync_active_member_oauth_profile(%L::uuid,%L,%L,%L)',
    (select user_id from consent_ctx),
    'Late Sync',
    'https://avatar.test/late.png',
    'late@test.local'
  ),
  'P0001',
  'invalid_account',
  'delayed OAuth callback cannot restore PII after deletion'
);
select throws_ok(
  format(
    'select public.create_or_update_member_consent_with_profile(%L::uuid,0,true,true,%s,true,%s,%L,%L,%L)',
    (select user_id from consent_ctx),
    (select terms_version from consent_ctx),
    (select privacy_version from consent_ctx),
    'Late Consent',
    'https://avatar.test/late.png',
    'late@test.local'
  ),
  'P0001',
  'invalid_account',
  'delayed consent cannot recreate data after deletion'
);
select is(
  (
    select m.email
      from public.member_accounts m
      join consent_ctx c on c.user_id = m.user_id
  ),
  null::text,
  'failed delayed writers leave scrubbed PII null'
);
select is(
  (
    select count(*)::int
      from public.account_deletion_cleanup_jobs j
      join consent_ctx c on c.user_id = j.user_id
     where j.status = 'pending'
  ),
  1,
  'deletion also retains its durable cleanup job'
);

select * from finish();
rollback;
