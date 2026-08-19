#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

# OAuth target-generation 펜스 계약 — 최신(전체 마이그레이션 적용) 스키마 검증.
# 구 verify-oauth-rollout-stage.sh(시대별 rollout 검증기, CI 단일 스키마 재설계로
# 폐기)에서 pgTAP 미커버 축 2개만 발췌:
#  ① 카탈로그 무결성(함수 본문 sha256·소유자·13 릴레이션 지문) — contract 고정
#  ② oauth_flow_intents 의 target 세대 펜스: 3컬럼 타입/NULL 허용,
#     target_identity CHECK 의 정확한 표현식, bp_0093_..._matches 의
#     secdef/search_path/반환형, auth.users·auth.sessions 트리거의
#     tgtype·감시 컬럼 집합, 펜스 함수 3종 비소유자 EXECUTE 전무
# 나머지(25 RPC 인벤토리·ACL·RLS 등)는 supabase/tests/oauth_flow_intents.pgtap.sql 소관.

if (( $# != 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ -z "$project_id" ]]; then
  echo "supabase project_id is missing" >&2
  exit 1
fi
default_db_container="supabase_db_${project_id}"
db_container="${QA_DB_CONTAINER:-$default_db_container}"
if [[ "$db_container" != "$default_db_container" ]] \
  && [[ "$db_container" != "$default_db_container"-* ]] \
  && [[ "$db_container" != "$default_db_container"_* ]]; then
  echo "QA_DB_CONTAINER must be the local project container or its disposable derivative" >&2
  exit 2
fi
if [[ "$db_container" != supabase_db_* ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required for OAuth catalog integrity verification" >&2
  exit 1
fi

catalog_integrity="$(
  node scripts/qa/render-oauth-catalog-integrity-query.mjs \
    --stage contract \
    | docker exec -i "$db_container" \
      psql -X -Aqt -v ON_ERROR_STOP=1 \
        -U "$db_user" -d "$db_name"
)"
if [[ "$catalog_integrity" != "ready" ]]; then
  echo "oauth target-fence QA failed: function/constraint/owner catalog integrity mismatch" >&2
  exit 1
fi

fences_ready="$(
  docker exec -i "$db_container" \
    psql -X -Aqt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" <<'SQL'
select
    (
      (
        select
          pg_catalog.count(*) = 3
          and pg_catalog.bool_and(
            case a.attname
              when 'target_auth_created_at'
                then pg_catalog.format_type(
                  a.atttypid,
                  a.atttypmod
                ) = 'timestamp with time zone'
              when 'target_auth_instance_id'
                then pg_catalog.format_type(
                  a.atttypid,
                  a.atttypmod
                ) = 'uuid'
              when 'target_session_created_at'
                then pg_catalog.format_type(
                  a.atttypid,
                  a.atttypmod
                ) = 'timestamp with time zone'
              else false
            end
            and not a.attnotnull
            and not a.attisdropped
          )
          from pg_catalog.pg_attribute a
         where a.attrelid =
           pg_catalog.to_regclass('public.oauth_flow_intents')
           and a.attname in (
             'target_auth_created_at',
             'target_auth_instance_id',
             'target_session_created_at'
           )
      )
      and exists (
        select 1
          from pg_catalog.pg_constraint c
         where c.conrelid =
           pg_catalog.to_regclass('public.oauth_flow_intents')
           and c.conname =
             'oauth_flow_intents_target_identity_check'
           and c.contype = 'c'
           and c.convalidated
           and pg_catalog.pg_get_expr(
             c.conbin,
             c.conrelid
           ) =
             '(((target_user_id IS NULL) = (target_session_id IS NULL)) AND ((target_user_id IS NULL) = (target_auth_created_at IS NULL)) AND ((target_user_id IS NULL) = (target_session_created_at IS NULL)) AND ((target_user_id IS NOT NULL) OR (target_auth_instance_id IS NULL)) AND ((target_session_id IS NULL) OR (target_session_id <> source_session_id)) AND ((target_user_id IS NULL) OR (NOT source_is_anonymous) OR (target_user_id <> source_user_id)))'
      )
      and coalesce(
        (
          select
            p.prosecdef
            and coalesce(p.proconfig, '{}'::text[])
              @> array['search_path=""']
            and p.prorettype = 'boolean'::regtype
            from pg_catalog.pg_proc p
           where p.oid = pg_catalog.to_regprocedure(
             'public.bp_0093_oauth_target_generation_matches(uuid,uuid,uuid,timestamptz,uuid,timestamptz)'
           )
        ),
        false
      )
      and (
        select
          pg_catalog.count(*) = 2
          and pg_catalog.bool_and(
            not t.tgisinternal
            and t.tgenabled = 'O'
            and t.tgfoid = pg_catalog.to_regprocedure(
              'public.fence_oauth_anon_auth_cleanup_user()'
            )
            and (
              (
                t.tgname =
                  'trg_auth_users_fence_oauth_anon_cleanup_insert'
                and t.tgtype = 7
              )
              or (
                t.tgname =
                  'trg_auth_users_fence_oauth_anon_cleanup_update'
                and t.tgtype = 19
                and (
                  select pg_catalog.array_agg(
                    a.attname
                    order by a.attname
                  )
                    from pg_catalog.pg_attribute a
                   where a.attrelid = t.tgrelid
                     and a.attnum = any(
                       t.tgattr::smallint[]
                     )
                ) = array[
                  'created_at',
                  'id',
                  'instance_id',
                  'is_anonymous'
                ]::name[]
              )
            )
          )
          from pg_catalog.pg_trigger t
         where t.tgrelid = pg_catalog.to_regclass('auth.users')
           and t.tgname in (
             'trg_auth_users_fence_oauth_anon_cleanup_insert',
             'trg_auth_users_fence_oauth_anon_cleanup_update'
           )
      )
      and coalesce(
        (
          select
            not t.tgisinternal
            and t.tgenabled = 'O'
            and t.tgtype = 23
            and t.tgfoid = pg_catalog.to_regprocedure(
              'public.fence_revoked_oauth_target_session_id()'
            )
            and (
              select pg_catalog.array_agg(
                a.attname
                order by a.attname
              )
                from pg_catalog.pg_attribute a
               where a.attrelid = t.tgrelid
                 and a.attnum = any(
                   t.tgattr::smallint[]
                 )
            ) = array[
              'created_at',
              'id',
              'user_id'
            ]::name[]
            from pg_catalog.pg_trigger t
           where t.tgrelid =
             pg_catalog.to_regclass('auth.sessions')
             and t.tgname =
               'trg_auth_sessions_fence_revoked_oauth_target_id'
        ),
        false
      )
      and not exists (
        select 1
          from pg_catalog.pg_proc p
          cross join lateral pg_catalog.aclexplode(
            coalesce(
              p.proacl,
              pg_catalog.acldefault('f'::"char", p.proowner)
            )
          ) acl
         where p.oid in (
           pg_catalog.to_regprocedure(
             'public.bp_0093_oauth_target_generation_matches(uuid,uuid,uuid,timestamptz,uuid,timestamptz)'
           ),
           pg_catalog.to_regprocedure(
             'public.fence_oauth_anon_auth_cleanup_user()'
           ),
           pg_catalog.to_regprocedure(
             'public.fence_revoked_oauth_target_session_id()'
           )
         )
           and acl.privilege_type = 'EXECUTE'
           and acl.grantee <> p.proowner
      )
    )
  as target_generation_fences_ready;
SQL
)"
if [[ "$fences_ready" != "t" ]]; then
  echo "oauth target-fence QA failed: target generation fences are not intact ($fences_ready)" >&2
  exit 1
fi

receipt_append_only="$(
  docker exec -i "$db_container" \
    psql -X -Aqt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" <<'SQL'
select exists (
  select 1
    from pg_catalog.pg_trigger t
   where t.tgrelid =
     pg_catalog.to_regclass('public.legacy_signup_migration_receipts')
     and t.tgname = 'trg_legacy_signup_migration_receipt_append_only'
     and t.tgtype = 27
)::text;
SQL
)"
if [[ "$receipt_append_only" != "true" ]]; then
  echo "oauth target-fence QA failed: legacy signup receipt append-only trigger is missing" >&2
  exit 1
fi

echo "oauth target-fence QA passed: catalog integrity + target generation fences"
