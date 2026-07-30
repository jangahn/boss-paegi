#!/usr/bin/env node

const API_HOST = "https://api.supabase.com";
export const MAX_MANAGEMENT_BODY_BYTES = 1024 * 1024;
const INDEX_NAME = "orders_one_unresolved_portone_intent_per_user_uidx";
const EXPECTED_DEFINITION =
  "createuniqueindexorders_one_unresolved_portone_intent_per_user_uidxonpublic.ordersusingbtree(user_id)where((provider='portone'::text)and(status=any(array['pending'::text,'failed'::text]))and(paid_atisnull)and(canceled_atisnull))";

const DUPLICATE_INVENTORY_SQL = `
select pg_catalog.count(*)::text as duplicate_users
from (
  select o.user_id
  from public.orders o
  where o.provider = 'portone'
    and o.status in ('pending', 'failed')
    and o.paid_at is null
    and o.canceled_at is null
  group by o.user_id
  having pg_catalog.count(*) > 1
) duplicates`;

const INDEX_CATALOG_SQL = `
select
  pg_catalog.count(*)::text as named_indexes,
  pg_catalog.count(*) filter (
    where i.indisunique
      and i.indisvalid
      and i.indisready
      and pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
            '[[:space:]]',
            '',
            'g'
          ) = '${EXPECTED_DEFINITION.replaceAll("'", "''")}'
  )::text as exact_indexes,
  pg_catalog.count(*) filter (
    where i.indisunique
      and (not i.indisvalid or not i.indisready)
      and not exists (
        select 1
          from pg_catalog.pg_stat_progress_create_index p
         where p.index_relid = i.indexrelid
      )
      and pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
            '[[:space:]]',
            '',
            'g'
          ) = '${EXPECTED_DEFINITION.replaceAll("'", "''")}'
  )::text as repairable_indexes,
  pg_catalog.count(*) filter (
    where i.indisunique
      and (not i.indisvalid or not i.indisready)
      and exists (
        select 1
          from pg_catalog.pg_stat_progress_create_index p
         where p.index_relid = i.indexrelid
      )
      and pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
            '[[:space:]]',
            '',
            'g'
          ) = '${EXPECTED_DEFINITION.replaceAll("'", "''")}'
  )::text as building_indexes
from pg_catalog.pg_class idx
join pg_catalog.pg_namespace n on n.oid = idx.relnamespace
join pg_catalog.pg_index i on i.indexrelid = idx.oid
where n.nspname = 'public'
  and idx.relname = '${INDEX_NAME}'`;

// This must remain the only statement in its Management API request.
// Supabase CLI migration batches are implicitly transactional, while
// CREATE INDEX CONCURRENTLY is explicitly forbidden inside a transaction.
const CREATE_INDEX_SQL = `
create unique index concurrently ${INDEX_NAME}
on public.orders (user_id)
where provider = 'portone'
  and status in ('pending', 'failed')
  and paid_at is null
  and canceled_at is null`;

// A cancelled CREATE INDEX CONCURRENTLY can leave this exact-definition
// relation behind with indisvalid=false. It cannot enforce the invariant and
// PostgreSQL will refuse a same-name retry until it is removed. Keep the drop
// as its own top-level request for the same transaction-boundary reason as the
// create.
const DROP_REPAIRABLE_INDEX_SQL = `
drop index concurrently public.${INDEX_NAME}`;

function readManagementEnvironment(env = process.env) {
  const token = env.BOSS_PAEGI_SUPABASE_ACCESS_TOKEN;
  const ref = env.BOSS_PAEGI_SUPABASE_PROJECT_REF;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("BOSS_PAEGI_SUPABASE_ACCESS_TOKEN is not configured");
  }
  if (typeof ref !== "string" || !/^[a-z0-9]{20}$/.test(ref)) {
    throw new Error("BOSS_PAEGI_SUPABASE_PROJECT_REF is not configured");
  }
  return { token, ref };
}

async function managementQuery(sql, { token, ref }, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${API_HOST}/v1/projects/${encodeURIComponent(ref)}/database/query`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql.trim() }),
      redirect: "error",
      signal: AbortSignal.timeout(10 * 60_000),
    },
  );
  if (!response.ok || response.redirected) {
    // Do not echo the provider response: a duplicate-index error may contain a
    // user UUID, and authorization/debug payloads are never terminal output.
    throw new Error(`Supabase Management API request failed (${response.status})`);
  }
  const body = await readBoundedManagementJson(response);
  if (!Array.isArray(body)) {
    throw new Error("Supabase Management API returned an invalid response");
  }
  return body;
}

export async function readBoundedManagementJson(
  response,
  maxBytes = MAX_MANAGEMENT_BODY_BYTES,
) {
  if (
    !response?.body ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new Error("Supabase Management API returned an invalid response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(
          "Supabase Management API returned an invalid response",
        );
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          "Supabase Management API returned an invalid response",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The fixed failure verdict is already final.
    }
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Supabase Management API returned an invalid response");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Supabase Management API returned an invalid response");
  }
}

function exactNonNegativeInteger(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} was not an exact non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeded the safe integer range`);
  }
  return parsed;
}

