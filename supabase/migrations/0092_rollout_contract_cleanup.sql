-- 0092_rollout_contract_cleanup.sql
--
-- Contract 단계. 0072~008899 expand migrations, 새 앱 배포, old-request drain,
-- smoke gate가 모두 통과한 경우에만 적용한다. Rolling compatibility surface를
-- 닫고 새 앱이 사용하는 최소 server-only surface만 남긴다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Serialize the contract boundary with every legacy DB-first reactivation.
-- A legacy call that acquired this lock first commits its durable repair
-- before this migration can inspect the backlog. A call already invoked but
-- still waiting observes the false rollout switch after this transaction
-- commits and fails before mutating the profile.
do $$
begin
  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
end;
$$;

-- 0090 installed the permanent requirement in a short transaction and 0091
-- validated every historical row without blocking ordinary DML. Re-prove the
-- exact constraint and unresolved-intent index here before compatibility
-- surfaces are removed; an out-of-band drop/recreate must not weaken contract.
do $$
declare
  v_constraint_def text;
  v_index_def text;
begin
  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_constraint_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.orders'::regclass
     and c.conname =
           'orders_portone_payment_evidence_required_check'
     and c.contype = 'c'
     and c.convalidated;
  if v_constraint_def is distinct from
       'check(((providerisdistinctfrom''portone''::text)or((payment_idisnotnull)and(payment_id=replace((order_uuid)::text,''-''::text,''''::text))and(expected_store_idisnotnull)and(expected_currencyisnotnull)and(expected_channel_keyisnotnull))))' then
    raise exception '0092 preflight: required payment evidence CHECK drift';
  end if;

  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_index_def
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
   where i.indrelid = 'public.orders'::regclass
     and idx.relname =
           'orders_one_unresolved_portone_intent_per_user_uidx'
     and i.indisunique
     and i.indisvalid
     and i.indisready;
  if v_index_def is distinct from
       'createuniqueindexorders_one_unresolved_portone_intent_per_user_uidxonpublic.ordersusingbtree(user_id)where((provider=''portone''::text)and(status=any(array[''pending''::text,''failed''::text]))and(paid_atisnull)and(canceled_atisnull))' then
    raise exception '0092 preflight: unresolved PortOne unique index drift';
  end if;
end;
$$;

-- No caller may start a new immutable-tuple adoption after contract. The
-- required CHECK above remains the final authority if an old insert/backfill
-- transaction overlaps this boundary.
do $$
begin
  if pg_catalog.to_regprocedure(
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
     ) is not null then
    revoke all on function public.backfill_portone_order_payment_evidence(
      uuid, text, integer, boolean, text, text, text, text
    ) from public, anon, authenticated, service_role;
  end if;
end;
$$;
drop function if exists public.backfill_portone_order_payment_evidence(
  uuid, text, integer, boolean, text, text, text, text
);

-- The old app is drained at this point. Activate the finite legacy-token
-- inventory window and snapshot every currently referenced no-intent object
-- before the orphan scanner may classify anything. This preserves rollback
-- assets while still recovering objects abandoned by an adoption-time DB
-- outage. Late uploads from an old token remain covered for its full horizon.
do $$
declare
  v_control public.storage_legacy_upload_sweep_control%rowtype;
  v_object record;
  v_now timestamptz := clock_timestamp();
begin
  update public.storage_legacy_upload_sweep_control
     set enabled_at = coalesce(enabled_at, v_now),
         window_ends_at = coalesce(
           window_ends_at,
           coalesce(enabled_at, v_now) + interval '2 hours 5 minutes'
         )
   where singleton = true
  returning * into v_control;
  if not found
     or v_control.enabled_at is null
     or v_control.window_ends_at is null then
    raise exception '0092 contract: legacy upload sweep activation missing';
  end if;

  for v_object in
    select o.bucket_id as bucket, o.name as path
      from storage.objects o
     where o.bucket_id in (
             'site-assets', 'events', 'avatars', 'highlights'
           )
       and o.created_at is not null
       and o.created_at >= v_control.inventory_floor_at
       and o.created_at <= v_control.window_ends_at
       and public.bp_legacy_signed_upload_purpose(
             o.bucket_id, o.name
           ) is not null
     order by o.bucket_id, o.name
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'storage-path:' || v_object.bucket || ':' || v_object.path,
        0
      )
    );
    if not exists (
         select 1
           from public.storage_upload_intents i
          where i.bucket = v_object.bucket
            and i.path = v_object.path
       )
       and public.bp_storage_path_is_referenced(
         v_object.bucket, v_object.path
       ) then
      insert into public.storage_legacy_upload_protections(
        bucket, path, reason
      )
      values (
        v_object.bucket,
        v_object.path,
        'contract_reference_snapshot'
      )
      on conflict (bucket, path) do nothing;
    end if;
  end loop;
end;
$$;

create or replace function public.bp_rollout_compatibility_enabled(
  p_feature text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false;
$$;
revoke all on function public.bp_rollout_compatibility_enabled(text)
  from public, anon, authenticated, service_role;

-- The old DB-first route could commit an active profile before its best-effort
-- GoTrue email write. 0085 durably captures/backfills that window. Never
-- remove the active-profile compatibility branch until both the outbox and
-- the observable orphan state are empty; a failed gate rolls this migration
-- back and the expand worker remains available.
do $$
begin
  -- A third real Auth email is not safe to overwrite automatically. It is
  -- therefore a visible manual-resolution blocker just like a missing/null
  -- user or the fixed deletion marker.
  if exists (
    select 1
      from public.account_reactivation_legacy_repairs j
     where j.status in ('pending', 'leased')
  ) then
    raise exception
      '0092 contract: legacy account reactivation repair backlog remains';
  end if;
  if exists (
    select 1
      from public.profiles p
      join public.member_accounts m on m.user_id = p.id
      left join auth.users u on u.id = p.id
     where p.deleted_at is null
       and (
         u.id is null
         or pg_catalog.lower(pg_catalog.btrim(u.email))
              is distinct from
                pg_catalog.lower(pg_catalog.btrim(m.email))
       )
  ) then
    raise exception
      '0092 contract: active account Auth email mismatch remains';
  end if;
end;
$$;

-- The expand window kept the old route working, so its GoTrue call could not
-- yet carry a lease fence. Once the new worker is deployed and old requests
-- are drained, make the external Auth side effect subject to the same exact
-- lifecycle lease as the database completion. This trigger is the
-- authoritative fence: a paused worker cannot use an expired token to change
-- a marker after another reactivation/withdrawal cycle (ABA).
create or replace function public.bp_fence_account_reactivation_auth_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_email text := pg_catalog.lower(pg_catalog.btrim(old.email));
  v_new_email text := pg_catalog.lower(pg_catalog.btrim(new.email));
  v_marker text := pg_catalog.lower(
    'deleted+' || old.id::text || '@deleted.invalid'
  );
  v_fence jsonb :=
    coalesce(new.raw_app_meta_data, '{}'::jsonb)
      -> 'bp_reactivation_fence';
  v_has_job boolean;
begin
  if v_old_email is not distinct from v_new_email then
    return new;
  end if;

  if v_old_email = v_marker and v_new_email <> v_marker then
    perform public.bp_account_reactivation_auth_transition_lock(
      old.id
    );
  end if;

  if v_old_email = v_marker
     and v_new_email <> v_marker
     and v_fence->>'action' = 'legacy_repair' then
    if coalesce(v_fence->>'legacy_repair_job_id', '') = ''
       or coalesce(v_fence->>'user_id', '') <> old.id::text
       or coalesce(v_fence->>'lease_token', '') = ''
       or coalesce(v_fence->>'lease_version', '')
            !~ '^[1-9][0-9]*$'
       or coalesce(v_fence->>'expected_withdrawal_generation', '')
            !~ '^[0-9]+$'
       or not exists (
         select 1
           from public.account_reactivation_legacy_repairs j
           join public.profiles p on p.id = j.user_id
           join public.member_accounts m on m.user_id = j.user_id
          where j.id::text = v_fence->>'legacy_repair_job_id'
            and j.user_id = old.id
            and j.lease_token::text = v_fence->>'lease_token'
            and j.lease_version =
                  (v_fence->>'lease_version')::integer
            and j.status = 'leased'
            and j.leased_until > pg_catalog.clock_timestamp()
            and j.expected_withdrawal_generation =
                  (
                    v_fence->>'expected_withdrawal_generation'
                  )::bigint
            and p.deleted_at is null
            and p.withdrawal_generation =
                  j.expected_withdrawal_generation
            and pg_catalog.lower(pg_catalog.btrim(m.email)) =
                  pg_catalog.lower(
                    pg_catalog.btrim(j.resolved_email)
                  )
            and v_new_email =
                  pg_catalog.lower(
                    pg_catalog.btrim(j.resolved_email)
                  )
       ) then
      raise exception 'stale_reactivation_auth_fence'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  select exists (
    select 1
      from public.account_reactivation_jobs j
     where j.user_id = old.id
       and j.status in ('pending', 'leased')
  )
  into v_has_job;
  if not v_has_job then
    if v_old_email = v_marker and v_new_email <> v_marker then
      raise exception 'stale_reactivation_auth_fence'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if pg_catalog.jsonb_typeof(v_fence) is distinct from 'object'
     or coalesce(v_fence->>'request_id', '') = ''
     or coalesce(v_fence->>'admin_user_id', '') = ''
     or coalesce(v_fence->>'user_id', '') <> old.id::text
     or coalesce(v_fence->>'lease_token', '') = ''
     or coalesce(v_fence->>'lease_version', '')
          !~ '^[1-9][0-9]*$'
     or coalesce(v_fence->>'action', '')
          not in ('activate', 'cancel')
     or coalesce(v_fence->>'expected_deleted_at', '') = ''
     or coalesce(v_fence->>'expected_withdrawal_generation', '')
          !~ '^[1-9][0-9]*$' then
    raise exception 'stale_reactivation_auth_fence'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.account_reactivation_jobs j
      join public.admin_mutation_requests r
        on r.request_id = j.request_id
      join public.profiles p
        on p.id = j.user_id
      left join public.member_accounts m
        on m.user_id = j.user_id
     where j.request_id::text = v_fence->>'request_id'
       and j.admin_user_id::text = v_fence->>'admin_user_id'
       and j.user_id = old.id
       and j.lease_token::text = v_fence->>'lease_token'
       and j.lease_version =
             (v_fence->>'lease_version')::integer
       and j.status = 'leased'
       and j.leased_until > pg_catalog.clock_timestamp()
       and j.expected_deleted_at =
             (v_fence->>'expected_deleted_at')::timestamptz
       and j.expected_withdrawal_generation =
             (v_fence->>'expected_withdrawal_generation')::bigint
       and p.deleted_at = j.expected_deleted_at
       and p.withdrawal_generation =
             j.expected_withdrawal_generation
       and r.state = 'pending'
       and r.operation = 'account_reactivate'
       and r.admin_user_id = j.admin_user_id
       and r.target_key = j.user_id::text
       and (r.request_payload->>'expected_deleted_at')::timestamptz =
             j.expected_deleted_at
       and (
             r.request_payload->>'expected_withdrawal_generation'
           )::bigint = j.expected_withdrawal_generation
       and pg_catalog.lower(
             pg_catalog.btrim(r.request_payload->>'resolved_email')
           ) = pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
       and (
         (
           v_fence->>'action' = 'activate'
           and j.cancel_requested_at is null
           and v_old_email = v_marker
           and v_new_email =
                 pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
           and m.user_id is not null
           and pg_catalog.lower(
                 pg_catalog.btrim(
                   public.bp_prepare_account_reactivation_email(
                     j.user_id,
                     r.request_payload->>'email_override'
                   )
                 )
               ) = pg_catalog.lower(
                 pg_catalog.btrim(j.resolved_email)
               )
             )
         or
         (
           v_fence->>'action' = 'cancel'
           and j.cancel_requested_at is not null
           and v_old_email =
                 pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
           and v_new_email = v_marker
         )
       )
  ) then
    raise exception 'stale_reactivation_auth_fence'
      using errcode = 'P0001';
  end if;
  return new;
exception
  when invalid_text_representation
    or datetime_field_overflow
    or numeric_value_out_of_range then
    raise exception 'stale_reactivation_auth_fence'
      using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_fence_account_reactivation_auth_email()
  from public, anon, authenticated, service_role;

-- Browser self-delete was retained only so the old Storage-first route could
-- not leave a live row pointing at a missing image.
revoke delete on table public.dolls from authenticated;
drop policy if exists "dolls: owner delete" on public.dolls;

-- Old server direct writes are no longer needed after the new atomic RPCs and
-- saga routes are live.
revoke insert, update, delete
  on table public.score_stats, public.user_badges
  from service_role;
revoke insert on table public.content_reports from service_role;
revoke insert, update, delete on table public.reviewer_accounts
  from service_role;
revoke all on table public.account_reactivation_jobs
  from public, anon, authenticated, service_role;
revoke all on table public.account_reactivation_legacy_repairs
  from public, anon, authenticated, service_role;

-- Remove any hosted-project table-level drift on server-read tables, then add
-- back only permanent reads and the intent-fenced doll insert used by the new
-- save route.
revoke insert, update, delete, truncate, trigger, references
  on table
    public.profiles,
    public.dolls,
    public.reviewer_accounts,
    public.score_flags
  from service_role;

do $$
declare
  v_table text;
  v_columns text;
begin
  foreach v_table in array array[
    'profiles',
    'dolls',
    'reviewer_accounts',
    'score_flags',
    'score_stats',
    'user_badges',
    'content_reports'
  ]
  loop
    select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ')
      into v_columns
      from pg_catalog.pg_attribute a
     where a.attrelid = ('public.' || v_table)::regclass
       and a.attnum > 0
       and not a.attisdropped;
    execute
      'revoke insert (' || v_columns || '), update (' || v_columns ||
      '), references (' || v_columns || ') on table public.' ||
      pg_catalog.quote_ident(v_table) || ' from service_role';
  end loop;
end;
$$;

grant select on table
  public.profiles,
  public.dolls,
  public.reviewer_accounts,
  public.score_flags
to service_role;
grant insert (id, owner_id, image_url, style_meta, role)
  on table public.dolls
  to service_role;

drop function if exists public.admin_adjust_credits(uuid, uuid, int, text);

-- 0062 exposed a full live-lot JSON array for a planned account-credit
-- surface, but no shipped application ever called it. Keeping it after the
-- old-request drain would retain an unbounded service-role aggregate with no
-- contract consumer. Permanent credit reads use the bounded member-account
-- projection instead.
do $$
begin
  if pg_catalog.to_regprocedure(
       'public.get_my_credits(uuid)'
     ) is not null then
    revoke all on function public.get_my_credits(uuid)
      from public, anon, authenticated, service_role;
  end if;
end;
$$;
drop function if exists public.get_my_credits(uuid);

-- 008903 kept these four names as idle/upgrade-required expand stubs so an
-- old worker could not consume a bounded v2 lease. Old requests are drained
-- at contract, so remove the stubs and retain only the token+version v2 RPCs.
revoke all on function public.claim_account_deletion_cleanup(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.finish_account_deletion_cleanup(
  uuid, uuid, boolean, text
) from public, anon, authenticated, service_role;
revoke all on function public.claim_moderation_purge(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.finish_moderation_purge(
  uuid, uuid, integer, boolean, text
) from public, anon, authenticated, service_role;
drop function public.claim_account_deletion_cleanup(uuid, integer);
drop function public.finish_account_deletion_cleanup(
  uuid, uuid, boolean, text
);
drop function public.claim_moderation_purge(uuid, integer);
drop function public.finish_moderation_purge(
  uuid, uuid, integer, boolean, text
);

-- 008905 retained the evidence-free 12-argument checkout wrapper only for
-- expand compatibility while checkout was globally frozen. The permanent
-- contract exposes solely the affirmative-withdrawal-evidence overload; its
-- renamed 008899 core remains a private implementation detail.
revoke all on function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
) from public, anon, authenticated, service_role;
drop function public.create_or_reuse_pending_order(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
);
revoke all on function public.bp_008905_create_or_reuse_pending_order_impl(
  uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text
) from public, anon, authenticated, service_role;

-- Superseded non-receipt mutation entry points remain private implementation
-- functions for the new SECURITY DEFINER wrappers, but are no longer directly
-- callable by the service client.
revoke all on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_legal_draft(
  text, text, jsonb, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.admin_publish_legal(text, date, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_unpublish_legal(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_update_app_setting(
  text, jsonb, integer, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_event(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, boolean, integer, boolean, boolean, integer, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_event(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, integer, boolean, boolean, integer, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.admin_publish_event(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_unpublish_event(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_delete_event(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_clear_score(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_void_score(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_ban_member(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_unban_member(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_takedown_doll(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_dismiss_doll(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_restore_doll(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_begin_doll_purge(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_reactivate_account(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.admin_begin_account_reactivation(
  uuid, uuid, text, text, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.admin_complete_account_reactivation(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.admin_settle_stuck_order(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
-- 008900 kept the four-argument telemetry protocol only for an old app
-- instance during expand. The drained contract surface exposes only the
-- five-argument opaque-actor wrapper; the renamed core remains private.
revoke all on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid,
  text, jsonb, jsonb, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
) from public, anon, authenticated, service_role;

-- Acquire the auth.users DDL lock only after the potentially long inventory
-- sweep and compatibility cleanup are complete. The remaining postflight is
-- catalog-only, so this lock is held for the shortest practical interval.
drop trigger if exists trg_auth_users_fence_account_reactivation
  on auth.users;
create trigger trg_auth_users_fence_account_reactivation
  before update of email on auth.users
  for each row
  execute function public.bp_fence_account_reactivation_auth_email();

create or replace function public.recon_issues_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_economic_reopen boolean := false;
begin
  if public.jsonb_has_sensitive_key(new.detail) then
    raise exception 'recon_issues_pii_in_detail' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.id <> old.id
     or new.type <> old.type
     or new.order_uuid <> old.order_uuid
     or new.user_id <> old.user_id
     or new.cancellation_id is distinct from old.cancellation_id
     or new.created_at <> old.created_at then
    raise exception 'recon_issues_immutable_field' using errcode = 'P0001';
  end if;

  if old.type = 'late_paid'
     and old.state in ('resolved', 'ignored')
     and new.state = 'open'
     and new.resolved_at is null
     and new.resolved_by is null
     and new.resolution_source is null
     and new.detail->>'economic_reopen_reason' =
           'late_paid_refund_incomplete'
     and exists (
       select 1
         from public.orders o
        where o.order_uuid = old.order_uuid
          and (
            coalesce(o.refunded_credits, 0) < o.credits
            or coalesce(o.refunded_amount, 0) < o.amount
          )
     ) then
    v_economic_reopen := true;
  end if;

  if new.state <> old.state
     and not (
       (old.state = 'open' and new.state in ('resolved', 'ignored'))
       or v_economic_reopen
     ) then
    raise exception 'recon_issues_state_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.recon_issues_guard()
  from public, anon, authenticated, service_role;

-- Idempotent final cleanup for deployments that crossed the reconciliation
-- gate while an acknowledgement-only late-paid issue was already closed.
update public.reconciliation_issues i
   set state = 'open',
       resolved_at = null,
       resolved_by = null,
       resolution_source = null,
       detail = coalesce(i.detail, '{}'::jsonb)
         || pg_catalog.jsonb_build_object(
           'economic_reopen_reason',
           'late_paid_refund_incomplete',
           'economic_reopen_previous_state',
           i.state,
           'economic_reopen_previous_resolved_at',
           i.resolved_at,
           'economic_reopen_previous_resolved_by',
           i.resolved_by,
           'economic_reopen_previous_source',
           i.resolution_source
         )
  from public.orders o
 where i.type = 'late_paid'
   and i.state in ('resolved', 'ignored')
   and o.order_uuid = i.order_uuid
   and (
     coalesce(o.refunded_credits, 0) < o.credits
     or coalesce(o.refunded_amount, 0) < o.amount
   );

do $$
declare
  v_signature text;
  v_function_def text;
begin
  if pg_catalog.to_regprocedure(
    'public.admin_adjust_credits(uuid,uuid,integer,text)'
  ) is not null then
    raise exception '0092 postflight: legacy admin adjustment RPC still exists';
  end if;
  if pg_catalog.to_regprocedure(
       'public.get_my_credits(uuid)'
     ) is not null then
    raise exception '0092 postflight: unbounded credit-lot RPC still exists';
  end if;

  if pg_catalog.to_regprocedure(
       'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_submit_score_with_review_core(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_consume_score_write_quota(text,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_probe_score_write_replay(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_consume_report_write_quota(text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_consume_report_legacy_write_quota()',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.record_public_analytics_event(text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.analytics_events',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.content_reports',
       'INSERT'
     )
     or pg_catalog.to_regclass(
       'public.public_write_attempts'
     ) is null
     or not coalesce(
       (
         select c.relrowsecurity
           from pg_catalog.pg_class c
          where c.oid = pg_catalog.to_regclass(
            'public.public_write_attempts'
          )
       ),
       false
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.public_write_attempts',
       'SELECT,INSERT,UPDATE,DELETE'
     ) then
    raise exception '0092 postflight: bounded public write ACL drift';
  end if;

  if public.bp_rollout_compatibility_enabled(
       'legacy_score_submission'
     )
     or public.bp_rollout_compatibility_enabled(
       'legacy_generation_transition'
     )
     or public.bp_rollout_compatibility_enabled(
       'legacy_checkout_reuse'
     )
     or public.bp_rollout_compatibility_enabled(
       'legacy_account_reactivation'
     ) then
    raise exception '0092 postflight: rollout compatibility still enabled';
  end if;

  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.admin_cancel_order(uuid,uuid,boolean,text,boolean)'::regprocedure
       ),
       'portone_cancellation_requires_provider_observation'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.admin_cancel_order(uuid,uuid,boolean,text)'::regprocedure
       ),
       'portone_cancellation_requires_provider_observation'
     ) = 0 then
    raise exception '0092 postflight: PortOne local cancellation fence drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.bp_0084_admin_resolve_reconciliation_issue_impl(uuid,uuid,text,text)'::regprocedure
         )
    into v_function_def;
  if pg_catalog.strpos(v_function_def, 'i.type = ''late_paid''') = 0
     or pg_catalog.strpos(v_function_def, 'economic_resolution_required') = 0
     or pg_catalog.strpos(v_function_def, 'v_order.refunded_credits') = 0
     or pg_catalog.strpos(v_function_def, 'v_order.refunded_amount') = 0
     or pg_catalog.strpos(v_function_def, 'v_order.amount') = 0 then
    raise exception '0092 postflight: late-paid economic resolution fence drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.recon_issues_guard()'::regprocedure
         )
    into v_function_def;
  if pg_catalog.strpos(v_function_def, 'v_economic_reopen') = 0
     or pg_catalog.strpos(v_function_def, 'late_paid_refund_incomplete') = 0
     or pg_catalog.strpos(v_function_def, 'o.refunded_credits') = 0
     or pg_catalog.strpos(v_function_def, 'o.refunded_amount') = 0 then
    raise exception '0092 postflight: late-paid issue reopen guard drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.record_unsettled_order_observation(uuid,text,text,text,text,text,jsonb)'::regprocedure
         )
    into v_function_def;
  if pg_catalog.strpos(v_function_def, 'for update') = 0
     or pg_catalog.strpos(v_function_def, 'o.status is distinct from p_expected_status') = 0
     or pg_catalog.strpos(v_function_def, 'o.error_message is distinct from p_expected_error_message') = 0
     or pg_catalog.strpos(v_function_def, 'o.paid_at is not null') = 0
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.record_unsettled_order_observation(uuid,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.record_unsettled_order_observation(uuid,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.record_unsettled_order_observation(uuid,text,text,text,text,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception '0092 postflight: order observation CAS/ACL drift';
  end if;

  if pg_catalog.to_regprocedure(
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
     ) is null
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_008905_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.to_regprocedure(
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
     ) is not null
     or not exists (
       select 1
         from pg_catalog.pg_constraint c
        where c.conrelid = 'public.orders'::regclass
          and c.conname = 'orders_payment_evidence_snapshot_check'
          and c.contype = 'c'
          and c.convalidated
     )
     or not exists (
       select 1
         from pg_catalog.pg_constraint c
        where c.conrelid = 'public.orders'::regclass
          and c.conname =
                'orders_portone_payment_evidence_required_check'
          and c.contype = 'c'
          and c.convalidated
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.orders'::regclass
          and t.tgname = 'trg_orders_payment_evidence_snapshot'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgtype = 19
          and t.tgfoid =
                'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
          and t.tgattr = (
            select pg_catalog.string_agg(
                     a.attnum::text,
                     ' '
                     order by a.attnum
                   )::pg_catalog.int2vector
              from pg_catalog.pg_attribute a
             where a.attrelid = 'public.orders'::regclass
               and a.attname in (
                 'expected_store_id',
                 'expected_currency',
                 'expected_channel_key'
               )
               and not a.attisdropped
          )
     )
     or not exists (
       select 1
         from pg_catalog.pg_proc p
        where p.oid =
                'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
          and p.prosecdef
          and p.proconfig = array['search_path=""']::text[]
          and pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) =
                '048f737fe9b3bea8393389935a1aa31e'
          and not pg_catalog.has_function_privilege(
            'public',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'anon',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'service_role',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
     )
     or pg_catalog.has_column_privilege(
       'service_role', 'public.orders', 'expected_store_id', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'service_role', 'public.orders', 'expected_currency', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'service_role', 'public.orders', 'expected_channel_key', 'UPDATE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_0087_mark_paid_and_grant_financial_impl(uuid,text,integer,jsonb,timestamptz,text)',
       'EXECUTE'
     )
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_mark_paid_and_grant_impl(uuid,text,integer,jsonb,timestamptz,text)'::regprocedure
       ),
       'p_raw->>''storeId'' is distinct from v_order.expected_store_id'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_mark_paid_and_grant_impl(uuid,text,integer,jsonb,timestamptz,text)'::regprocedure
       ),
       'p_raw->>''id'' is distinct from v_order.payment_id'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_mark_paid_and_grant_impl(uuid,text,integer,jsonb,timestamptz,text)'::regprocedure
       ),
       'v_raw_paid_at is distinct from p_paid_at'
     ) = 0 then
    raise exception '0092 postflight: payment evidence contract drift';
  end if;

  if not exists (
       select 1
         from public.storage_legacy_upload_sweep_control c
        where c.singleton = true
          and c.enabled_at is not null
          and c.window_ends_at =
            c.enabled_at + interval '2 hours 5 minutes'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.enqueue_legacy_signed_upload_orphans(integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.enqueue_legacy_signed_upload_orphans(integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.enqueue_legacy_signed_upload_orphans(integer)',
       'EXECUTE'
     ) then
    raise exception '0092 postflight: legacy upload sweep contract drift';
  end if;

  if pg_catalog.has_table_privilege(
       'authenticated', 'public.dolls', 'DELETE'
     )
     or exists (
       select 1
         from pg_catalog.pg_policy p
        where p.polrelid = 'public.dolls'::regclass
          and p.polcmd = 'd'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.score_stats', 'INSERT,UPDATE,DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.user_badges', 'INSERT,UPDATE,DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.content_reports', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.reviewer_accounts', 'INSERT,UPDATE,DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'anon', 'public.account_reactivation_jobs', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.account_reactivation_jobs', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'anon',
       'public.account_reactivation_legacy_repairs',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.account_reactivation_legacy_repairs',
       'SELECT'
     )
  then
    raise exception '0092 postflight: rolling DML surface remains';
  end if;

  if not pg_catalog.has_table_privilege(
       'service_role', 'public.profiles', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.dolls', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.reviewer_accounts', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.score_flags', 'SELECT'
     )
     or not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'id', 'INSERT'
     )
     or not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'owner_id', 'INSERT'
     )
     or pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'deleted_at', 'INSERT'
     )
  then
    raise exception '0092 postflight: permanent server table surface drift';
  end if;

  if not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'auth.users'::regclass
          and t.tgname =
            'trg_auth_users_fence_account_reactivation'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgtype = 19
          and t.tgfoid =
                'public.bp_fence_account_reactivation_auth_email()'::regprocedure
          and t.tgattr = (
            select a.attnum::text::pg_catalog.int2vector
              from pg_catalog.pg_attribute a
             where a.attrelid = 'auth.users'::regclass
               and a.attname = 'email'
               and not a.attisdropped
          )
     )
     or not exists (
       select 1
         from pg_catalog.pg_proc p
        where p.oid =
                'public.bp_fence_account_reactivation_auth_email()'::regprocedure
          and p.prosecdef
          and p.proconfig = array['search_path=""']::text[]
          and pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) =
                '326dbab65920850bc223378b7c167e74'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_fence_account_reactivation_auth_email()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.bp_fence_account_reactivation_auth_email()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.bp_fence_account_reactivation_auth_email()',
       'EXECUTE'
     ) then
    raise exception '0092 postflight: Auth reactivation fence drift';
  end if;

  if not (
    has_function_privilege(
      'service_role',
      'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.get_moderation_purge_status(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_moderation_purge_status(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.get_moderation_purge_status(uuid,uuid,uuid)',
      'EXECUTE'
    )
  ) then
    raise exception '0092 postflight: permanent mutation ACL drift';
  end if;

  foreach v_signature in array array[
    'public.admin_begin_account_reactivation(uuid,uuid,text,text,timestamptz,bigint,uuid)',
    'public.claim_account_reactivation_job(uuid,uuid,uuid,integer)',
    'public.arm_account_reactivation_auth_fence(uuid,uuid,uuid,uuid,integer)',
    'public.finish_account_reactivation_job(uuid,uuid,uuid,uuid,integer,boolean,text)',
    'public.get_account_reactivation_status(uuid,uuid,uuid)',
    'public.get_pending_account_reactivation(uuid,uuid)',
    'public.get_account_reactivation_queue_health()',
    'public.request_account_reactivation_cancellation(uuid,uuid,uuid,text,timestamptz,bigint)',
    'public.claim_account_reactivation_legacy_repair(integer)',
    'public.arm_account_reactivation_legacy_repair_auth_fence(uuid,uuid,uuid,integer)',
    'public.finish_account_reactivation_legacy_repair(uuid,uuid,uuid,integer,boolean,text)',
    'public.get_account_reactivation_legacy_repair_status(uuid,uuid)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or not pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       ) then
      raise exception '0092 postflight: reactivation RPC ACL drift (%)',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid)',
    'public.admin_publish_legal(text,date,uuid)',
    'public.admin_unpublish_legal(text,uuid)',
    'public.admin_update_app_setting(text,jsonb,integer,uuid,text)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_publish_event(uuid,uuid)',
    'public.admin_unpublish_event(uuid,uuid)',
    'public.admin_delete_event(uuid,uuid)',
    'public.admin_clear_score(uuid,uuid,text)',
    'public.admin_void_score(uuid,uuid,text)',
    'public.admin_ban_member(uuid,uuid,text)',
    'public.admin_unban_member(uuid,uuid,text)',
    'public.admin_takedown_doll(uuid,uuid,text)',
    'public.admin_dismiss_doll(uuid,uuid,text)',
    'public.admin_restore_doll(uuid,uuid,text)',
    'public.admin_begin_doll_purge(uuid,uuid,text)',
    'public.admin_reactivate_account(uuid,uuid,text,text)',
    'public.admin_begin_account_reactivation(uuid,uuid,text,text,timestamptz,uuid)',
    'public.admin_complete_account_reactivation(uuid,uuid,uuid)',
    'public.admin_settle_stuck_order(uuid,uuid,text)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
    then
      raise exception '0092 postflight: legacy RPC surface drift (%)',
        v_signature;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_signature text;
  v_function_def text;
