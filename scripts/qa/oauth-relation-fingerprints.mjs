#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const RELATION_NAMES = Object.freeze([
  "public.anon_data_reassignments",
  "public.dolls",
  "public.legacy_signup_migration_receipts",
  "public.member_accounts",
  "public.oauth_anon_auth_cleanup_jobs",
  "public.oauth_auth_session_id_tombstones",
  "public.oauth_deidentified_score_owner_tombstones",
  "public.oauth_flow_intents",
  "public.oauth_quarantined_score_highlights",
  "public.oauth_rollout_deployment_qualifications",
  "public.profiles",
  "public.score_highlights",
  "public.user_badges",
]);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export const OAUTH_CATALOG_RELATION_NAMES = RELATION_NAMES;

export const OAUTH_EXPECTED_RELATION_FINGERPRINTS = Object.freeze({
  "public.anon_data_reassignments":
    "d1fe2eb3eaa86cf99c6824a189017ad84a74bb49c0ce45fedae8373d4ddd186d",
  "public.dolls":
    "943112bbea2ab76c10d41a3401287b25517c87ee260ae648e12c7e0de567c634",
  "public.legacy_signup_migration_receipts":
    "79de2351f74efa082562bd89b5946cbe97a746274480478d903afe2cc5602f97",
  "public.member_accounts":
    "127ce552a42de5f5e4bed5ace8d8a3a5d7938e2fa2f871de1aab0c52635df4ab",
  "public.oauth_anon_auth_cleanup_jobs":
    "7a0a07264752acdc2745e5465c9f10b3785318345f97b9b19a6873163afbf1d0",
  "public.oauth_auth_session_id_tombstones":
    "10e58117f9b348b6d0e867c1a38a05aa5f8ed15b1f22e391fc296c31399c6eed",
  "public.oauth_deidentified_score_owner_tombstones":
    "6d5bf9ea4c25cafcc5855e7a85d090de151fda05477ad44f56e842a8ec87129e",
  "public.oauth_flow_intents":
    "a8c9e4456166a19ec37437ec040ca405a40b3cfa1709097d3ec48d079f082eaf",
  "public.oauth_quarantined_score_highlights":
    "4c90b0e89a996473c8342c882d1daf507bc8d7df9c7167e5a8ac8e9320bbecb2",
  "public.oauth_rollout_deployment_qualifications":
    "04ec882a5b5244672c22be24acf27c6ae1dd9787db2ab10cf03ae7c07c2fefb0",
  "public.profiles":
    "0de1bd6ce99aeab84f829f76646df2a232e24a74c1f3e09ca67f8c7ed83e4439",
  "public.score_highlights":
    "87329e1a70cdde17525f5bbdb334d1042032a21cbfb8e1b4f5005d227c2bdd1c",
  "public.user_badges":
    "478787ca153ad1705ab74f4ca132bd3730097bac2ef87114b511bb2333c7be04",
});

if (
  Object.keys(OAUTH_EXPECTED_RELATION_FINGERPRINTS).length !==
    RELATION_NAMES.length ||
  RELATION_NAMES.some(
    (relationName) =>
      !/^[0-9a-f]{64}$/u.test(
        OAUTH_EXPECTED_RELATION_FINGERPRINTS[relationName] ?? "",
      ),
  )
) {
  throw new Error("oauth_relation_fingerprint_manifest_invalid");
}