async function readCatalog(env, fetchImpl) {
  const rows = await managementQuery(INDEX_CATALOG_SQL, env, fetchImpl);
  if (
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== "object" ||
    Array.isArray(rows[0]) ||
    Object.keys(rows[0]).sort().join(",") !==
      "building_indexes,exact_indexes,named_indexes,repairable_indexes"
  ) {
    throw new Error("index catalog query returned an invalid row count");
  }
  return {
    named: exactNonNegativeInteger(rows[0].named_indexes, "named index count"),
    exact: exactNonNegativeInteger(rows[0].exact_indexes, "exact index count"),
    repairable: exactNonNegativeInteger(
      rows[0].repairable_indexes,
      "repairable index count",
    ),
    building: exactNonNegativeInteger(
      rows[0].building_indexes,
      "building index count",
    ),
  };
}

async function readDuplicateUsers(env, fetchImpl) {
  const duplicateRows = await managementQuery(
    DUPLICATE_INVENTORY_SQL,
    env,
    fetchImpl,
  );
  if (
    duplicateRows.length !== 1 ||
    !duplicateRows[0] ||
    typeof duplicateRows[0] !== "object" ||
    Array.isArray(duplicateRows[0]) ||
    Object.keys(duplicateRows[0]).join(",") !== "duplicate_users"
  ) {
    throw new Error("duplicate inventory query returned an invalid row count");
  }
  return exactNonNegativeInteger(
    duplicateRows[0].duplicate_users,
    "duplicate unresolved-intent user count",
  );
}

function assertNoDuplicateUsers(duplicateUsers) {
  if (duplicateUsers !== 0) {
    throw new Error(
      `concurrent index preflight blocked: ${duplicateUsers} duplicate user inventory set(s)`,
    );
  }
}

export async function ensurePaymentIntentIndex({
  env = readManagementEnvironment(),
  fetchImpl = fetch,
  checkOnly = false,
} = {}) {
  let duplicateUsers = await readDuplicateUsers(env, fetchImpl);
  assertNoDuplicateUsers(duplicateUsers);

  let before = await readCatalog(env, fetchImpl);
  if (
    before.named === 1 &&
    before.exact === 1 &&
    before.repairable === 0 &&
    before.building === 0
  ) {
    return { changed: false, duplicateUsers, exactIndexes: 1 };
  }
  if (
    before.named === 1 &&
    before.exact === 0 &&
    before.repairable === 0 &&
    before.building === 1
  ) {
    throw new Error("exact unresolved-intent index build is still in progress");
  }
  if (
    before.named === 1 &&
    before.exact === 0 &&
    before.repairable === 1 &&
    before.building === 0
  ) {
    if (checkOnly) {
      throw new Error(
        "exact unresolved-intent index is interrupted and requires repair",
      );
    }
    try {
      await managementQuery(DROP_REPAIRABLE_INDEX_SQL, env, fetchImpl);
    } catch {
      // The Management API response can be lost after DROP commits. Accept
      // only an exact catalog re-read proving that the relation is gone.
      const recovered = await readCatalog(env, fetchImpl);
      if (
        recovered.named !== 0 ||
        recovered.exact !== 0 ||
        recovered.repairable !== 0 ||
        recovered.building !== 0
      ) {
        throw new Error("interrupted unresolved-intent index cleanup failed");
      }
    }
    before = await readCatalog(env, fetchImpl);
    if (
      before.named !== 0 ||
      before.exact !== 0 ||
      before.repairable !== 0 ||
      before.building !== 0
    ) {
      throw new Error("interrupted unresolved-intent index cleanup failed");
    }
    // The invalid relation did not enforce uniqueness. Re-linearize the
    // duplicate inventory after dropping it and immediately before rebuilding.
    duplicateUsers = await readDuplicateUsers(env, fetchImpl);
    assertNoDuplicateUsers(duplicateUsers);
  } else if (
    before.named !== 0 ||
    before.exact !== 0 ||
    before.repairable !== 0 ||
    before.building !== 0
  ) {
    throw new Error("same-name unresolved-intent index is invalid or drifted");
  }
  if (checkOnly) {
    throw new Error("exact unresolved-intent index is not installed");
  }

  try {
    await managementQuery(CREATE_INDEX_SQL, env, fetchImpl);
  } catch {
    // A successful CREATE can outlive its HTTP response. Conversely, an
    // interrupted build can leave a repairable invalid relation. Only the
    // exact valid/ready catalog state is success; the latter state is
    // intentionally recoverable by the next invocation.
    const recovered = await readCatalog(env, fetchImpl);
    if (
      recovered.named === 1 &&
      recovered.exact === 1 &&
      recovered.repairable === 0 &&
      recovered.building === 0
    ) {
      return { changed: true, duplicateUsers, exactIndexes: 1 };
    }
    if (
      recovered.named === 1 &&
      recovered.exact === 0 &&
      recovered.repairable === 1 &&
      recovered.building === 0
    ) {
      throw new Error(
        "concurrent index build was interrupted; rerun to repair",
      );
    }
    throw new Error("concurrent index creation failed");
  }
  const after = await readCatalog(env, fetchImpl);
  if (
    after.named !== 1 ||
    after.exact !== 1 ||
    after.repairable !== 0 ||
    after.building !== 0
  ) {
    throw new Error("concurrent index postcondition failed");
  }
  return { changed: true, duplicateUsers, exactIndexes: 1 };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await ensurePaymentIntentIndex({
    checkOnly: process.argv.includes("--check"),
  });
  console.log(
    `payment intent index exact: yes; changed: ${result.changed ? "yes" : "no"}; duplicate users: ${result.duplicateUsers}`,
  );
}
