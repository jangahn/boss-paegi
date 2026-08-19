#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

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

db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
if [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-permanent-surface-contract.XXXXXX")"
contract_sql_out="$qa_tmp_dir/contract-sql.out"

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

cleanup() {
  set +e
  rm -f "$contract_sql_out"
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

fail() {
  echo "permanent surface contract QA failed: $*" >&2
  exit 1
}

sql_status=0
db_psql -Aqt >"$contract_sql_out" 2>&1 <<'SQL' || sql_status=$?
begin;

create function pg_temp.qa_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $qa$
begin
  if p_condition is distinct from true then
    raise exception 'permanent surface contract assertion failed: %', p_message;
  end if;
end;
$qa$;

select pg_temp.qa_assert(
  not public.bp_rollout_compatibility_enabled('legacy_score_submission')
  and not public.bp_rollout_compatibility_enabled(
    'legacy_generation_transition'
  )
  and not public.bp_rollout_compatibility_enabled(
    'legacy_checkout_reuse'
  ),
  'all bounded rollout flags must be disabled'
);
select pg_temp.qa_assert(
  not pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.score_stats', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.user_badges', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.content_reports', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.reviewer_accounts', 'DELETE'
  ),
  'all old direct server DML grants must be closed'
);
select pg_temp.qa_assert(
  pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'id', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'owner_id', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'image_url', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'style_meta', 'INSERT'
  )
  and pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'role', 'INSERT'
  )
  and not pg_catalog.has_column_privilege(
    'service_role', 'public.dolls', 'deleted_at', 'INSERT'
  ),
  'only the permanent intent-fenced doll insert columns may remain'
);

do $qa$
declare
  v_table text;
  v_signature text;
begin
  foreach v_table in array array[
    'admin_actions_ledger',
    'ai_generations',
    'analytics_events',
    'analytics_rollups',
    'app_settings',
    'app_settings_audit',
    'credit_ledger',
    'credit_lots',
    'dolls',
    'events',
    'legal_documents',
    'member_accounts',
    'order_refund_attempts',
    'orders',
    'profiles',
    'reconciliation_issues',
    'refund_requests',
    'reviewer_accounts',
    'score_flags',
    'score_highlights',
    'score_stats',
    'scores',
    'telemetry_rollups',
    'telemetry_sessions',
    'user_badges'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regclass('public.' || v_table) is not null
      and pg_catalog.has_table_privilege(
        'service_role',
        'public.' || v_table,
        'SELECT'
      ),
      'permanent service read unavailable: ' || v_table
    );
  end loop;

  foreach v_signature in array array[
    'public.admin_publish_legal(text,date,uuid)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_publish_event(uuid,uuid)',
    'public.admin_unpublish_event(uuid,uuid)',
    'public.admin_delete_event(uuid,uuid)',
    'public.admin_takedown_doll(uuid,uuid,text)',
    'public.admin_dismiss_doll(uuid,uuid,text)'
  ]
  loop
    perform pg_temp.qa_assert(
      pg_catalog.to_regprocedure(v_signature) is not null,
      'legacy implementation unexpectedly missing: ' || v_signature
    );
    perform pg_temp.qa_assert(
      not pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(v_signature),
        'EXECUTE'
      ),
      'legacy RPC remains externally executable: ' || v_signature
    );
  end loop;
end;
$qa$;

select 'permanent_surface_contract_sql_ok';
rollback;
SQL
if (( sql_status != 0 )); then
  cat "$contract_sql_out" >&2
  fail "SQL contract checks failed"
fi
marker_count="$(
  grep -Fxc "permanent_surface_contract_sql_ok" "$contract_sql_out" || true
)"
[[ "$marker_count" == "1" ]] \
  || fail "SQL marker missing or duplicated: permanent_surface_contract_sql_ok"

command -v supabase >/dev/null 2>&1 \
  || fail "Supabase CLI is required for local PostgREST verification"
command -v curl >/dev/null 2>&1 \
  || fail "curl is required for local PostgREST verification"
if ! status_env="$(supabase status -o env 2>/dev/null)"; then
  fail "could not read disposable Supabase status"
fi
eval "$status_env"
: "${API_URL:?local Supabase status did not provide API_URL}"
: "${ANON_KEY:?local Supabase status did not provide ANON_KEY}"
: "${SERVICE_ROLE_KEY:?local Supabase status did not provide SERVICE_ROLE_KEY}"
: "${JWT_SECRET:?local Supabase status did not provide JWT_SECRET}"
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*)
    ;;
  *)
    fail "refusing to run permanent surface QA against a non-local API URL"
    ;;
esac