export function renderOAuthRelationFingerprintCtes() {
  const relationValues = RELATION_NAMES.map(
    (relationName) => `    (${sqlLiteral(relationName)})`,
  ).join(",\n");

  return `catalog_fingerprint_environment as materialized (
  select
    pg_catalog.set_config('search_path', '', true),
    pg_catalog.set_config('TimeZone', 'UTC', true),
    pg_catalog.set_config('DateStyle', 'ISO, YMD', true),
    pg_catalog.set_config('IntervalStyle', 'postgres', true),
    pg_catalog.set_config('bytea_output', 'hex', true),
    pg_catalog.set_config('extra_float_digits', '3', true),
    pg_catalog.set_config('quote_all_identifiers', 'off', true),
    pg_catalog.set_config(
      'standard_conforming_strings',
      'on',
      true
    )
),
expected_relation_names(relation_name) as (
  values
${relationValues}
),
relation_catalog_documents as (
  select
    expected.relation_name,
    pg_catalog.jsonb_build_object(
      'exists',
      relation_class.oid is not null,
      'class',
      pg_catalog.jsonb_build_object(
        'namespace',
        relation_namespace.nspname,
        'name',
        relation_class.relname,
        'owner',
        pg_catalog.pg_get_userbyid(relation_class.relowner),
        'kind',
        relation_class.relkind,
        'persistence',
        relation_class.relpersistence,
        'access_method',
        access_method.amname,
        'tablespace',
        relation_tablespace.spcname,
        'options',
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              relation_option
              order by relation_option
            )
              from pg_catalog.unnest(
                relation_class.reloptions
              ) relation_option
          ),
          '[]'::jsonb
        ),
        'row_security',
        relation_class.relrowsecurity,
        'force_row_security',
        relation_class.relforcerowsecurity,
        'replica_identity',
        relation_class.relreplident,
        'is_partition',
        relation_class.relispartition,
        'partition_bound',
        pg_catalog.pg_get_expr(
          relation_class.relpartbound,
          relation_class.oid,
          false
        ),
        'typed_table',
        case
          when relation_class.reloftype = 0 then null
          else relation_class.reloftype::pg_catalog.regtype::text
        end,
        'has_toast',
        relation_class.reltoastrelid <> 0,
        'toast',
        (
          select pg_catalog.jsonb_build_object(
            'owner',
            pg_catalog.pg_get_userbyid(toast_class.relowner),
            'kind',
            toast_class.relkind,
            'persistence',
            toast_class.relpersistence,
            'options',
            coalesce(
              (
                select pg_catalog.jsonb_agg(
                  toast_option
                  order by toast_option
                )
                  from pg_catalog.unnest(
                    toast_class.reloptions
                  ) toast_option
              ),
              '[]'::jsonb
            )
          )
            from pg_catalog.pg_class toast_class
           where toast_class.oid = relation_class.reltoastrelid
        ),
        'row_type',
        (
          select pg_catalog.jsonb_build_object(
            'namespace',
            row_type_namespace.nspname,
            'name',
            row_type.typname,
            'owner',
            pg_catalog.pg_get_userbyid(row_type.typowner),
            'kind',
            row_type.typtype,
            'category',
            row_type.typcategory,
            'preferred',
            row_type.typispreferred,
            'defined',
            row_type.typisdefined,
            'acl_is_null',
            row_type.typacl is null,
            'acl',
            coalesce(
              (
                select pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'grantor',
                    grantor.rolname,
                    'grantee',
                    case
                      when acl.grantee = 0 then 'PUBLIC'
                      else grantee.rolname
                    end,
                    'privilege',
                    acl.privilege_type,
                    'grantable',
                    acl.is_grantable
                  )
                  order by
                    grantor.rolname,
                    case
                      when acl.grantee = 0 then 'PUBLIC'
                      else grantee.rolname
                    end,
                    acl.privilege_type,
                    acl.is_grantable
                )
                  from pg_catalog.aclexplode(
                    coalesce(
                      row_type.typacl,
                      pg_catalog.acldefault(
                        'T'::"char",
                        row_type.typowner
                      )
                    )
                  ) acl
                  left join pg_catalog.pg_roles grantor
                    on grantor.oid = acl.grantor
                  left join pg_catalog.pg_roles grantee
                    on grantee.oid = acl.grantee
              ),
              '[]'::jsonb
            )
          )
            from pg_catalog.pg_type row_type
            join pg_catalog.pg_namespace row_type_namespace
              on row_type_namespace.oid = row_type.typnamespace
           where row_type.oid = relation_class.reltype
        ),
        'acl_is_null',
        relation_class.relacl is null,
        'acl',
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'grantor',
                grantor.rolname,
                'grantee',
                case
                  when acl.grantee = 0 then 'PUBLIC'
                  else grantee.rolname
                end,
                'privilege',
                acl.privilege_type,
                'grantable',
                acl.is_grantable
              )
              order by
                grantor.rolname,
                case
                  when acl.grantee = 0 then 'PUBLIC'
                  else grantee.rolname
                end,
                acl.privilege_type,
                acl.is_grantable
            )
              from pg_catalog.aclexplode(
                coalesce(
                  relation_class.relacl,
                  pg_catalog.acldefault(
                    'r'::"char",
                    relation_class.relowner
                  )
                )
              ) acl
              left join pg_catalog.pg_roles grantor
                on grantor.oid = acl.grantor
              left join pg_catalog.pg_roles grantee
                on grantee.oid = acl.grantee
          ),
          '[]'::jsonb
        )
      ),
      'columns',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'number',
              attribute.attnum,
              'name',
              attribute.attname,
              'type',
              pg_catalog.format_type(
                attribute.atttypid,
                attribute.atttypmod
              ),
              'type_namespace',
              attribute_type_namespace.nspname,
              'type_name',
              attribute_type.typname,
              'not_null',
              attribute.attnotnull,
              'has_default',
              attribute.atthasdef,
              'default',
              pg_catalog.pg_get_expr(
                attribute_default.adbin,
                attribute_default.adrelid,
                false
              ),
              'identity',
              attribute.attidentity,
              'generated',
              attribute.attgenerated,
              'is_local',
              attribute.attislocal,
              'inheritance_count',
              attribute.attinhcount,
              'statistics_target',
              attribute.attstattarget,
              'storage',
              attribute.attstorage,
              'compression',
              attribute.attcompression,
              'alignment',
              attribute.attalign,
              'by_value',
              attribute.attbyval,
              'has_missing',
              attribute.atthasmissing,
              'collation',
              case
                when attribute.attcollation = 0 then null
                else pg_catalog.format(
                  '%I.%I',
                  attribute_collation_namespace.nspname,
                  attribute_collation.collname
                )
              end,
              'options',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    attribute_option
                    order by attribute_option
                  )
                    from pg_catalog.unnest(
                      attribute.attoptions
                    ) attribute_option
                ),
                '[]'::jsonb
              ),
              'fdw_options',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    attribute_fdw_option
                    order by attribute_fdw_option
                  )
                    from pg_catalog.unnest(
                      attribute.attfdwoptions
                    ) attribute_fdw_option
                ),
                '[]'::jsonb
              ),
              'acl_is_null',
              attribute.attacl is null,
              'acl',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'grantor',
                      grantor.rolname,
                      'grantee',
                      case
                        when acl.grantee = 0 then 'PUBLIC'
                        else grantee.rolname
                      end,
                      'privilege',
                      acl.privilege_type,
                      'grantable',
                      acl.is_grantable
                    )
                    order by
                      grantor.rolname,
                      case
                        when acl.grantee = 0 then 'PUBLIC'
                        else grantee.rolname
                      end,
                      acl.privilege_type,
                      acl.is_grantable
                  )
                    from pg_catalog.aclexplode(
                      attribute.attacl
                    ) acl
                    left join pg_catalog.pg_roles grantor
                      on grantor.oid = acl.grantor
                    left join pg_catalog.pg_roles grantee
                      on grantee.oid = acl.grantee
                ),
                '[]'::jsonb
              )
            )
            order by attribute.attnum
          )
            from pg_catalog.pg_attribute attribute
            join pg_catalog.pg_type attribute_type
              on attribute_type.oid = attribute.atttypid
            join pg_catalog.pg_namespace attribute_type_namespace
              on attribute_type_namespace.oid =
                attribute_type.typnamespace
            left join pg_catalog.pg_attrdef attribute_default
              on attribute_default.adrelid = attribute.attrelid
             and attribute_default.adnum = attribute.attnum
            left join pg_catalog.pg_collation attribute_collation
              on attribute_collation.oid = attribute.attcollation
            left join pg_catalog.pg_namespace
              attribute_collation_namespace
              on attribute_collation_namespace.oid =
                attribute_collation.collnamespace
           where attribute.attrelid = relation_class.oid
             and attribute.attnum > 0
             and not attribute.attisdropped
        ),
        '[]'::jsonb
      ),
      'constraints',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name',
              constraint_row.conname,
              'type',
              constraint_row.contype,
              'definition',
              pg_catalog.pg_get_constraintdef(
                constraint_row.oid,
                false
              ),
              'deferrable',
              constraint_row.condeferrable,
              'initially_deferred',
              constraint_row.condeferred,
              'validated',
              constraint_row.convalidated,
              'no_inherit',
              constraint_row.connoinherit,
              'is_local',
              constraint_row.conislocal,
              'inheritance_count',
              constraint_row.coninhcount,
              'parent_constraint',
              case
                when constraint_row.conparentid = 0 then null
                else parent_constraint.conname
              end,
              'key_columns',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    key_attribute.attname
                    order by key_column.ordinality
                  )
                    from pg_catalog.unnest(constraint_row.conkey)
                      with ordinality
                      as key_column(attnum, ordinality)
                    join pg_catalog.pg_attribute key_attribute
                      on key_attribute.attrelid =
                        constraint_row.conrelid
                     and key_attribute.attnum = key_column.attnum
                ),
                '[]'::jsonb
              ),
              'referenced_relation',
              case
                when constraint_row.confrelid = 0 then null
                else constraint_row.confrelid::pg_catalog.regclass::text
              end,
              'referenced_columns',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    referenced_attribute.attname
                    order by referenced_column.ordinality
                  )
                    from pg_catalog.unnest(constraint_row.confkey)
                      with ordinality
                      as referenced_column(attnum, ordinality)
                    join pg_catalog.pg_attribute referenced_attribute
                      on referenced_attribute.attrelid =
                        constraint_row.confrelid
                     and referenced_attribute.attnum =
                        referenced_column.attnum
                ),
                '[]'::jsonb
              ),
              'foreign_update_action',
              constraint_row.confupdtype,
              'foreign_delete_action',
              constraint_row.confdeltype,
              'foreign_match_type',
              constraint_row.confmatchtype,
              'index',
              case
                when constraint_row.conindid = 0 then null
                else constraint_index.relname
              end,
              'check_expression',
              pg_catalog.pg_get_expr(
                constraint_row.conbin,
                constraint_row.conrelid,
                false
              ),
              'foreign_pk_eq_operators',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    operator_oid::pg_catalog.regoperator::text
                    order by operator_row.ordinality
                  )
                    from pg_catalog.unnest(
                      constraint_row.conpfeqop
                    ) with ordinality
                      as operator_row(
                        operator_oid,
                        ordinality
                      )
                ),
                '[]'::jsonb
              ),
              'foreign_pk_pk_operators',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    operator_oid::pg_catalog.regoperator::text
                    order by operator_row.ordinality
                  )
                    from pg_catalog.unnest(
                      constraint_row.conppeqop
                    ) with ordinality
                      as operator_row(
                        operator_oid,
                        ordinality
                      )
                ),
                '[]'::jsonb
              ),
              'foreign_fk_fk_operators',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    operator_oid::pg_catalog.regoperator::text
                    order by operator_row.ordinality
                  )
                    from pg_catalog.unnest(
                      constraint_row.conffeqop
                    ) with ordinality
                      as operator_row(
                        operator_oid,
                        ordinality
                      )
                ),
                '[]'::jsonb
              ),
              'exclusion_operators',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    operator_oid::pg_catalog.regoperator::text
                    order by operator_row.ordinality
                  )
                    from pg_catalog.unnest(
                      constraint_row.conexclop
                    ) with ordinality
                      as operator_row(
                        operator_oid,
                        ordinality
                      )
                ),
                '[]'::jsonb
              )
            )
            order by constraint_row.conname
          )
            from pg_catalog.pg_constraint constraint_row
            left join pg_catalog.pg_constraint parent_constraint
              on parent_constraint.oid =
                constraint_row.conparentid
            left join pg_catalog.pg_class constraint_index
              on constraint_index.oid = constraint_row.conindid
           where constraint_row.conrelid = relation_class.oid
        ),
        '[]'::jsonb
      ),
      'indexes',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name',
              index_class.relname,
              'owner',
              pg_catalog.pg_get_userbyid(index_class.relowner),
              'kind',
              index_class.relkind,
              'persistence',
              index_class.relpersistence,
              'access_method',
              index_access_method.amname,
              'tablespace',
              index_tablespace.spcname,
              'options',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    index_option
                    order by index_option
                  )
                    from pg_catalog.unnest(
                      index_class.reloptions
                    ) index_option
                ),
                '[]'::jsonb
              ),
              'definition',
              pg_catalog.pg_get_indexdef(index_row.indexrelid),
              'unique',
              index_row.indisunique,
              'primary',
              index_row.indisprimary,
              'exclusion',
              index_row.indisexclusion,
              'immediate',
              index_row.indimmediate,
              'clustered',
              index_row.indisclustered,
              'valid',
              index_row.indisvalid,
              'ready',
              index_row.indisready,
              'live',
              index_row.indislive,
              'replident',
              index_row.indisreplident,
              'key_count',
              index_row.indnkeyatts,
              'attribute_count',
              index_row.indnatts,
              'nulls_not_distinct',
              index_row.indnullsnotdistinct,
              'predicate',
              pg_catalog.pg_get_expr(
                index_row.indpred,
                index_row.indrelid,
                false
              ),
              'expressions',
              pg_catalog.pg_get_expr(
                index_row.indexprs,
                index_row.indrelid,
                false
              ),
              'constraint',
              constraint_index.conname,
              'keys',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'ordinality',
                      index_key.ordinality,
                      'key',
                      index_key.ordinality <=
                        index_row.indnkeyatts,
                      'attribute_number',
                      index_key.attnum,
                      'attribute',
                      index_attribute.attname,
                      'collation',
                      case
                        when index_key.collation_oid = 0 then null
                        else pg_catalog.format(
                          '%I.%I',
                          index_collation_namespace.nspname,
                          index_collation.collname
                        )
                      end,
                      'opclass',
                      pg_catalog.format(
                        '%I.%I',
                        operator_class_namespace.nspname,
                        operator_class.opcname
                      ),
                      'opfamily',
                      pg_catalog.format(
                        '%I.%I',
                        operator_family_namespace.nspname,
                        operator_family.opfname
                      ),
                      'option',
                      index_key.option
                    )
                    order by index_key.ordinality
                  )
                    from rows from (
                      pg_catalog.unnest(
                        index_row.indkey::smallint[]
                      ),
                      pg_catalog.unnest(
                        index_row.indcollation::oid[]
                      ),
                      pg_catalog.unnest(
                        index_row.indclass::oid[]
                      ),
                      pg_catalog.unnest(
                        index_row.indoption::smallint[]
                      )
                    ) with ordinality
                      as index_key(
                        attnum,
                        collation_oid,
                        opclass_oid,
                        option,
                        ordinality
                      )
                    left join pg_catalog.pg_attribute
                      index_attribute
                      on index_attribute.attrelid =
                        index_row.indrelid
                     and index_attribute.attnum =
                        index_key.attnum
                    left join pg_catalog.pg_collation
                      index_collation
                      on index_collation.oid =
                        index_key.collation_oid
                    left join pg_catalog.pg_namespace
                      index_collation_namespace
                      on index_collation_namespace.oid =
                        index_collation.collnamespace
                    left join pg_catalog.pg_opclass operator_class
                      on operator_class.oid =
                        index_key.opclass_oid
                    left join pg_catalog.pg_namespace
                      operator_class_namespace
                      on operator_class_namespace.oid =
                        operator_class.opcnamespace
                    left join pg_catalog.pg_opfamily operator_family
                      on operator_family.oid =
                        operator_class.opcfamily
                    left join pg_catalog.pg_namespace
                      operator_family_namespace
                      on operator_family_namespace.oid =
                        operator_family.opfnamespace
                ),
                '[]'::jsonb
              )
            )
            order by index_class.relname
          )
            from pg_catalog.pg_index index_row
            join pg_catalog.pg_class index_class
              on index_class.oid = index_row.indexrelid
            left join pg_catalog.pg_am index_access_method
              on index_access_method.oid = index_class.relam
            left join pg_catalog.pg_tablespace index_tablespace
              on index_tablespace.oid = index_class.reltablespace
            left join pg_catalog.pg_constraint constraint_index
              on constraint_index.conindid = index_row.indexrelid
             and constraint_index.conrelid = index_row.indrelid
             and constraint_index.contype in ('p', 'u', 'x')
           where index_row.indrelid = relation_class.oid
        ),
        '[]'::jsonb
      ),
      'triggers',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'internal',
              trigger_row.tgisinternal,
              'name',
              case
                when trigger_row.tgisinternal then null
                else trigger_row.tgname
              end,
              'function',
              pg_catalog.format(
                '%I.%I(%s)',
                trigger_function_namespace.nspname,
                trigger_function.proname,
                pg_catalog.pg_get_function_identity_arguments(
                  trigger_function.oid
                )
              ),
              'type',
              trigger_row.tgtype,
              'enabled',
              trigger_row.tgenabled,
              'constraint',
              trigger_constraint.conname,
              'has_parent_trigger',
              trigger_row.tgparentid <> 0,
              'deferrable',
              trigger_row.tgdeferrable,
              'initially_deferred',
              trigger_row.tginitdeferred,
              'qualifier_present',
              trigger_row.tgqual is not null,
              'old_table',
              trigger_row.tgoldtable,
              'new_table',
              trigger_row.tgnewtable,
              'arguments_hex',
              pg_catalog.encode(trigger_row.tgargs, 'hex'),
              'update_columns',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    trigger_attribute.attname
                    order by trigger_attribute_row.ordinality
                  )
                    from pg_catalog.unnest(
                      trigger_row.tgattr::smallint[]
                    ) with ordinality
                      as trigger_attribute_row(
                        attnum,
                        ordinality
                      )
                    join pg_catalog.pg_attribute
                      trigger_attribute
                      on trigger_attribute.attrelid =
                        trigger_row.tgrelid
                     and trigger_attribute.attnum =
                        trigger_attribute_row.attnum
                ),
                '[]'::jsonb
              ),
              'definition',
              case
                when trigger_row.tgisinternal then null
                else pg_catalog.pg_get_triggerdef(
                  trigger_row.oid,
                  false
                )
              end
            )
            order by
              trigger_row.tgisinternal,
              coalesce(trigger_constraint.conname, ''),
              trigger_function_namespace.nspname,
              trigger_function.proname,
              trigger_row.tgtype,
              pg_catalog.encode(trigger_row.tgargs, 'hex'),
              case
                when trigger_row.tgisinternal then ''
                else trigger_row.tgname
              end
          )
            from pg_catalog.pg_trigger trigger_row
            join pg_catalog.pg_proc trigger_function
              on trigger_function.oid = trigger_row.tgfoid
            join pg_catalog.pg_namespace
              trigger_function_namespace
              on trigger_function_namespace.oid =
                trigger_function.pronamespace
            left join pg_catalog.pg_constraint trigger_constraint
              on trigger_constraint.oid =
                trigger_row.tgconstraint
           where trigger_row.tgrelid = relation_class.oid
        ),
        '[]'::jsonb
      ),
      'policies',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name',
              policy.polname,
              'command',
              policy.polcmd,
              'permissive',
              policy.polpermissive,
              'roles',
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    case
                      when policy_role.role_oid = 0 then 'PUBLIC'
                      else policy_role_name.rolname
                    end
                    order by
                      case
                        when policy_role.role_oid = 0 then 'PUBLIC'
                        else policy_role_name.rolname
                      end
                  )
                    from pg_catalog.unnest(policy.polroles)
                      as policy_role(role_oid)
                    left join pg_catalog.pg_roles policy_role_name
                      on policy_role_name.oid =
                        policy_role.role_oid
                ),
                '[]'::jsonb
              ),
              'using',
              pg_catalog.pg_get_expr(
                policy.polqual,
                policy.polrelid,
                false
              ),
              'with_check',
              pg_catalog.pg_get_expr(
                policy.polwithcheck,
                policy.polrelid,
                false
              )
            )
            order by policy.polname
          )
            from pg_catalog.pg_policy policy
           where policy.polrelid = relation_class.oid
        ),
        '[]'::jsonb
      ),
      'publications',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name',
              publication.pubname,
              'membership',
              publication_membership.membership_kind,
              'owner',
              pg_catalog.pg_get_userbyid(publication.pubowner),
              'insert',
              publication.pubinsert,
              'update',
              publication.pubupdate,
              'delete',
              publication.pubdelete,
              'truncate',
              publication.pubtruncate,
              'via_partition_root',
              publication.pubviaroot,
              'row_filter',
              pg_catalog.pg_get_expr(
                publication_membership.row_filter,
                relation_class.oid,
                false
              ),
              'columns',
              case
                when publication_membership.column_numbers is null
                  then null
                else (
                  select pg_catalog.jsonb_agg(
                    publication_attribute.attname
                    order by
                      publication_attribute_row.ordinality
                  )
                    from pg_catalog.unnest(
                      publication_membership.column_numbers
                    ) with ordinality
                      as publication_attribute_row(
                        attnum,
                        ordinality
                      )
                    join pg_catalog.pg_attribute
                      publication_attribute
                      on publication_attribute.attrelid =
                        relation_class.oid
                     and publication_attribute.attnum =
                        publication_attribute_row.attnum
                )
              end
            )
            order by
              publication.pubname,
              publication_membership.membership_kind
          )
            from (
              select
                explicit_membership.prpubid as publication_oid,
                'relation'::text as membership_kind,
                explicit_membership.prqual as row_filter,
                explicit_membership.prattrs::smallint[]
                  as column_numbers
                from pg_catalog.pg_publication_rel
                  explicit_membership
               where explicit_membership.prrelid =
                 relation_class.oid
              union all
              select
                all_tables_publication.oid,
                'all_tables'::text,
                null::pg_catalog.pg_node_tree,
                null::smallint[]
                from pg_catalog.pg_publication
                  all_tables_publication
               where all_tables_publication.puballtables
              union all
              select
                schema_membership.pnpubid,
                'schema'::text,
                null::pg_catalog.pg_node_tree,
                null::smallint[]
                from pg_catalog.pg_publication_namespace
                  schema_membership
               where schema_membership.pnnspid =
                 relation_class.relnamespace
            ) publication_membership
            join pg_catalog.pg_publication publication
              on publication.oid =
                publication_membership.publication_oid
        ),
        '[]'::jsonb
      ),
      'rules',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name',
              rewrite_rule.rulename,
              'event',
              rewrite_rule.ev_type,
              'enabled',
              rewrite_rule.ev_enabled,
              'instead',
              rewrite_rule.is_instead,
              'definition',
              pg_catalog.pg_get_ruledef(rewrite_rule.oid, false)
            )
            order by rewrite_rule.rulename
          )
            from pg_catalog.pg_rewrite rewrite_rule
           where rewrite_rule.ev_class = relation_class.oid
             and rewrite_rule.rulename <> '_RETURN'
        ),
        '[]'::jsonb
      ),
      'parents',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            inherited_parent.inhparent::pg_catalog.regclass::text
            order by inherited_parent.inhseqno
          )
            from pg_catalog.pg_inherits inherited_parent
           where inherited_parent.inhrelid = relation_class.oid
        ),
        '[]'::jsonb
      ),
      'children',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            inherited_child.inhrelid::pg_catalog.regclass::text
            order by
              inherited_child.inhrelid::pg_catalog.regclass::text,
              inherited_child.inhseqno
          )
            from pg_catalog.pg_inherits inherited_child
           where inherited_child.inhparent = relation_class.oid
        ),
        '[]'::jsonb
      )
    ) as catalog_document
    from expected_relation_names expected
    left join pg_catalog.pg_class relation_class
      on relation_class.oid =
        pg_catalog.to_regclass(expected.relation_name)
    left join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid = relation_class.relnamespace
    left join pg_catalog.pg_am access_method
      on access_method.oid = relation_class.relam
    left join pg_catalog.pg_tablespace relation_tablespace
      on relation_tablespace.oid = relation_class.reltablespace
    cross join catalog_fingerprint_environment
),
actual_relation_fingerprints as (
  select
    relation_name,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(catalog_document::text, 'UTF8')
      ),
      'hex'
    ) as catalog_sha256
    from relation_catalog_documents
)`;
}

export function renderOAuthRelationFingerprintDiscoveryQuery() {
  return `with ${renderOAuthRelationFingerprintCtes()}
select relation_name, catalog_sha256
  from actual_relation_fingerprints
 order by relation_name;
`;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--discover") {
    throw new Error("oauth_relation_fingerprint_args_invalid");
  }
  process.stdout.write(renderOAuthRelationFingerprintDiscoveryQuery());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const reason =
      error instanceof Error && /^[a-z0-9_:=-]+$/u.test(error.message)
        ? error.message
        : "oauth_relation_fingerprint_failed";
    console.error(`OAuth relation fingerprint failed reason=${reason}`);
    process.exitCode = 1;
  });
}
