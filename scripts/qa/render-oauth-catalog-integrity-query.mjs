#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  OAUTH_ANON_RESULT_CONSTRAINT_EXPRESSION,
  OAUTH_DEIDENTIFIED_REASON_CONSTRAINT_EXPRESSION,
  OAUTH_TARGET_IDENTITY_CONSTRAINT_EXPRESSION,
  readOAuthCatalogFunctionManifest,
} from "./apply-oauth-production-rollout.mjs";
import {
  OAUTH_CATALOG_RELATION_NAMES,
  OAUTH_EXPECTED_RELATION_FINGERPRINTS,
  renderOAuthRelationFingerprintCtes,
} from "./oauth-relation-fingerprints.mjs";

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function renderOAuthCatalogIntegrityQuery(
  expandSql,
  dependencySources,
  stage = "expand",
) {
  if (stage !== "expand" && stage !== "contract") {
    throw new Error("oauth_catalog_stage_invalid");
  }
  const manifest = readOAuthCatalogFunctionManifest(
    expandSql,
    dependencySources,
  );
  const values = manifest
    .map(
      ({
        name,
        bodySha256,
        functionArguments,
        functionResult,
        language,
        securityDefiner,
        volatility,
        strict,
        parallel,
        executeAcl,
      }) => {
        const expectedExecuteAcl =
          executeAcl === "owner_or_service"
            ? stage === "expand"
              ? "service"
              : "owner"
            : executeAcl;
        return `    (${sqlLiteral(name)}, ${sqlLiteral(
          bodySha256,
        )}, ${sqlLiteral(functionArguments)}, ${sqlLiteral(
          functionResult,
        )}, ${sqlLiteral(language)}, ${securityDefiner}, ${sqlLiteral(
          volatility,
        )}, ${strict}, ${sqlLiteral(parallel)}, ${sqlLiteral(
          expectedExecuteAcl,
        )})`;
      },
    )
    .join(",\n");
  const relationFingerprintValues = OAUTH_CATALOG_RELATION_NAMES.map(
    (relationName) =>
      `    (${sqlLiteral(relationName)}, ${sqlLiteral(
        OAUTH_EXPECTED_RELATION_FINGERPRINTS[relationName],
      )})`,
  ).join(",\n");
  return `with ${renderOAuthRelationFingerprintCtes()},
expected_relation_fingerprints(
  relation_name,
  catalog_sha256
) as (
  values
${relationFingerprintValues}
),
expected_function_bodies(
  name,
  body_sha256,
  function_arguments,
  function_result,
  language_name,
  security_definer,
  volatility,
  strict,
  parallel,
  execute_acl
) as (
  values
${values}
),
expected_triggers(
  relation_name,
  trigger_name,
  function_signature,
  trigger_type,
  update_attributes
) as (
  values
    (
      'public.anon_data_reassignments',
      'trg_anon_data_reassignment_append_only',
      'public.guard_anon_data_reassignment_append_only()',
      27,
      array[]::text[]
    ),
    (
      'public.oauth_deidentified_score_owner_tombstones',
      'trg_oauth_deidentified_score_owner_tombstone_append_only',
      'public.guard_oauth_deidentified_score_owner_tombstone()',
      27,
      array[]::text[]
    ),
    (
      'public.score_highlights',
      'trg_score_highlights_clear_oauth_quarantine_marker',
      'public.clear_oauth_quarantined_score_highlight_marker()',
      19,
      array[
        'highlight_deleted_at',
        'highlight_deleted_by_doll'
      ]::text[]
    ),
    (
      'public.oauth_auth_session_id_tombstones',
      'trg_oauth_auth_session_id_tombstone_append_only',
      'public.guard_oauth_auth_session_id_tombstone()',
      27,
      array[]::text[]
    ),
    (
      'public.oauth_flow_intents',
      'trg_oauth_flow_tombstone_auth_session_ids',
      'public.tombstone_oauth_flow_auth_session_ids()',
      11,
      array[]::text[]
    ),
    (
      'public.oauth_anon_auth_cleanup_jobs',
      'trg_oauth_cleanup_tombstone_consumed_session_id',
      'public.tombstone_oauth_cleanup_consumed_session_id()',
      11,
      array[]::text[]
    ),
    (
      'public.profiles',
      'trg_profiles_guard_oauth_deidentified_score_owner_delete',
      'public.guard_oauth_deidentified_score_owner_profile_delete()',
      11,
      array[]::text[]
    ),
    (
      'public.legacy_signup_migration_receipts',
      'trg_legacy_signup_migration_receipt_append_only',
      'public.guard_legacy_signup_migration_receipt()',
      27,
      array[]::text[]
    ),
    (
      'auth.users',
      'trg_auth_users_fence_oauth_anon_cleanup_insert',
      'public.fence_oauth_anon_auth_cleanup_user()',
      7,
      array[]::text[]
    ),
    (
      'auth.users',
      'trg_auth_users_fence_oauth_anon_cleanup_update',
      'public.fence_oauth_anon_auth_cleanup_user()',
      19,
      array[
        'created_at',
        'id',
        'instance_id',
        'is_anonymous'
      ]::text[]
    ),
    (
      'auth.users',
      'trg_auth_users_fence_oauth_retained_anon_delete',
      'public.fence_oauth_retained_anon_auth_delete()',
      11,
      array[]::text[]
    ),
    (
      'auth.sessions',
      'trg_auth_sessions_fence_revoked_oauth_target_id',
      'public.fence_revoked_oauth_target_session_id()',
      23,
      array['created_at', 'id', 'user_id']::text[]
    ),
    (
      'public.oauth_rollout_deployment_qualifications',
      'trg_oauth_rollout_deployment_qualification_append_only',
      'public.guard_oauth_rollout_deployment_qualification()',
      27,
      array[]::text[]
    ),
    (
      'public.anon_data_reassignments',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.oauth_flow_intents',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.oauth_anon_auth_cleanup_jobs',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.oauth_quarantined_score_highlights',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.oauth_deidentified_score_owner_tombstones',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.oauth_auth_session_id_tombstones',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.legacy_signup_migration_receipts',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    ),
    (
      'public.oauth_rollout_deployment_qualifications',
      'trg_oauth_critical_relation_truncate',
      'public.guard_oauth_critical_relation_truncate()',
      34,
      array[]::text[]
    )
),
expected_flow_columns(
  column_name,
  formatted_type,
  not_null,
  generated_kind,
  default_expression
) as (
  values
    ('flow_id', 'uuid', true, '', null::text),
    ('source_user_id', 'uuid', true, '', null::text),
    ('source_session_id', 'uuid', true, '', null::text),
    (
      'source_access_token_sha256',
      'text',
      true,
      '',
      null::text
    ),
    (
      'source_refresh_token_sha256',
      'text',
      true,
      '',
      null::text
    ),
    ('source_is_anonymous', 'boolean', true, '', null::text),
    ('provider', 'text', true, '', null::text),
    ('requested_next', 'text', true, '', null::text),
    ('state', 'text', true, '', '''pending''::text'),
    (
      'active',
      'boolean',
      false,
      's',
      '(state = ANY (ARRAY[''pending''::text, ''claimed''::text, ''signout_required''::text, ''signout_revoked''::text]))'
    ),
    (
      'session_fenced',
      'boolean',
      false,
      's',
      '((state = ANY (ARRAY[''pending''::text, ''claimed''::text, ''signout_required''::text, ''signout_revoked''::text])) OR ((state = ''completed''::text) AND (action = ''continue''::text) AND (released_at IS NULL)))'
    ),
    ('target_user_id', 'uuid', false, '', null::text),
    ('target_session_id', 'uuid', false, '', null::text),
    (
      'target_auth_created_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    ('target_auth_instance_id', 'uuid', false, '', null::text),
    (
      'target_session_created_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    (
      'target_access_token_sha256',
      'text',
      false,
      '',
      null::text
    ),
    (
      'target_refresh_token_sha256',
      'text',
      false,
      '',
      null::text
    ),
    ('destination', 'text', false, '', null::text),
    ('action', 'text', false, '', null::text),
    (
      'created_at',
      'timestamp with time zone',
      true,
      '',
      null::text
    ),
    (
      'expires_at',
      'timestamp with time zone',
      true,
      '',
      null::text
    ),
    (
      'claimed_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    (
      'revoke_confirmed_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    (
      'finished_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    (
      'released_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    (
      'migration_consumed_at',
      'timestamp with time zone',
      false,
      '',
      null::text
    ),
    ('migration_result', 'jsonb', false, '', null::text)
),
expected_flow_checks(
  constraint_name,
  expression_sha256
) as (
  values
    (
      'oauth_flow_intents_action_check',
      '753208dba5afb8d3f63bbee4ac407e338a0eee4ba1e309d8ddde28b7b776c437'
    ),
    (
      'oauth_flow_intents_destination_check',
      'c745ea0572574bc5522308757e3d270c228bf817a610c4dd16b0dd0d0e160bed'
    ),
    (
      'oauth_flow_intents_migration_receipt_check',
      'd99469c03b4ea96d1db5843e20b88304acc1b3d425dc86348e2782ed688f8ee0'
    ),
    (
      'oauth_flow_intents_provider_check',
      '5d9a0dad1ab96214f582a35f23a6879b286343241ca55c20cf4f9f3eefcda054'
    ),
    (
      'oauth_flow_intents_requested_next_check',
      'c6acdf6fba2122bdd0a78f6359ab43da0e0fa7fda0c2aec48794de14e8707fd7'
    ),
    (
      'oauth_flow_intents_source_evidence_check',
      'abeeb3ff7bbdac84d44532d0288b2c2052c383c279b62dd45d23a1ab15e14e5a'
    ),
    (
      'oauth_flow_intents_state_check',
      '5543d7bea7d9624b6ecfede7569e37ce4554b31c58ae0091298c462e47658ce2'
    ),
    (
      'oauth_flow_intents_state_shape_check',
      'e33d3d2e579f61e53c04116c6209932712d65d70e9976d829add2d11105385fc'
    ),
    (
      'oauth_flow_intents_target_evidence_check',
      '9c2879554670bc68dc7fa77ee4908dd3e973962228f2da99e9230fcdc65bccf3'
    ),
    (
      'oauth_flow_intents_target_identity_check',
      'bbc8f3d2efa6b5e34d54791588f85baac2931d3113b264583630666a72bdcd43'
    ),
    (
      'oauth_flow_intents_time_order_check',
      '395c2c14967eff3db7610e1b051c61c2c6ffb8be8fcdad8e597ff6deb05cc060'
    )
),
expected_flow_indexes(
  index_name,
  unique_index,
  key_columns,
  predicate_sha256
) as (
  values
    (
      'oauth_flow_intents_fenced_target_session_idx',
      false,
      array[
        'target_session_id',
        'target_user_id',
        'flow_id'
      ]::text[],
      '29f8db980a778645866002e3dc8d11ddc932e52363d098704d07aec73f8d2bb8'
    ),
    (
      'oauth_flow_intents_one_fenced_source_session_uidx',
      true,
      array['source_session_id']::text[],
      '5a208167d58de041e7a8d114c9c2dccf88556b0b42d9e31a05ae2ae68c34f292'
    ),
    (
      'oauth_flow_intents_pending_expiry_idx',
      false,
      array['expires_at', 'flow_id']::text[],
      '9a5000bd6a87180c536e58e3b5bdc4fbdd0ea95b544e3e5225feb38b5e672555'
    ),
    (
      'oauth_flow_intents_revoked_target_session_idx',
      false,
      array['target_session_id', 'flow_id']::text[],
      '3c9f96826acb5ea707bdca8dc0659d325a60b012e69e1311193031ad27ea28b3'
    ),
    (
      'oauth_flow_intents_terminal_retention_idx',
      false,
      array['finished_at', 'flow_id']::text[],
      'fe4cf9ef9bb78c3f772d40234ba2e4bfe1cf979d2f8bee866d7047ad44c52fd5'
    )
),
expected_cleanup_columns(
  column_name,
  formatted_type,
  not_null,
  default_expression
) as (
  values
    ('cleanup_id', 'uuid', true, 'gen_random_uuid()'),
    ('flow_id', 'uuid', false, null::text),
    ('legacy_source_user_id', 'uuid', false, null::text),
    ('source_user_id', 'uuid', true, null::text),
    (
      'source_auth_created_at',
      'timestamp with time zone',
      true,
      null::text
    ),
    ('source_auth_instance_id', 'uuid', false, null::text),
    ('status', 'text', true, '''dormant''::text'),
    ('quarantine_reason', 'text', false, null::text),
    (
      'quarantined_at',
      'timestamp with time zone',
      false,
      null::text
    ),
    (
      'recover_until',
      'timestamp with time zone',
      false,
      null::text
    ),
    ('scrubbed_at', 'timestamp with time zone', false, null::text),
    (
      'access_revoked_at',
      'timestamp with time zone',
      false,
      null::text
    ),
    ('consumed_target_session_id', 'uuid', false, null::text),
    (
      'consumed_target_session_created_at',
      'timestamp with time zone',
      false,
      null::text
    ),
    (
      'consumed_access_token_sha256',
      'text',
      false,
      null::text
    ),
    (
      'consumed_refresh_token_sha256',
      'text',
      false,
      null::text
    ),
    ('lease_token', 'uuid', false, null::text),
    ('lease_version', 'integer', true, '0'),
    ('attempt_count', 'integer', true, '0'),
    (
      'next_attempt_at',
      'timestamp with time zone',
      false,
      null::text
    ),
    (
      'lease_expires_at',
      'timestamp with time zone',
      false,
      null::text
    ),
    ('last_error', 'text', false, null::text),
    ('created_at', 'timestamp with time zone', true, null::text),
    ('armed_at', 'timestamp with time zone', false, null::text),
    ('finished_at', 'timestamp with time zone', false, null::text)
),
expected_cleanup_checks(
  constraint_name,
  expression_sha256
) as (
  values
    (
      'oauth_anon_auth_cleanup_jobs_attempt_count_check',
      '4a1032cc42b2768261897493ba4fbfa2b28d45845cb42d04b122fe41ff92b5ee'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_consumed_authority_check',
      '3986a9ff923b2743de715c796bd180fe28f4a0f5c76fbb0cd3ff885f9f65d9a1'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_last_error_check',
      '4c2541aeab582cdf01422f0362cb8ff129bb17ec1724a38a857decd0cbc34fbb'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_lease_version_check',
      '1c0f5a5a7349929e85c9cf3a4b2f4b001315d0e11f1cb2336ca5317a688a1341'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_origin_check',
      '89cafa754c2a8716c0b9fc233852a9bc423997f8ceab548580b73e973351ff0f'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_quarantine_check',
      '203e462b7fded7e61275ad702682f96747b7f3593144ee13e760e8d0549684ca'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_quarantine_reason_check',
      '572a4d2f35ac95a49d572913f7b617ff7fdc77acba44d47148952750a1e06ba6'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_shape_check',
      'c96d0f3106fee6d53d1a645789180d2d03c90a79fb74c120c3e86d71ccfb6ef6'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_status_check',
      'f4f46ef05174d0cd1abf482eab66f73f509c2f3a0bcf1ca4e1ec584ccc9f0e23'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_time_check',
      '5501322f0cf6a4727ea79422fd9c2d5bca9a5aecfd3a586da4d043dc3f710225'
    )
),
expected_cleanup_keys(
  constraint_name,
  constraint_type,
  key_columns,
  referenced_relation,
  referenced_columns
) as (
  values
    (
      'oauth_anon_auth_cleanup_jobs_pkey',
      'p',
      array['cleanup_id']::text[],
      null::text,
      array[]::text[]
    ),
    (
      'oauth_anon_auth_cleanup_jobs_flow_id_key',
      'u',
      array['flow_id']::text[],
      null::text,
      array[]::text[]
    ),
    (
      'oauth_anon_auth_cleanup_jobs_flow_id_fkey',
      'f',
      array['flow_id']::text[],
      'public.oauth_flow_intents',
      array['flow_id']::text[]
    ),
    (
      'oauth_anon_auth_cleanup_jobs_legacy_source_user_id_key',
      'u',
      array['legacy_source_user_id']::text[],
      null::text,
      array[]::text[]
    ),
    (
      'oauth_anon_auth_cleanup_jobs_legacy_source_user_id_fkey',
      'f',
      array['legacy_source_user_id']::text[],
      'public.anon_data_reassignments',
      array['source_user_id']::text[]
    )
),
expected_cleanup_indexes(
  index_name,
  unique_index,
  key_columns,
  predicate_sha256
) as (
  values
    (
      'oauth_anon_auth_cleanup_jobs_claim_idx',
      false,
      array['next_attempt_at', 'created_at', 'cleanup_id']::text[],
      '38550aebb4a7ebce37a75658af016a77ee171e323a490c067281816d1033a978'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_flow_source_generation_uidx',
      true,
      array['source_user_id']::text[],
      '0ad8561a6671089224d219c0ac72fba3948056f5ee9aee3b82fe9eccb807609b'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_privacy_due_idx',
      false,
      array['recover_until', 'created_at', 'cleanup_id']::text[],
      '696e89043ea1a75661d229092ca1a48eb8231300dba553889064cb2dd122a238'
    ),
    (
      'oauth_anon_auth_cleanup_jobs_source_fence_idx',
      false,
      array['source_user_id', 'status', 'cleanup_id']::text[],
      '38550aebb4a7ebce37a75658af016a77ee171e323a490c067281816d1033a978'
    )
),
function_integrity as (
  select
    pg_catalog.count(*) = ${manifest.length}
    and pg_catalog.count(p.oid) = ${manifest.length}
    and coalesce(
      pg_catalog.bool_and(
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(p.prosrc, 'UTF8')
          ),
          'hex'
        ) = expected.body_sha256
        and pg_catalog.pg_get_function_arguments(p.oid) =
          expected.function_arguments
        and pg_catalog.pg_get_function_result(p.oid) =
          expected.function_result
        and p.prosecdef = expected.security_definer
        and p.prolang = (
          select language.oid
            from pg_catalog.pg_language language
           where language.lanname = expected.language_name
        )
        and coalesce(p.proconfig, '{}'::text[]) =
          array['search_path=""']::text[]
        and p.provolatile = expected.volatility::"char"
        and p.proisstrict = expected.strict
        and p.proparallel = expected.parallel::"char"
        and not p.proleakproof
        and not p.proretset
        and p.prokind = 'f'
        and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
        and (
          select case expected.execute_acl
            when 'owner' then pg_catalog.count(*) = 0
            when 'authenticated' then
              pg_catalog.count(*) = 1
              and pg_catalog.count(*) filter (
                where acl.grantee = coalesce(
                  (
                    select role.oid
                      from pg_catalog.pg_roles role
                     where role.rolname = 'authenticated'
                  ),
                  0
                )
                  and not acl.is_grantable
              ) = 1
            when 'service' then
              pg_catalog.count(*) = 1
              and pg_catalog.count(*) filter (
                where acl.grantee = coalesce(
                  (
                    select role.oid
                      from pg_catalog.pg_roles role
                     where role.rolname = 'service_role'
                  ),
                  0
                )
                  and not acl.is_grantable
              ) = 1
            when 'owner_or_service' then
              pg_catalog.count(*) = 0
              or (
                pg_catalog.count(*) = 1
                and pg_catalog.count(*) filter (
                  where acl.grantee = coalesce(
                    (
                      select role.oid
                        from pg_catalog.pg_roles role
                       where role.rolname = 'service_role'
                    ),
                    0
                  )
                    and not acl.is_grantable
                ) = 1
              )
            else false
          end
              from pg_catalog.aclexplode(
                coalesce(
                  p.proacl,
                  pg_catalog.acldefault(
                    'f'::"char",
                    p.proowner
                  )
                )
              ) acl
             where acl.grantee <> p.proowner
               and acl.privilege_type = 'EXECUTE'
        )
      ),
      false
    ) as ready
    from expected_function_bodies expected
    left join pg_catalog.pg_namespace n
      on n.nspname = 'public'
    left join pg_catalog.pg_proc p
      on p.pronamespace = n.oid
     and p.proname = expected.name
),
flow_schema_integrity as (
  select
    (
      select pg_catalog.count(*) = 28
         and pg_catalog.count(a.attnum) = 28
         and (
           select pg_catalog.count(*) = 28
             from pg_catalog.pg_attribute actual
            where actual.attrelid = pg_catalog.to_regclass(
              'public.oauth_flow_intents'
            )
              and actual.attnum > 0
              and not actual.attisdropped
         )
         and coalesce(
           pg_catalog.bool_and(
             pg_catalog.format_type(
               a.atttypid,
               a.atttypmod
             ) = expected.formatted_type
             and a.attnotnull = expected.not_null
             and a.attidentity = ''
             and a.attgenerated::text = expected.generated_kind
             and a.attislocal
             and a.attinhcount = 0
             and coalesce(a.attstattarget, -1) = -1
             and a.attacl is null
             and a.attoptions is null
             and a.attfdwoptions is null
             and a.attcollation = attribute_type.typcollation
             and pg_catalog.pg_get_expr(
               default_value.adbin,
               default_value.adrelid
             ) is not distinct from expected.default_expression
           ),
           false
         )
        from expected_flow_columns expected
        left join pg_catalog.pg_attribute a
          on a.attrelid = pg_catalog.to_regclass(
            'public.oauth_flow_intents'
          )
         and a.attname = expected.column_name
         and a.attnum > 0
         and not a.attisdropped
        left join pg_catalog.pg_type attribute_type
          on attribute_type.oid = a.atttypid
        left join pg_catalog.pg_attrdef default_value
          on default_value.adrelid = a.attrelid
         and default_value.adnum = a.attnum
    )
    and (
      select pg_catalog.count(*) = 11
         and pg_catalog.count(c.oid) = 11
         and (
           select pg_catalog.count(*) = 11
             from pg_catalog.pg_constraint actual
            where actual.conrelid = pg_catalog.to_regclass(
              'public.oauth_flow_intents'
            )
              and actual.contype = 'c'
         )
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'c'
             and c.convalidated
             and not c.connoinherit
             and not c.condeferrable
             and not c.condeferred
             and c.conislocal
             and c.coninhcount = 0
             and c.conislocal
             and c.coninhcount = 0
             and pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_expr(c.conbin, c.conrelid),
                   'UTF8'
                 )
               ),
               'hex'
             ) = expected.expression_sha256
             and (
               c.conname <>
                 'oauth_flow_intents_target_identity_check'
               or pg_catalog.pg_get_expr(c.conbin, c.conrelid) =
                 ${sqlLiteral(
                   OAUTH_TARGET_IDENTITY_CONSTRAINT_EXPRESSION,
                 )}
             )
           ),
           false
         )
        from expected_flow_checks expected
        left join pg_catalog.pg_constraint c
          on c.conrelid = pg_catalog.to_regclass(
            'public.oauth_flow_intents'
          )
         and c.conname = expected.constraint_name
    )
    and (
      select pg_catalog.count(*) = 1
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'p'
             and c.convalidated
             and not c.condeferrable
             and not c.condeferred
             and c.conislocal
             and c.coninhcount = 0
             and c.confrelid = 0
             and c.confkey is null
             and (
               select pg_catalog.array_agg(
                 a.attname::text
                 order by key.ordinality
               )
                 from pg_catalog.unnest(c.conkey)
                   with ordinality as key(attnum, ordinality)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = c.conrelid
                  and a.attnum = key.attnum
             ) = array['flow_id']::text[]
             and exists (
               select 1
                 from pg_catalog.pg_index i
                 join pg_catalog.pg_class index_relation
                   on index_relation.oid = i.indexrelid
                 join pg_catalog.pg_am access_method
                   on access_method.oid = index_relation.relam
                where i.indexrelid = c.conindid
                  and i.indrelid = c.conrelid
                  and i.indisprimary
                  and i.indisunique
                  and not i.indisexclusion
                  and not i.indnullsnotdistinct
                  and i.indisvalid
                  and i.indisready
                  and i.indislive
                  and not i.indcheckxmin
                  and i.indnkeyatts = 1
                  and i.indnatts = 1
                  and i.indpred is null
                  and i.indexprs is null
                  and not exists (
                    select 1
                      from rows from (
                        pg_catalog.unnest(i.indkey::smallint[]),
                        pg_catalog.unnest(
                          i.indcollation::oid[]
                        ),
                        pg_catalog.unnest(i.indclass::oid[]),
                        pg_catalog.unnest(
                          i.indoption::smallint[]
                        )
                      ) with ordinality
                        as index_key(
                          attnum,
                          collation_oid,
                          opclass_oid,
                          index_option,
                          ordinality
                        )
                      join pg_catalog.pg_attribute key_attribute
                        on key_attribute.attrelid = i.indrelid
                       and key_attribute.attnum =
                         index_key.attnum
                      join pg_catalog.pg_opclass operator_class
                        on operator_class.oid =
                          index_key.opclass_oid
                     where index_key.ordinality <= i.indnkeyatts
                       and (
                         index_key.collation_oid <>
                           key_attribute.attcollation
                         or index_key.index_option <> 0
                         or operator_class.opcmethod <>
                           access_method.oid
                         or not operator_class.opcdefault
                         or operator_class.opcintype <>
                           key_attribute.atttypid
                       )
                  )
                  and index_relation.relkind = 'i'
                  and index_relation.relpersistence = 'p'
                  and index_relation.reloptions is null
                  and pg_catalog.pg_get_userbyid(
                    index_relation.relowner
                  ) = 'postgres'
                  and access_method.amname = 'btree'
             )
           ),
           false
         )
        from pg_catalog.pg_constraint c
       where c.conrelid = pg_catalog.to_regclass(
         'public.oauth_flow_intents'
       )
         and c.conname = 'oauth_flow_intents_pkey'
         and (
           select pg_catalog.count(*)
             from pg_catalog.pg_constraint all_keys
            where all_keys.conrelid = c.conrelid
              and all_keys.contype in ('p', 'u', 'f', 'x')
         ) = 1
    )
    and (
      select pg_catalog.count(*) = 5
         and pg_catalog.count(i.indexrelid) = 5
         and (
           select pg_catalog.count(*) = 5
             from pg_catalog.pg_index actual
            where actual.indrelid = pg_catalog.to_regclass(
              'public.oauth_flow_intents'
            )
              and not exists (
                select 1
                  from pg_catalog.pg_constraint constraint_index
                 where constraint_index.conindid =
                   actual.indexrelid
              )
         )
         and coalesce(
           pg_catalog.bool_and(
             i.indrelid = pg_catalog.to_regclass(
               'public.oauth_flow_intents'
             )
             and i.indisunique = expected.unique_index
             and not i.indisprimary
             and not i.indisexclusion
             and not i.indnullsnotdistinct
             and i.indisvalid
             and i.indisready
             and i.indislive
             and not i.indcheckxmin
             and i.indnkeyatts =
               pg_catalog.cardinality(expected.key_columns)
             and i.indnatts =
               pg_catalog.cardinality(expected.key_columns)
             and i.indexprs is null
             and i.indpred is not null
             and not exists (
               select 1
                 from rows from (
                   pg_catalog.unnest(i.indkey::smallint[]),
                   pg_catalog.unnest(i.indcollation::oid[]),
                   pg_catalog.unnest(i.indclass::oid[]),
                   pg_catalog.unnest(i.indoption::smallint[])
                 ) with ordinality
                   as index_key(
                     attnum,
                     collation_oid,
                     opclass_oid,
                     index_option,
                     ordinality
                   )
                 join pg_catalog.pg_attribute key_attribute
                   on key_attribute.attrelid = i.indrelid
                  and key_attribute.attnum = index_key.attnum
                 join pg_catalog.pg_opclass operator_class
                   on operator_class.oid = index_key.opclass_oid
                where index_key.ordinality <= i.indnkeyatts
                  and (
                    index_key.collation_oid <>
                      key_attribute.attcollation
                    or index_key.index_option <> 0
                    or operator_class.opcmethod <>
                      access_method.oid
                    or not operator_class.opcdefault
                    or operator_class.opcintype <>
                      key_attribute.atttypid
                  )
             )
             and index_relation.relkind = 'i'
             and index_relation.relpersistence = 'p'
             and index_relation.reloptions is null
             and pg_catalog.pg_get_userbyid(
               index_relation.relowner
             ) = 'postgres'
             and access_method.amname = 'btree'
             and (
               select pg_catalog.array_agg(
                 a.attname::text
                 order by key.ordinality
               )
                 from pg_catalog.unnest(i.indkey)
                   with ordinality as key(attnum, ordinality)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = i.indrelid
                  and a.attnum = key.attnum
                where key.ordinality <= i.indnkeyatts
             ) = expected.key_columns
             and pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_expr(
                     i.indpred,
                     i.indrelid
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             ) = expected.predicate_sha256
           ),
           false
         )
        from expected_flow_indexes expected
        left join pg_catalog.pg_namespace index_namespace
          on index_namespace.nspname = 'public'
        left join pg_catalog.pg_class index_relation
          on index_relation.relnamespace = index_namespace.oid
         and index_relation.relname = expected.index_name
        left join pg_catalog.pg_index i
          on i.indexrelid = index_relation.oid
        left join pg_catalog.pg_am access_method
          on access_method.oid = index_relation.relam
    ) as ready
),
anon_receipt_constraint_integrity as (
  select
    (
      select pg_catalog.count(*) = 1
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'u'
             and c.convalidated
             and not c.condeferrable
             and not c.condeferred
             and (
               select pg_catalog.array_agg(
                 a.attname
                 order by key.ordinality
               )
                 from pg_catalog.unnest(c.conkey)
                   with ordinality as key(attnum, ordinality)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = c.conrelid
                  and a.attnum = key.attnum
             ) = array['target_user_id']::name[]
             and exists (
               select 1
                 from pg_catalog.pg_index i
                where i.indexrelid = c.conindid
                  and i.indrelid = c.conrelid
                  and i.indisunique
                  and i.indisvalid
                  and i.indisready
                  and i.indnkeyatts = 1
                  and i.indnatts = 1
                  and i.indpred is null
                  and i.indexprs is null
             )
           ),
           false
         )
        from pg_catalog.pg_constraint c
       where c.conrelid = pg_catalog.to_regclass(
         'public.anon_data_reassignments'
       )
         and c.conname =
           'anon_data_reassignments_target_user_id_key'
    )
    and (
      select pg_catalog.count(*) = 1
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'c'
             and c.convalidated
             and not c.connoinherit
             and pg_catalog.pg_get_expr(c.conbin, c.conrelid) =
               ${sqlLiteral(OAUTH_ANON_RESULT_CONSTRAINT_EXPRESSION)}
           ),
           false
         )
        from pg_catalog.pg_constraint c
       where c.conrelid = pg_catalog.to_regclass(
         'public.anon_data_reassignments'
       )
         and c.conname =
           'anon_data_reassignments_result_check'
    ) as ready
),
tombstone_schema_integrity as (
  select
    (
      select pg_catalog.count(*) = 3
         and coalesce(
           pg_catalog.bool_and(
             case a.attname
               when 'source_user_id' then
                 pg_catalog.format_type(
                   a.atttypid,
                   a.atttypmod
                 ) = 'uuid'
               when 'deidentified_at' then
                 pg_catalog.format_type(
                   a.atttypid,
                   a.atttypmod
                 ) = 'timestamp with time zone'
               when 'reason' then
                 pg_catalog.format_type(
                   a.atttypid,
                   a.atttypmod
                 ) = 'text'
               else false
             end
             and a.attnotnull
             and not a.atthasdef
             and a.attidentity = ''
             and a.attgenerated = ''
           ),
           false
         )
        from pg_catalog.pg_attribute a
       where a.attrelid = pg_catalog.to_regclass(
         'public.oauth_deidentified_score_owner_tombstones'
       )
         and a.attnum > 0
         and not a.attisdropped
    )
    and (
      select pg_catalog.count(*) = 1
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'p'
             and c.convalidated
             and not c.condeferrable
             and not c.condeferred
             and (
               select pg_catalog.array_agg(
                 a.attname
                 order by key.ordinality
               )
                 from pg_catalog.unnest(c.conkey)
                   with ordinality as key(attnum, ordinality)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = c.conrelid
                  and a.attnum = key.attnum
             ) = array['source_user_id']::name[]
             and exists (
               select 1
                 from pg_catalog.pg_index i
                 join pg_catalog.pg_class index_relation
                   on index_relation.oid = i.indexrelid
                 join pg_catalog.pg_am access_method
                   on access_method.oid = index_relation.relam
                where i.indexrelid = c.conindid
                  and i.indrelid = c.conrelid
                  and i.indisprimary
                  and i.indisunique
                  and i.indisvalid
                  and i.indisready
                  and i.indnkeyatts = 1
                  and i.indnatts = 1
                  and i.indpred is null
                  and i.indexprs is null
                  and access_method.amname = 'btree'
             )
           ),
           false
         )
        from pg_catalog.pg_constraint c
       where c.conrelid = pg_catalog.to_regclass(
         'public.oauth_deidentified_score_owner_tombstones'
       )
         and c.conname =
           'oauth_deidentified_score_owner_tombstones_pkey'
    )
    and (
      select pg_catalog.count(*) = 1
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'c'
             and c.convalidated
             and not c.connoinherit
             and pg_catalog.pg_get_expr(c.conbin, c.conrelid) =
               ${sqlLiteral(
                 OAUTH_DEIDENTIFIED_REASON_CONSTRAINT_EXPRESSION,
               )}
           ),
           false
         )
        from pg_catalog.pg_constraint c
       where c.conrelid = pg_catalog.to_regclass(
         'public.oauth_deidentified_score_owner_tombstones'
       )
         and c.conname =
           'oauth_deidentified_score_owner_tombstones_reason_check'
    )
    and (
      select pg_catalog.count(*) = 2
        from pg_catalog.pg_trigger t
       where t.tgrelid = pg_catalog.to_regclass(
         'public.oauth_deidentified_score_owner_tombstones'
       )
         and not t.tgisinternal
    ) as ready
),
cleanup_schema_integrity as (
  select
    (
      select pg_catalog.count(*) = 25
         and pg_catalog.count(a.attnum) = 25
         and (
           select pg_catalog.count(*) = 25
             from pg_catalog.pg_attribute actual
            where actual.attrelid = pg_catalog.to_regclass(
              'public.oauth_anon_auth_cleanup_jobs'
            )
              and actual.attnum > 0
              and not actual.attisdropped
         )
         and coalesce(
           pg_catalog.bool_and(
             pg_catalog.format_type(
               a.atttypid,
               a.atttypmod
             ) = expected.formatted_type
             and a.attnotnull = expected.not_null
             and a.attidentity = ''
             and a.attgenerated = ''
             and a.attislocal
             and a.attinhcount = 0
             and coalesce(a.attstattarget, -1) = -1
             and a.attacl is null
             and a.attoptions is null
             and a.attfdwoptions is null
             and a.attcollation = attribute_type.typcollation
             and pg_catalog.pg_get_expr(
               default_value.adbin,
               default_value.adrelid
             ) is not distinct from expected.default_expression
           ),
           false
         )
        from expected_cleanup_columns expected
        left join pg_catalog.pg_attribute a
          on a.attrelid = pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          )
         and a.attname = expected.column_name
         and a.attnum > 0
         and not a.attisdropped
        left join pg_catalog.pg_type attribute_type
          on attribute_type.oid = a.atttypid
        left join pg_catalog.pg_attrdef default_value
          on default_value.adrelid = a.attrelid
         and default_value.adnum = a.attnum
    )
    and (
      select pg_catalog.count(*) = 10
         and pg_catalog.count(c.oid) = 10
         and (
           select pg_catalog.count(*) = 10
             from pg_catalog.pg_constraint actual
            where actual.conrelid = pg_catalog.to_regclass(
              'public.oauth_anon_auth_cleanup_jobs'
            )
              and actual.contype = 'c'
         )
         and coalesce(
           pg_catalog.bool_and(
             c.contype = 'c'
             and c.convalidated
             and not c.connoinherit
             and not c.condeferrable
             and not c.condeferred
             and pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_expr(c.conbin, c.conrelid),
                   'UTF8'
                 )
               ),
               'hex'
             ) = expected.expression_sha256
           ),
           false
         )
        from expected_cleanup_checks expected
        left join pg_catalog.pg_constraint c
          on c.conrelid = pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          )
         and c.conname = expected.constraint_name
    )
    and (
      select pg_catalog.count(*) = 5
         and pg_catalog.count(c.oid) = 5
         and (
           select pg_catalog.count(*) = 5
             from pg_catalog.pg_constraint actual
            where actual.conrelid = pg_catalog.to_regclass(
              'public.oauth_anon_auth_cleanup_jobs'
            )
              and actual.contype in ('p', 'u', 'f', 'x')
         )
         and coalesce(
           pg_catalog.bool_and(
             c.contype::text = expected.constraint_type
             and c.convalidated
             and not c.condeferrable
             and not c.condeferred
             and c.conislocal
             and c.coninhcount = 0
             and (
               select pg_catalog.array_agg(
                 a.attname::text
                 order by key.ordinality
               )
                 from pg_catalog.unnest(c.conkey)
                   with ordinality as key(attnum, ordinality)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = c.conrelid
                  and a.attnum = key.attnum
             ) = expected.key_columns
             and case expected.constraint_type
               when 'f' then
                 c.confrelid = pg_catalog.to_regclass(
                   expected.referenced_relation
                 )
                 and (
                   select pg_catalog.array_agg(
                     a.attname::text
                     order by key.ordinality
                   )
                     from pg_catalog.unnest(c.confkey)
                       with ordinality as key(attnum, ordinality)
                     join pg_catalog.pg_attribute a
                       on a.attrelid = c.confrelid
                      and a.attnum = key.attnum
                 ) = expected.referenced_columns
                 and c.confupdtype = 'a'
                 and c.confdeltype = 'c'
                 and c.confmatchtype = 's'
                 and c.conindid <> 0
               else
                 c.confrelid = 0
                 and c.confkey is null
                 and exists (
                   select 1
                     from pg_catalog.pg_index i
                     join pg_catalog.pg_class index_relation
                       on index_relation.oid = i.indexrelid
                     join pg_catalog.pg_am access_method
                       on access_method.oid = index_relation.relam
                    where i.indexrelid = c.conindid
                      and i.indrelid = c.conrelid
                      and i.indisunique
                      and i.indisprimary =
                        (expected.constraint_type = 'p')
                      and not i.indisexclusion
                      and not i.indnullsnotdistinct
                      and i.indisvalid
                      and i.indisready
                      and i.indislive
                      and not i.indcheckxmin
                      and i.indnkeyatts = 1
                      and i.indnatts = 1
                      and i.indpred is null
                      and i.indexprs is null
                      and not exists (
                        select 1
                          from rows from (
                            pg_catalog.unnest(
                              i.indkey::smallint[]
                            ),
                            pg_catalog.unnest(
                              i.indcollation::oid[]
                            ),
                            pg_catalog.unnest(
                              i.indclass::oid[]
                            ),
                            pg_catalog.unnest(
                              i.indoption::smallint[]
                            )
                          ) with ordinality
                            as index_key(
                              attnum,
                              collation_oid,
                              opclass_oid,
                              index_option,
                              ordinality
                            )
                          join pg_catalog.pg_attribute
                            key_attribute
                            on key_attribute.attrelid = i.indrelid
                           and key_attribute.attnum =
                             index_key.attnum
                          join pg_catalog.pg_opclass
                            operator_class
                            on operator_class.oid =
                              index_key.opclass_oid
                         where index_key.ordinality <=
                           i.indnkeyatts
                           and (
                             index_key.collation_oid <>
                               key_attribute.attcollation
                             or index_key.index_option <> 0
                             or operator_class.opcmethod <>
                               access_method.oid
                             or not operator_class.opcdefault
                             or operator_class.opcintype <>
                               key_attribute.atttypid
                           )
                      )
                      and access_method.amname = 'btree'
                 )
             end
           ),
           false
         )
        from expected_cleanup_keys expected
        left join pg_catalog.pg_constraint c
          on c.conrelid = pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          )
         and c.conname = expected.constraint_name
    )
    and (
      select pg_catalog.count(*) = 4
         and pg_catalog.count(i.indexrelid) = 4
         and (
           select pg_catalog.count(*) = 4
             from pg_catalog.pg_index actual
            where actual.indrelid = pg_catalog.to_regclass(
              'public.oauth_anon_auth_cleanup_jobs'
            )
              and not exists (
                select 1
                  from pg_catalog.pg_constraint constraint_index
                 where constraint_index.conindid =
                   actual.indexrelid
              )
         )
         and coalesce(
           pg_catalog.bool_and(
             i.indrelid = pg_catalog.to_regclass(
               'public.oauth_anon_auth_cleanup_jobs'
             )
             and i.indisunique = expected.unique_index
             and not i.indisprimary
             and not i.indisexclusion
             and not i.indnullsnotdistinct
             and i.indisvalid
             and i.indisready
             and i.indislive
             and not i.indcheckxmin
             and i.indnkeyatts =
               pg_catalog.cardinality(expected.key_columns)
             and i.indnatts =
               pg_catalog.cardinality(expected.key_columns)
             and i.indexprs is null
             and i.indpred is not null
             and not exists (
               select 1
                 from rows from (
                   pg_catalog.unnest(i.indkey::smallint[]),
                   pg_catalog.unnest(i.indcollation::oid[]),
                   pg_catalog.unnest(i.indclass::oid[]),
                   pg_catalog.unnest(i.indoption::smallint[])
                 ) with ordinality
                   as index_key(
                     attnum,
                     collation_oid,
                     opclass_oid,
                     index_option,
                     ordinality
                   )
                 join pg_catalog.pg_attribute key_attribute
                   on key_attribute.attrelid = i.indrelid
                  and key_attribute.attnum = index_key.attnum
                 join pg_catalog.pg_opclass operator_class
                   on operator_class.oid = index_key.opclass_oid
                where index_key.ordinality <= i.indnkeyatts
                  and (
                    index_key.collation_oid <>
                      key_attribute.attcollation
                    or index_key.index_option <> 0
                    or operator_class.opcmethod <>
                      access_method.oid
                    or not operator_class.opcdefault
                    or operator_class.opcintype <>
                      key_attribute.atttypid
                  )
             )
             and index_relation.relkind = 'i'
             and index_relation.relpersistence = 'p'
             and index_relation.reloptions is null
             and pg_catalog.pg_get_userbyid(
               index_relation.relowner
             ) = 'postgres'
             and access_method.amname = 'btree'
             and (
               select pg_catalog.array_agg(
                 a.attname::text
                 order by key.ordinality
               )
                 from pg_catalog.unnest(i.indkey)
                   with ordinality as key(attnum, ordinality)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = i.indrelid
                  and a.attnum = key.attnum
                where key.ordinality <= i.indnkeyatts
             ) = expected.key_columns
             and pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_expr(
                     i.indpred,
                     i.indrelid
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             ) = expected.predicate_sha256
           ),
           false
         )
        from expected_cleanup_indexes expected
        left join pg_catalog.pg_namespace index_namespace
          on index_namespace.nspname = 'public'
        left join pg_catalog.pg_class index_relation
          on index_relation.relnamespace = index_namespace.oid
         and index_relation.relname = expected.index_name
        left join pg_catalog.pg_index i
          on i.indexrelid = index_relation.oid
        left join pg_catalog.pg_am access_method
          on access_method.oid = index_relation.relam
    ) as ready
),
relation_fingerprint_integrity as (
  select pg_catalog.count(*) =
           ${OAUTH_CATALOG_RELATION_NAMES.length}
     and pg_catalog.count(expected.relation_name) =
           ${OAUTH_CATALOG_RELATION_NAMES.length}
     and pg_catalog.count(actual.relation_name) =
           ${OAUTH_CATALOG_RELATION_NAMES.length}
     and coalesce(
       pg_catalog.bool_and(
         expected.catalog_sha256 = actual.catalog_sha256
       ),
       false
     ) as ready
    from expected_relation_fingerprints expected
    full join actual_relation_fingerprints actual
      using (relation_name)
),
owner_integrity as (
  select pg_catalog.count(*) = 8
     and pg_catalog.count(c.oid) = 8
     and coalesce(
       pg_catalog.bool_and(
         pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
         and c.relkind = 'r'
         and c.relrowsecurity
         and not c.relforcerowsecurity
         and not exists (
           select 1
             from pg_catalog.pg_policy policy
            where policy.polrelid = c.oid
         )
         and not exists (
           select 1
             from pg_catalog.aclexplode(
               coalesce(
                 c.relacl,
                 pg_catalog.acldefault(
                   'r'::"char",
                   c.relowner
                 )
               )
             ) acl
            where acl.grantee <> c.relowner
         )
       ),
       false
     ) as ready
    from (
      values
        ('public.anon_data_reassignments'),
        ('public.oauth_flow_intents'),
        ('public.oauth_anon_auth_cleanup_jobs'),
        ('public.oauth_quarantined_score_highlights'),
        ('public.oauth_deidentified_score_owner_tombstones'),
        ('public.oauth_auth_session_id_tombstones'),
        ('public.legacy_signup_migration_receipts'),
        ('public.oauth_rollout_deployment_qualifications')
    ) expected(relation_name)
    left join pg_catalog.pg_class c
      on c.oid = pg_catalog.to_regclass(expected.relation_name)
),
journal_integrity as (
  select coalesce(
    (
      select
        pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
        and c.relkind = 'r'
        and c.relrowsecurity
        and not c.relforcerowsecurity
        and not exists (
          select 1
            from pg_catalog.pg_policy policy
           where policy.polrelid = c.oid
        )
        and (
          select
            pg_catalog.count(*) filter (
              where acl.grantee <> c.relowner
            ) = 1
            and pg_catalog.count(*) filter (
              where acl.grantee <> c.relowner
                and acl.grantee = coalesce(
                  (
                    select role.oid
                      from pg_catalog.pg_roles role
                     where role.rolname = 'service_role'
                  ),
                  0
                )
                and acl.privilege_type = 'SELECT'
                and not acl.is_grantable
            ) = 1
            from pg_catalog.aclexplode(
              coalesce(
                c.relacl,
                pg_catalog.acldefault(
                  'r'::"char",
                  c.relowner
                )
              )
            ) acl
        )
        from pg_catalog.pg_class c
       where c.oid = pg_catalog.to_regclass(
         'public.schema_migration_journal'
       )
    ),
    false
  ) as ready
),
trigger_integrity as (
  select pg_catalog.count(*) = 21
     and pg_catalog.count(t.oid) = 21
     and coalesce(
       pg_catalog.bool_and(
         not t.tgisinternal
         and t.tgenabled = 'O'
         and t.tgtype = expected.trigger_type
         and t.tgqual is null
         and t.tgconstraint = 0
         and t.tgparentid = 0
         and not t.tgdeferrable
         and not t.tginitdeferred
         and t.tgfoid = pg_catalog.to_regprocedure(
           expected.function_signature
         )
         and coalesce(
           (
             select pg_catalog.array_agg(
               a.attname::text
               order by a.attname
             )
               from pg_catalog.pg_attribute a
              where a.attrelid = t.tgrelid
                and a.attnum = any(t.tgattr::smallint[])
           ),
           array[]::text[]
         ) = expected.update_attributes
       ),
       false
     ) as ready
    from expected_triggers expected
    left join pg_catalog.pg_trigger t
      on t.tgrelid = pg_catalog.to_regclass(
        expected.relation_name
      )
     and t.tgname = expected.trigger_name
)
select case
  when function_integrity.ready
   and flow_schema_integrity.ready
   and anon_receipt_constraint_integrity.ready
   and tombstone_schema_integrity.ready
   and cleanup_schema_integrity.ready
   and relation_fingerprint_integrity.ready
   and owner_integrity.ready
   and journal_integrity.ready
   and trigger_integrity.ready
    then 'ready'
  else 'invalid'
end
from function_integrity
cross join flow_schema_integrity
cross join anon_receipt_constraint_integrity
cross join tombstone_schema_integrity
cross join cleanup_schema_integrity
cross join relation_fingerprint_integrity
cross join owner_integrity
cross join journal_integrity
cross join trigger_integrity;
`;
}

export async function main() {
  const argv = process.argv.slice(2);
  if (
    argv.length !== 2 ||
    argv[0] !== "--stage" ||
    (argv[1] !== "expand" && argv[1] !== "contract")
  ) {
    throw new Error("oauth_catalog_stage_invalid");
  }
  const stage = argv[1];
  const [
    expandSql,
    scoreSubmissionIntegritySql,
    userMutationLockOrderSql,
  ] = await Promise.all([
    readFile(
      new URL(
        "../../supabase/migrations/0093_oauth_flow_intents.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/0074_score_submission_integrity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/0084_user_mutation_lock_order.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  process.stdout.write(
    renderOAuthCatalogIntegrityQuery(
      expandSql,
      {
        scoreSubmissionIntegritySql,
        userMutationLockOrderSql,
      },
      stage,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const reason =
      error instanceof Error && /^[a-z0-9_:=-]+$/u.test(error.message)
        ? error.message
        : "oauth_catalog_integrity_query_failed";
    console.error(`OAuth catalog integrity query failed reason=${reason}`);
    process.exitCode = 1;
  });
}