read_tables=(
  admin_actions_ledger
  ai_generations
  analytics_events
  analytics_rollups
  app_settings
  app_settings_audit
  credit_ledger
  credit_lots
  dolls
  events
  legal_documents
  member_accounts
  order_refund_attempts
  orders
  profiles
  reconciliation_issues
  refund_requests
  reviewer_accounts
  score_flags
  score_highlights
  score_stats
  scores
  telemetry_rollups
  telemetry_sessions
  user_badges
)
for table_name in "${read_tables[@]}"; do
  http_status=""
  for _ in $(seq 1 20); do
    http_status="$(
      curl --globoff --silent --show-error \
        --connect-timeout 2 \
        --max-time 5 \
        --output /dev/null \
        --write-out '%{http_code}' \
        --header "apikey: $SERVICE_ROLE_KEY" \
        --header "Authorization: Bearer $SERVICE_ROLE_KEY" \
        "$API_URL/rest/v1/$table_name?select=*&limit=0" \
        || true
    )"
    if [[ "$http_status" == "200" || "$http_status" == "206" ]]; then
      break
    fi
    sleep 0.25
  done
  [[ "$http_status" == "200" || "$http_status" == "206" ]] \
    || fail "PostgREST service read failed for $table_name (HTTP $http_status)"
done

command -v node >/dev/null 2>&1 \
  || fail "Node.js is required for local authenticated-role JWT verification"
authenticated_token="$(
  QA_LOCAL_JWT_SECRET="$JWT_SECRET" node -e '
    const crypto = require("node:crypto");
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
      email: "permanent-surface-authenticated@test.local",
      iss: "supabase",
      role: "authenticated",
      sub: "00000000-0000-4000-8000-000000000099",
    });
    const input = `${header}.${payload}`;
    const signature = crypto
      .createHmac("sha256", process.env.QA_LOCAL_JWT_SECRET)
      .update(input)
      .digest("base64url");
    process.stdout.write(`${input}.${signature}`);
  '
)"
[[ "$authenticated_token" == *.*.* ]] \
  || fail "could not mint the local authenticated-role QA token"

for auth_probe in \
  "anon|$ANON_KEY" \
  "authenticated|$authenticated_token"; do
  IFS='|' read -r auth_probe_role auth_probe_token <<<"$auth_probe"
  auth_probe_status="$(
    curl --globoff --silent --show-error \
      --connect-timeout 2 \
      --max-time 5 \
      --output /dev/null \
      --write-out '%{http_code}' \
      --header "apikey: $ANON_KEY" \
      --header "Authorization: Bearer $auth_probe_token" \
      "$API_URL/rest/v1/profiles?select=id&limit=0" \
      || true
  )"
  [[ "$auth_probe_status" == "200" || "$auth_probe_status" == "206" ]] \
    || fail "$auth_probe_role QA token failed its PostgREST read probe"
done

backfill_payload_eight='{
  "p_order_uuid":"00000000-0000-4000-8000-000000000001",
  "p_payment_id":"00000000000040008000000000000001",
  "p_amount":0,
  "p_is_test":false,
  "p_pay_channel":"card",
  "p_expected_store_id":"store-qa",
  "p_expected_currency":"KRW",
  "p_expected_channel_key":"channel-card-live"
}'
backfill_payload_seven='{
  "p_order_uuid":"00000000-0000-4000-8000-000000000001",
  "p_payment_id":"00000000000040008000000000000001",
  "p_amount":0,
  "p_is_test":false,
  "p_expected_store_id":"store-qa",
  "p_expected_currency":"KRW",
  "p_expected_channel_key":"channel-card-live"
}'

postgrest_rpc() {
  rpc_api_key="$1"
  rpc_bearer="$2"
  rpc_payload="$3"
  curl --globoff --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --request POST \
    --header "apikey: $rpc_api_key" \
    --header "Authorization: Bearer $rpc_bearer" \
    --header "Content-Type: application/json" \
    --data "$rpc_payload" \
    --write-out $'\n%{http_code}' \
    "$API_URL/rest/v1/rpc/backfill_portone_order_payment_evidence"
}

service_rpc_response=""
for _ in $(seq 1 20); do
  service_rpc_response="$(
    postgrest_rpc \
      "$SERVICE_ROLE_KEY" \
      "$SERVICE_ROLE_KEY" \
      "$backfill_payload_eight" \
      || true
  )"
  service_rpc_status="${service_rpc_response##*$'\n'}"
  service_rpc_body="${service_rpc_response%$'\n'*}"
  if [[ "$service_rpc_status" == "404" ]]; then
    break
  fi
  sleep 0.25
done
[[ "$service_rpc_status" == "404" \
   && "$service_rpc_body" != *"invalid_payment_evidence_snapshot"* ]] \
  || fail "contract still exposes the eight-argument backfill RPC"

seven_rpc_response="$(
  postgrest_rpc \
    "$SERVICE_ROLE_KEY" \
    "$SERVICE_ROLE_KEY" \
    "$backfill_payload_seven" \
    || true
)"
seven_rpc_status="${seven_rpc_response##*$'\n'}"
seven_rpc_body="${seven_rpc_response%$'\n'*}"
[[ "$seven_rpc_status" == "404" \
   && "$seven_rpc_body" != *"invalid_payment_evidence_snapshot"* ]] \
  || fail "superseded seven-argument backfill remains callable"

echo "permanent surface contract QA passed: SQL flag/ACL/catalog checks, PostgREST service reads ${#read_tables[@]}/${#read_tables[@]}, anon+authenticated read probes, 7/8-arg backfill RPCs absent"
