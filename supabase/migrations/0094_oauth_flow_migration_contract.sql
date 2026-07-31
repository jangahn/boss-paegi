-- 0094_oauth_flow_migration_contract.sql
--
-- Contract phase for flow-scoped anonymous-data migration.
--
-- Apply only after every application instance uses
-- consume_oauth_flow_intent_migration. Keeping this privilege contraction
-- separate from 0093 preserves compatibility during the expand/deploy/drain
-- phase while ensuring the raw reassignment primitive is no longer callable
-- through the Data API afterward.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- boss_paegi_oauth_contract_qualification_injection_point
select public.assert_oauth_rollout_deployment_qualification(
  '0094_oauth_flow_migration_contract'
);

revoke all on function public.reassign_anon_data(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.consume_legacy_signup_migration(
  uuid, uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

comment on function public.reassign_anon_data(uuid, uuid) is
  'Internal primitive; invoke only through flow-scoped OAuth migration consumption.';
comment on function public.consume_legacy_signup_migration(
  uuid, uuid, uuid, timestamptz, timestamptz
) is
  'Expand-only pre-ledger cookie bridge; execution revoked after the full deployment drain.';

notify pgrst, 'reload schema';
commit;
