#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

if (( $# != 1 )) || { [[ "$1" != "expand" ]] && [[ "$1" != "contract" ]]; }; then
  echo "usage: $0 <expand|contract>" >&2
  exit 2
fi
expected_stage="$1"

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
    --stage "$expected_stage" \
    | docker exec -i "$db_container" \
      psql -X -Aqt -v ON_ERROR_STOP=1 \
        -U "$db_user" -d "$db_name"
)"
if [[ "$catalog_integrity" != "ready" ]]; then
  echo "OAuth function/constraint/owner catalog integrity mismatch" >&2
  exit 1
fi

actual_stage="$(
  docker exec -i "$db_container" \
    psql -X -Aqt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" <<'SQL'
with oauth_rpcs(rpc) as (
  values
    (pg_catalog.to_regprocedure(
      'public.begin_oauth_flow_intent(uuid,uuid,uuid,boolean,text,text,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.claim_oauth_flow_intent(uuid,uuid,uuid,text,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.bind_oauth_flow_intent_target(uuid,uuid,uuid,text,uuid,uuid,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.read_oauth_flow_intent_status(uuid,uuid,uuid,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.oauth_anon_privacy_status()'
    )),
    (pg_catalog.to_regprocedure(
      'public.recover_oauth_flow_intent_authority(uuid,uuid,uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.verify_oauth_flow_source_session_evidence(uuid,uuid,uuid,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.verify_oauth_flow_target_session_evidence(uuid,uuid,uuid,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.read_oauth_flow_target_session_evidence(uuid,uuid,uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.rotate_oauth_flow_target_session_evidence(uuid,uuid,uuid,text,text,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.release_oauth_flow_intent(uuid,uuid,uuid,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.finalize_oauth_flow_intent(uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.confirm_oauth_flow_signout_revoke(uuid,uuid,uuid,text,uuid,uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.complete_oauth_flow_signout(uuid,uuid,uuid,text,uuid,uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.complete_recovered_oauth_flow_signout(uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.cancel_oauth_flow_intent(uuid,uuid,uuid,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.abandon_oauth_flow_intent(uuid,uuid,uuid,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.revoke_bound_oauth_flow_target_session(uuid,uuid,uuid,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.expire_oauth_flow_intent(uuid)'
    )),
    (pg_catalog.to_regprocedure(
      'public.consume_oauth_flow_intent_migration(uuid,uuid,uuid,uuid,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.claim_oauth_anon_auth_cleanup(uuid,integer)'
    )),
    (pg_catalog.to_regprocedure(
      'public.verify_oauth_anon_auth_cleanup_source(uuid,uuid,integer)'
    )),
    (pg_catalog.to_regprocedure(
      'public.finish_oauth_anon_auth_cleanup(uuid,uuid,integer,text,text)'
    )),
    (pg_catalog.to_regprocedure(
      'public.prune_oauth_flow_intents(integer)'
    ))
),
oauth_rpc_names(name) as (
  values
    ('begin_oauth_flow_intent'),
    ('claim_oauth_flow_intent'),
    ('bind_oauth_flow_intent_target'),
    ('read_oauth_flow_intent_status'),
    ('oauth_anon_privacy_status'),
    ('recover_oauth_flow_intent_authority'),
    ('recover_active_oauth_flow_by_observed_session'),
    ('verify_oauth_flow_source_session_evidence'),
    ('verify_oauth_flow_target_session_evidence'),
    ('read_oauth_flow_target_session_evidence'),
    ('rotate_oauth_flow_target_session_evidence'),
    ('release_oauth_flow_intent'),
    ('finalize_oauth_flow_intent'),
    ('confirm_oauth_flow_signout_revoke'),
    ('complete_oauth_flow_signout'),
    ('complete_recovered_oauth_flow_signout'),
    ('cancel_oauth_flow_intent'),
    ('abandon_oauth_flow_intent'),
    ('revoke_bound_oauth_flow_target_session'),
    ('expire_oauth_flow_intent'),
    ('consume_oauth_flow_intent_migration'),
    ('claim_oauth_anon_auth_cleanup'),
    ('verify_oauth_anon_auth_cleanup_source'),
    ('finish_oauth_anon_auth_cleanup'),
    ('prune_oauth_flow_intents')
),
actual_oauth_rpcs(rpc) as (
  select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n
      on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       select name from oauth_rpc_names
     )
),
facts as (
  select
    (
      pg_catalog.to_regclass('public.oauth_flow_intents')
        is not null
      and pg_catalog.to_regclass(
        'public.oauth_anon_auth_cleanup_jobs'
      ) is not null
    ) as oauth_table,
    (
      pg_catalog.to_regclass(
        'public.oauth_rollout_deployment_qualifications'
      ) is not null
      and coalesce(
        (
          select c.relrowsecurity
            from pg_catalog.pg_class c
           where c.oid = pg_catalog.to_regclass(
             'public.oauth_rollout_deployment_qualifications'
           )
        ),
        false
      )
      and pg_catalog.to_regprocedure(
        'public.guard_oauth_rollout_deployment_qualification()'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.assert_oauth_rollout_deployment_qualification(text)'
      ) is not null
      and exists (
        select 1
          from pg_catalog.pg_trigger t
         where t.tgrelid = pg_catalog.to_regclass(
           'public.oauth_rollout_deployment_qualifications'
         )
           and t.tgname =
             'trg_oauth_rollout_deployment_qualification_append_only'
           and not t.tgisinternal
           and t.tgenabled = 'O'
           and t.tgtype = 27
      )
      and not exists (
        select 1
          from pg_catalog.pg_class c
          cross join lateral pg_catalog.aclexplode(
            coalesce(
              c.relacl,
              pg_catalog.acldefault('r'::"char", c.relowner)
            )
          ) acl
         where c.oid = pg_catalog.to_regclass(
           'public.oauth_rollout_deployment_qualifications'
         )
           and acl.grantee <> c.relowner
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
             'public.guard_oauth_rollout_deployment_qualification()'
           ),
           pg_catalog.to_regprocedure(
             'public.assert_oauth_rollout_deployment_qualification(text)'
           )
         )
           and acl.privilege_type = 'EXECUTE'
           and acl.grantee <> p.proowner
      )
    ) as qualification_private,
    (
      select pg_catalog.count(*)
        from public.oauth_rollout_deployment_qualifications
    ) as qualification_count,
    (
      pg_catalog.to_regclass(
        'public.legacy_signup_migration_receipts'
      ) is not null
      and coalesce(
        (
          select c.relrowsecurity
            from pg_catalog.pg_class c
           where c.oid = pg_catalog.to_regclass(
             'public.legacy_signup_migration_receipts'
           )
        ),
        false
      )
      and exists (
        select 1
          from pg_catalog.pg_trigger t
         where t.tgrelid = pg_catalog.to_regclass(
           'public.legacy_signup_migration_receipts'
         )
           and t.tgname =
             'trg_legacy_signup_migration_receipt_append_only'
           and not t.tgisinternal
           and t.tgenabled = 'O'
           and t.tgtype = 27
           and t.tgfoid = pg_catalog.to_regprocedure(
             'public.guard_legacy_signup_migration_receipt()'
           )
      )
      and not exists (
        select 1
          from pg_catalog.pg_class c
          cross join lateral pg_catalog.aclexplode(
            coalesce(
              c.relacl,
              pg_catalog.acldefault('r'::"char", c.relowner)
            )
          ) acl
         where c.oid = pg_catalog.to_regclass(
           'public.legacy_signup_migration_receipts'
         )
           and acl.grantee <> c.relowner
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
         where p.oid = pg_catalog.to_regprocedure(
           'public.guard_legacy_signup_migration_receipt()'
         )
           and acl.privilege_type = 'EXECUTE'
           and acl.grantee <> p.proowner
      )
    ) as legacy_receipt_private,
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
    ) as target_generation_fences_ready,
    (
      pg_catalog.to_regprocedure(
        'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
      ) is not null
      and (
        select pg_catalog.count(*) = 1
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n
            on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'consume_legacy_signup_migration'
      )
    ) as legacy_bridge_ready,
    coalesce(
      pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
        ),
        'EXECUTE'
      ),
      false
    ) as service_legacy_bridge_execute,
    coalesce(
      pg_catalog.has_function_privilege(
        'anon',
        pg_catalog.to_regprocedure(
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
        ),
        'EXECUTE'
      ),
      false
    ) as anon_legacy_bridge_execute,
    coalesce(
      pg_catalog.has_function_privilege(
        'authenticated',
        pg_catalog.to_regprocedure(
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
        ),
        'EXECUTE'
      ),
      false
    ) as authenticated_legacy_bridge_execute,
    exists (
      select 1
        from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            p.proacl,
            pg_catalog.acldefault('f'::"char", p.proowner)
          )
        ) acl
       where p.oid = pg_catalog.to_regprocedure(
         'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
       )
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
    ) as public_legacy_bridge_execute,
    exists (
      select 1
        from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            p.proacl,
            pg_catalog.acldefault('f'::"char", p.proowner)
          )
        ) acl
       where p.oid = pg_catalog.to_regprocedure(
         'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
       )
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee <> p.proowner
         and acl.grantee <> coalesce(
           (
             select role.oid
               from pg_catalog.pg_roles role
              where role.rolname = 'service_role'
           ),
           0
         )
    ) as legacy_bridge_unexpected_execute,
    pg_catalog.obj_description(
      pg_catalog.to_regprocedure(
        'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
      ),
      'pg_proc'
    ) as legacy_bridge_comment,
    pg_catalog.to_regprocedure(
      'public.begin_oauth_flow_intent(uuid,uuid,uuid,boolean,text,text,text,text)'
    ) is not null as begin_rpc,
    pg_catalog.to_regprocedure(
      'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'
    ) is not null as recover_rpc,
    pg_catalog.to_regprocedure(
      'public.consume_oauth_flow_intent_migration(uuid,uuid,uuid,uuid,text,text)'
    ) is not null as consume_rpc,
    pg_catalog.to_regprocedure(
      'public.prune_oauth_flow_intents(integer)'
    ) is not null as prune_rpc,
    (
      select pg_catalog.count(rpc) = 25
        from oauth_rpcs
    ) as scoped_rpcs_ready,
    (
      (
        select pg_catalog.count(rpc) = 25
          from oauth_rpcs
      )
      and
      (
        select
          pg_catalog.count(*) = 25
          and pg_catalog.count(expected.rpc) = 25
          from actual_oauth_rpcs actual
          left join oauth_rpcs expected
            on expected.rpc = actual.rpc
      )
    ) as scoped_rpc_inventory_exact,
    (
      select pg_catalog.count(rpc) = 25
         and coalesce(
               pg_catalog.bool_and(
                 pg_catalog.has_function_privilege(
                   'service_role',
                   rpc,
                   'EXECUTE'
                 )
               ),
               false
             )
        from oauth_rpcs
    ) as scoped_service_execute,
    exists (
      select 1
        from oauth_rpcs
       where coalesce(
         pg_catalog.has_function_privilege('anon', rpc, 'EXECUTE'),
         false
       )
    ) as scoped_anon_execute,
    exists (
      select 1
        from oauth_rpcs
       where coalesce(
         pg_catalog.has_function_privilege(
           'authenticated',
           rpc,
           'EXECUTE'
         ),
         false
       )
    ) as scoped_authenticated_execute,
    exists (
      select 1
        from oauth_rpcs r
        join pg_catalog.pg_proc p
          on p.oid = r.rpc
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            p.proacl,
            pg_catalog.acldefault('f'::"char", p.proowner)
          )
        ) acl
       where acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
    ) as scoped_public_execute,
    exists (
      select 1
        from oauth_rpcs r
        join pg_catalog.pg_proc p
          on p.oid = r.rpc
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            p.proacl,
            pg_catalog.acldefault('f'::"char", p.proowner)
          )
        ) acl
       where acl.privilege_type = 'EXECUTE'
         and acl.grantee <> p.proowner
         and acl.grantee <> coalesce(
           (
             select role.oid
               from pg_catalog.pg_roles role
              where role.rolname = 'service_role'
           ),
           0
         )
    ) as scoped_unexpected_execute,
    (
      coalesce(
        (
          select c.relrowsecurity
            from pg_catalog.pg_class c
           where c.oid =
             pg_catalog.to_regclass('public.oauth_flow_intents')
        ),
        false
      )
      and coalesce(
        (
          select c.relrowsecurity
            from pg_catalog.pg_class c
           where c.oid = pg_catalog.to_regclass(
             'public.oauth_anon_auth_cleanup_jobs'
           )
        ),
        false
      )
    ) as table_rls_enabled,
    (
      coalesce(
        pg_catalog.has_table_privilege(
          'service_role',
          pg_catalog.to_regclass('public.oauth_flow_intents'),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ),
        false
      )
      or coalesce(
        pg_catalog.has_table_privilege(
          'service_role',
          pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          ),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ),
        false
      )
    ) as service_table_privilege,
    (
      coalesce(
        pg_catalog.has_table_privilege(
          'anon',
          pg_catalog.to_regclass('public.oauth_flow_intents'),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ),
        false
      )
      or coalesce(
        pg_catalog.has_table_privilege(
          'anon',
          pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          ),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ),
        false
      )
    ) as anon_table_privilege,
    (
      coalesce(
        pg_catalog.has_table_privilege(
          'authenticated',
          pg_catalog.to_regclass('public.oauth_flow_intents'),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ),
        false
      )
      or coalesce(
        pg_catalog.has_table_privilege(
          'authenticated',
          pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          ),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ),
        false
      )
    ) as authenticated_table_privilege,
    exists (
      select 1
        from pg_catalog.pg_class c
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            c.relacl,
            pg_catalog.acldefault('r'::"char", c.relowner)
          )
        ) acl
       where c.oid in (
         pg_catalog.to_regclass('public.oauth_flow_intents'),
         pg_catalog.to_regclass(
           'public.oauth_anon_auth_cleanup_jobs'
         )
       )
         and acl.grantee = 0
    ) as public_table_privilege,
    pg_catalog.has_function_privilege(
      'service_role',
      'public.reassign_anon_data(uuid,uuid)',
      'EXECUTE'
    ) as service_raw_execute,
    pg_catalog.has_function_privilege(
      'anon',
      'public.reassign_anon_data(uuid,uuid)',
      'EXECUTE'
    ) as anon_raw_execute,
    pg_catalog.has_function_privilege(
      'authenticated',
      'public.reassign_anon_data(uuid,uuid)',
      'EXECUTE'
    ) as authenticated_raw_execute,
    exists (
      select 1
        from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            p.proacl,
            pg_catalog.acldefault('f'::"char", p.proowner)
          )
        ) acl
       where p.oid =
         'public.reassign_anon_data(uuid,uuid)'::regprocedure
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
    ) as public_raw_execute,
    exists (
      select 1
        from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            p.proacl,
            pg_catalog.acldefault('f'::"char", p.proowner)
          )
        ) acl
       where p.oid =
         'public.reassign_anon_data(uuid,uuid)'::regprocedure
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee <> p.proowner
         and acl.grantee <> coalesce(
           (
             select role.oid
               from pg_catalog.pg_roles role
              where role.rolname = 'service_role'
           ),
           0
         )
    ) as raw_unexpected_execute,
    pg_catalog.obj_description(
      'public.reassign_anon_data(uuid,uuid)'::regprocedure,
      'pg_proc'
    ) as raw_comment
)
select case
  when oauth_table
   and qualification_private
   and qualification_count = 0
   and legacy_receipt_private
   and target_generation_fences_ready
   and legacy_bridge_ready
   and service_legacy_bridge_execute
   and not anon_legacy_bridge_execute
   and not authenticated_legacy_bridge_execute
   and not public_legacy_bridge_execute
   and not legacy_bridge_unexpected_execute
   and legacy_bridge_comment is null
   and begin_rpc
   and recover_rpc
   and consume_rpc
   and prune_rpc
   and scoped_rpcs_ready
   and scoped_rpc_inventory_exact
   and scoped_service_execute
   and not scoped_anon_execute
   and not scoped_authenticated_execute
   and not scoped_public_execute
   and not scoped_unexpected_execute
   and table_rls_enabled
   and not service_table_privilege
   and not anon_table_privilege
   and not authenticated_table_privilege
   and not public_table_privilege
   and service_raw_execute
   and not anon_raw_execute
   and not authenticated_raw_execute
   and not public_raw_execute
   and not raw_unexpected_execute
   and raw_comment is null
    then 'expand'
  when oauth_table
   and qualification_private
   and qualification_count = 1
   and legacy_receipt_private
   and target_generation_fences_ready
   and legacy_bridge_ready
   and not service_legacy_bridge_execute
   and not anon_legacy_bridge_execute
   and not authenticated_legacy_bridge_execute
   and not public_legacy_bridge_execute
   and not legacy_bridge_unexpected_execute
   and legacy_bridge_comment =
     'Expand-only pre-ledger cookie bridge; execution revoked after the full deployment drain.'
   and begin_rpc
   and recover_rpc
   and consume_rpc
   and prune_rpc
   and scoped_rpcs_ready
   and scoped_rpc_inventory_exact
   and scoped_service_execute
   and not scoped_anon_execute
   and not scoped_authenticated_execute
   and not scoped_public_execute
   and not scoped_unexpected_execute
   and table_rls_enabled
   and not service_table_privilege
   and not anon_table_privilege
   and not authenticated_table_privilege
   and not public_table_privilege
   and not service_raw_execute
   and not anon_raw_execute
   and not authenticated_raw_execute
   and not public_raw_execute
   and not raw_unexpected_execute
   and raw_comment =
     'Internal primitive; invoke only through flow-scoped OAuth migration consumption.'
    then 'contract'
  else 'invalid'
end
from facts;
SQL
)"

if [[ "$actual_stage" != "$expected_stage" ]]; then
  echo "OAuth rollout stage mismatch: expected=$expected_stage actual=$actual_stage" >&2
  exit 1
fi

prune_keys="$(
  docker exec -i "$db_container" \
    psql -X -Aqt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" <<'SQL'
begin;
set local statement_timeout = '30s';
select pg_catalog.string_agg(key, ',' order by key)
  from pg_catalog.jsonb_object_keys(
    public.prune_oauth_flow_intents(1)
  ) as keys(key);
rollback;
SQL
)"
expected_prune_keys="boundRecoveryBacklog,boundRecoveryConverged,expiredPending,pendingExpiryBacklog,prunedTerminal,targetAuthorityLossBacklog,targetAuthorityLossConverged,terminalRetentionBacklog,unboundClaimBacklog,unconsumedMigrationBacklog,unreleasedContinueBacklog"
if [[ "$prune_keys" != "$expected_prune_keys" ]]; then
  echo "OAuth prune acknowledgement mismatch: expected exact eleven-key contract" >&2
  exit 1
fi

echo "OAuth rollout $expected_stage stage QA passed"