begin
  foreach v_signature in array array[
    'public.claim_account_deletion_cleanup(uuid,integer)',
    'public.finish_account_deletion_cleanup(uuid,uuid,boolean,text)',
    'public.claim_moderation_purge(uuid,integer)',
    'public.finish_moderation_purge(uuid,uuid,integer,boolean,text)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is not null then
      raise exception '0092 postflight: cleanup compatibility stub remains (%)',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)',
    'public.finish_account_deletion_cleanup_v2(uuid,uuid,integer,boolean,text)',
    'public.arm_account_deletion_cleanup_auth_fence(uuid,uuid,uuid,integer)',
    'public.claim_moderation_purge_v2(uuid,integer,integer)',
    'public.finish_moderation_purge_v2(uuid,uuid,integer,boolean,text)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or not pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       ) then
      raise exception '0092 postflight: cleanup v2 ACL drift (%)',
      v_signature;
    end if;
  end loop;

  if not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'auth.users'::regclass
          and t.tgname =
                'trg_auth_users_fence_account_deletion_scrub'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgfoid =
                'public.bp_fence_account_deletion_auth_scrub()'::regprocedure
     )
     or pg_catalog.has_function_privilege(
          'service_role',
          'public.bp_fence_account_deletion_auth_scrub()',
          'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'authenticated',
          'public.bp_fence_account_deletion_auth_scrub()',
          'EXECUTE'
  ) then
    raise exception '0092 postflight: account cleanup Auth fence drift';
  end if;

  if pg_catalog.to_regprocedure(
       'public.bp_account_cleanup_generation_targets(uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_scrub_account_generation_batch(uuid,jsonb)'
        ) is null
     or pg_catalog.has_function_privilege(
          'service_role',
          'public.bp_scrub_account_generation_batch(uuid,jsonb)',
          'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'authenticated',
          'public.bp_scrub_account_generation_batch(uuid,jsonb)',
          'EXECUTE'
        )
     or not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid =
                'public.account_deletion_cleanup_jobs'::regclass
          and a.attname = 'lease_generation_ids'
          and not a.attisdropped
     )
     or not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.ai_generations'::regclass
          and a.attname = 'privacy_scrubbed_at'
          and not a.attisdropped
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.ai_generations'::regclass
          and t.tgname = 'trg_ai_generations_fence_privacy_scrub'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgfoid =
                'public.bp_fence_ai_generation_privacy()'::regprocedure
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid =
                'public.generation_cost_reconciliation_issues'::regclass
          and t.tgname =
                'trg_generation_reconciliation_fence_privacy'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgfoid =
                'public.bp_fence_generation_reconciliation_privacy()'
                  ::regprocedure
     )
     or (
       select pg_catalog.count(*)
         from pg_catalog.pg_constraint c
        where c.conname in (
                'generation_preflight_generation_owner_fkey',
                'generation_submit_generation_owner_fkey',
                'generation_pick_generation_owner_fkey',
                'generation_pick_cost_generation_owner_fkey',
                'generation_reconciliation_generation_owner_fkey'
              )
          and c.contype = 'f'
          and c.convalidated
     ) <> 5
     or not exists (
       select 1
         from pg_catalog.pg_constraint c
        where c.conrelid = 'public.ai_generations'::regclass
          and c.conname = 'ai_generations_id_owner_key'
          and c.contype = 'u'
          and c.convalidated
     ) then
    raise exception
      '0092 postflight: cleanup generation privacy fence drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.finish_account_deletion_cleanup_v2(uuid,uuid,integer,boolean,text)'
             ::regprocedure
         )
    into v_function_def;
  if pg_catalog.strpos(
       v_function_def,
       'bp_scrub_account_generation_batch'
     ) = 0
     or pg_catalog.strpos(v_function_def, 'lease_generation_ids') = 0
     or pg_catalog.strpos(v_function_def, 'scrubbed_generation_count') = 0 then
    raise exception
      '0092 postflight: cleanup generation privacy terminal drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0092_rollout_contract_cleanup', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
