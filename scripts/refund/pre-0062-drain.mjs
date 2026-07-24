#!/usr/bin/env node
/**
 * pre-0062-drain.mjs — 0062 적용 직전, **기존 테이블만** 보고 open money op 이 0 인지 실측(§23·§14.1).
 *
 * 상태: generated / runtime-unverified (no live DB in authoring env)
 *   Management API(read-only) 조회는 실제 코드이나 라이브 DB 없이 실행 검증 불가.
 *
 * 원칙(§23): 이 스크립트는 **신규 0062 객체를 절대 참조하지 않는다**. 조회 대상은 기존 테이블뿐:
 *   orders · member_accounts · ai_generations(status queued|done|failed|picked) · credit_ledger · admin_actions_ledger.
 *   refund_state 는 orders 의 기존 컬럼(in_progress|pg_done|done).
 *
 * open money op 정의(전부 컷오버 전 0 이어야 함 — 하나라도 남으면 늦은 PAID·미회수·미환급 위험):
 *   1) pending_with_attempt   : orders.status='pending' ∧ (payment_id 또는 pg_tx_id 존재)
 *                               — 늦은 PAID / webhook 대기 / READY·VA(로컬은 pending) in-flight.
 *   2) refund_in_flight       : orders.refund_state ∈ (in_progress, pg_done) — 환불 진행/PG확정·로컬미반영.
 *   3) unreconciled_canceled  : orders.status='canceled' ∧ paid_at 존재 ∧ cancel_refund 원장 없음
 *                               — 취소 웹훅 선도착으로 크레딧 미회수(webhook 대기).
 *   4) queued_generations     : ai_generations.status='queued' — 소비된 크레딧이 callback 대기로 미확정.
 *   5) failed_unrefunded_gen  : ai_generations.status='failed' ∧ gen_consume 원장 있음 ∧ gen_refund 원장 없음
 *                               — 실패했는데 크레딧 미환급(0047 ledger 기준의 보수적 신호).
 *
 * 판정: 다섯 카테고리 합계가 0 이면 drain clean. 0 이 아니면 exit 1(컷오버 중단).
 *
 * 실행:
 *   node --env-file=.env.local scripts/refund/pre-0062-drain.mjs
 *   필요 env: BOSS_PAEGI_SUPABASE_ACCESS_TOKEN·BOSS_PAEGI_SUPABASE_PROJECT_REF(zshenv)
 *   → scripts/refund/pre-0062-drain.json 출력. open op>0 이면 exit 1.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalize, sha256Hex, HASH_VERSION } from "./hash-golden-vectors.mjs";
import { sbQuery, getManagementEnv, asInt } from "./paid-credit-allocation-manifest.mjs";

export const SCRIPT_VERSION = "pre-0062-drain/1";
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "pre-0062-drain.json");
const SAMPLE_LIMIT = 50;

// 각 카테고리: 오프렌딩 식별자 최대 SAMPLE_LIMIT 개 + window total. (신규 0062 객체 무참조)
const CATEGORIES = [
  {
    key: "pending_with_attempt",
    idExpr: "o.order_uuid::text",
    sql: `
select o.order_uuid::text as id, count(*) over() as total
from public.orders o
where o.status = 'pending'
  and (o.payment_id is not null or o.pg_tx_id is not null)
order by o.created_at
limit ${SAMPLE_LIMIT}`,
  },
  {
    key: "refund_in_flight",
    idExpr: "o.order_uuid::text",
    sql: `
select o.order_uuid::text as id, count(*) over() as total
from public.orders o
where o.refund_state in ('in_progress', 'pg_done')
order by o.updated_at
limit ${SAMPLE_LIMIT}`,
  },
  {
    key: "unreconciled_canceled_paid",
    idExpr: "o.order_uuid::text",
    sql: `
select o.order_uuid::text as id, count(*) over() as total
from public.orders o
where o.status = 'canceled'
  and o.paid_at is not null
  and not exists (
    select 1 from public.admin_actions_ledger al
    where al.order_uuid = o.order_uuid and al.action_type = 'cancel_refund'
  )
order by o.canceled_at
limit ${SAMPLE_LIMIT}`,
  },
  {
    key: "queued_generations",
    idExpr: "g.id::text",
    sql: `
select g.id::text as id, count(*) over() as total
from public.ai_generations g
where g.status = 'queued'
order by g.created_at
limit ${SAMPLE_LIMIT}`,
  },
  {
    key: "failed_unrefunded_generations",
    idExpr: "g.id::text",
    sql: `
select g.id::text as id, count(*) over() as total
from public.ai_generations g
where g.status = 'failed'
  and exists (
    select 1 from public.credit_ledger c
    where c.ref_gen_id = g.id and c.event_type = 'gen_consume'
  )
  and not exists (
    select 1 from public.credit_ledger c
    where c.ref_gen_id = g.id and c.event_type = 'gen_refund'
  )
order by g.created_at
limit ${SAMPLE_LIMIT}`,
  },
];

export async function runDrain(opts = {}) {
  const mgmt = opts.mgmt ?? getManagementEnv(opts.env);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const q = (sql) => sbQuery(sql, { mgmt, fetchImpl });
  const generatedAt = opts.now ? opts.now() : new Date().toISOString();
  const malformed = [];

  const results = await Promise.all(
    CATEGORIES.map(async (cat) => {
      const rows = await q(cat.sql);
      // total 은 window count(전체) — limit 로 잘려도 정확. 빈 결과면 0.
      const total = rows.length === 0 ? 0 : asInt(rows[0].total, `${cat.key}.total`, malformed) ?? 0;
      const sampleIds = rows.map((r) => r.id).filter((x) => typeof x === "string");
      return { key: cat.key, count: total, sample_ids: sampleIds };
    })
  );

  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  const openTotal = results.reduce((s, r) => s + r.count, 0);
  const ok = openTotal === 0 && malformed.length === 0;

  const projection = {
    hash_version: HASH_VERSION,
    counts: Object.fromEntries(results.map((r) => [r.key, r.count])),
    open_total: openTotal,
  };
  const manifestHash = sha256Hex(canonicalize(projection));

  const manifest = {
    header: {
      script_version: SCRIPT_VERSION,
      manifest_hash: manifestHash,
      hash_algorithm: "sha256",
      generated_at: generatedAt,
      source_env: { project_ref: mgmt.ref, api_host: mgmt.apiHost },
      references_only_existing_tables: true, // §23: 신규 0062 객체 무참조
      ok,
    },
    open_total: openTotal,
    categories: byKey,
    malformed,
  };
  return { ok, manifest, openTotal };
}

async function main() {
  let result;
  try {
    result = await runDrain();
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    process.exit(2);
  }
  const { ok, manifest, openTotal } = result;
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`=== pre-0062 drain (existing tables only) ===`);
  console.log(`  manifest_hash : ${manifest.header.manifest_hash}`);
  for (const cat of CATEGORIES) {
    const c = manifest.categories[cat.key];
    console.log(`  ${cat.key.padEnd(30)} ${String(c.count).padStart(4)}${c.count > 0 ? "  e.g. " + c.sample_ids.slice(0, 3).join(", ") : ""}`);
  }
  console.log(`  open_total    : ${openTotal}`);
  console.log(`  → ${OUT_PATH}`);
  if (!ok) {
    console.error(`[NO-GO] ${openTotal} open money op(s) remain — drain before applying 0062.`);
    process.exit(1);
  }
  console.log(`[OK] drained — no open money operations.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
