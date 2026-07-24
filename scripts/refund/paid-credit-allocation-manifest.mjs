#!/usr/bin/env node
/**
 * paid-credit-allocation-manifest.mjs — 레거시 유료 크레딧 잔액 재구성 증명(§24).
 *
 * 상태: generated / runtime-unverified (no live DB in authoring env)
 *   Management API(read-only) 조회 로직·증명 로직은 실제 코드이나, 라이브 DB 없이 실행 검증은 불가.
 *   canonical hash 유틸은 hash-golden-vectors.mjs(statically-verifiable)에서 재사용한다.
 *
 * 무엇을 증명하나(§24):
 *   0062 backfill 이 유료 구매 크레딧을 purchase lot 으로 재구성하기 전에, 각 유저의 **현재 gen_credits**가
 *   증빙만으로 유일하게 분해됨을 증명한다:
 *     주문별:  order_uuid/user · delivered_credits · proven_consumed · proven_refunded · remaining_paid_credits
 *              · evidence(source/hash) · confirmed_by
 *     유저별:  sum(proven remaining paid) + proven_free_remaining == gen_credits (proven_free_remaining ≥ 0)
 *   유일 증명 불가한 lot 이 하나라도 있으면 **exit nonzero**(균등/최신우선/전량free/전량consumed 추정 금지).
 *   실측(0058): 실 paid 0건 → purchase lot 0 → 모든 유저의 paid remaining=0, free=gen_credits(자명 증명).
 *   이 스크립트는 그 사실을 manifest+집계로 **증명**한다(§24 "현재 paid 잔액 0은 manifest+SQL로 증명").
 *
 * 증명 규칙(추정 없음):
 *   - purchase lot = credit_ledger.event_type='purchase' 행(권위 delivered 증빙; ref_order_uuid·delta=+credits).
 *   - orphan 검사(양방향): paid 주문에 purchase ledger 누락 0 · purchase ledger 에 주문 누락 0(누락 시 unproven).
 *   - refunded lot: order.status='canceled' ∧ cancel_refund 원장 존재 → proven_refunded=clawback_credits,
 *       remaining_paid=0, source='cancel_refund_ledger', confirmed_by=원장 admin.
 *   - active paid lot(status='paid', cancel_refund 없음):
 *       · 유저의 gen_consume 원장 0건 → 소비 없음 → remaining_paid=delivered(전액 증명),
 *         source='no_consume_full_remaining'.
 *       · 그 외(pooled consume 로 lot 귀속 불가) → remaining_paid=null·needs_manual=true → unproven.
 *   - 기타 status(pending/failed)는 delivered 되지 않아 lot 이 아니다(purchase 원장 부재).
 *
 * 실행:
 *   node --env-file=.env.local scripts/refund/paid-credit-allocation-manifest.mjs
 *   (또는 zshenv 의 BOSS_PAEGI_SUPABASE_* 가 셸에 있으면 --env-file 없이도 동작)
 *   → scripts/refund/paid-credit-allocation.json 출력. unproven>0 이면 exit 1.
 *
 * export: buildAllocationManifest / sbQuery / assertReadOnly / getManagementEnv — preflight 가 재사용.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalize, sha256Hex, HASH_VERSION } from "./hash-golden-vectors.mjs";

export const SCRIPT_VERSION = "paid-credit-allocation-manifest/1";
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "paid-credit-allocation.json");
const SUPABASE_API_HOST = "https://api.supabase.com";

// ── Management API (read-only) 전송 ───────────────────────────────────────────
// 프로덕션 변경 절대 금지 — 아래 assertReadOnly 가 SELECT/WITH 이외를 전부 차단한다(방어선).

const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|merge|refresh|reindex|vacuum|comment|set|reset|do|begin|commit|rollback|lock|listen|notify)\b/i;

/** SELECT/WITH 단일문만 허용. 세미콜론 체이닝·쓰기 키워드 존재 시 throw(읽기 전용 강제). */
export function assertReadOnly(sql) {
  const stripped = sql
    .replace(/--[^\n]*/g, " ") // 라인 주석 제거
    .replace(/\/\*[\s\S]*?\*\//g, " ") // 블록 주석 제거
    .trim();
  const oneStatement = stripped.replace(/;\s*$/, ""); // 단일 후행 세미콜론만 허용
  if (oneStatement.includes(";")) {
    throw new Error("read-only guard: multiple statements are not allowed");
  }
  if (!/^(with|select)\b/i.test(oneStatement)) {
    throw new Error("read-only guard: query must start with SELECT or WITH");
  }
  if (WRITE_KEYWORDS.test(oneStatement)) {
    throw new Error("read-only guard: write/DDL keyword detected in query");
  }
  return oneStatement;
}

export function getManagementEnv(env = process.env) {
  const token = env.BOSS_PAEGI_SUPABASE_ACCESS_TOKEN;
  const ref = env.BOSS_PAEGI_SUPABASE_PROJECT_REF;
  if (!token || !ref) {
    throw new Error(
      "missing env: BOSS_PAEGI_SUPABASE_ACCESS_TOKEN / BOSS_PAEGI_SUPABASE_PROJECT_REF (zshenv)"
    );
  }
  return { token, ref, apiHost: SUPABASE_API_HOST };
}

/**
 * Supabase Management API 로 **읽기 전용** SQL 실행.
 * POST /v1/projects/{ref}/database/query, Bearer <access_token>, body {query} → 행 배열.
 * 반환은 항상 배열(행). 비-2xx 는 throw. (0058 마이그도 동일 엔드포인트 사용.)
 */
export async function sbQuery(sql, opts = {}) {
  const { token, ref, apiHost } = opts.env ? getManagementEnv(opts.env) : opts.mgmt ?? getManagementEnv();
  const safeSql = assertReadOnly(sql);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${apiHost}/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: safeSql }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`management API ${res.status}: ${text.slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`management API: non-JSON response: ${text.slice(0, 200)}`);
  }
  // 엔드포인트는 행 배열을 반환한다. 방어적으로 배열이 아니면 오류로 취급.
  if (!Array.isArray(parsed)) {
    throw new Error(`management API: expected row array, got ${typeof parsed}`);
  }
  return parsed;
}

// ── safe JSON cast 헬퍼(§26) — cast 전 형식 검증, malformed 는 mismatch 로 수집 ──────────────
// preflight 도 동일 구현을 재사용(1 개념 1 구현). management API 는 이미 타입을 주지만 방어적 검증.
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function asInt(v, ctx, bag) {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  bag.push(`${ctx}: not an integer (${JSON.stringify(v)})`);
  return null;
}
export function asUuid(v, ctx, bag) {
  if (typeof v === "string" && UUID_RE.test(v)) return v.toLowerCase();
  bag.push(`${ctx}: not a uuid (${JSON.stringify(v)})`);
  return null;
}
export function asStr(v, ctx, bag) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  bag.push(`${ctx}: not a string (${JSON.stringify(v)})`);
  return null;
}
export function asTimestamp(v, ctx, bag) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return v;
  bag.push(`${ctx}: not a timestamp (${JSON.stringify(v)})`);
  return null;
}

// ── 조회 SQL(전부 SELECT/WITH — read-only) ────────────────────────────────────
const SQL_LOTS = `
with purchases as (
  select cl.ref_order_uuid as order_uuid, cl.user_id, cl.delta as delivered
  from public.credit_ledger cl
  where cl.event_type = 'purchase' and cl.ref_order_uuid is not null
),
refund_evidence as (
  select order_uuid,
         count(*) as n,
         min(admin_user_id::text) as admin_id,
         coalesce(sum(-credit_delta), 0) as clawback_sum
  from public.admin_actions_ledger
  where action_type = 'cancel_refund' and order_uuid is not null
  group by order_uuid
),
consume_counts as (
  select user_id,
         count(*) filter (where event_type = 'gen_consume') as consumes,
         count(*) filter (where event_type = 'gen_refund')  as refunds
  from public.credit_ledger
  group by user_id
)
select p.order_uuid, p.user_id, p.delivered,
       o.status, o.clawback_credits, o.credits as order_credits, o.paid_at, o.canceled_at,
       coalesce(re.n, 0) as refund_ledger_count, re.admin_id,
       coalesce(re.clawback_sum, 0) as clawback_sum,
       coalesce(cc.consumes, 0) as user_consumes
from purchases p
left join public.orders o          on o.order_uuid = p.order_uuid
left join refund_evidence re       on re.order_uuid = p.order_uuid
left join consume_counts cc        on cc.user_id   = p.user_id
order by p.user_id, p.order_uuid`;

const SQL_ORPHAN_PAID_NO_LEDGER = `
select o.order_uuid, o.user_id, o.credits
from public.orders o
where o.paid_at is not null
  and not exists (
    select 1 from public.credit_ledger cl
    where cl.event_type = 'purchase' and cl.ref_order_uuid = o.order_uuid
  )`;

const SQL_ORPHAN_LEDGER_NO_ORDER = `
select cl.ref_order_uuid as order_uuid, cl.user_id
from public.credit_ledger cl
where cl.event_type = 'purchase' and cl.ref_order_uuid is not null
  and not exists (
    select 1 from public.orders o where o.order_uuid = cl.ref_order_uuid
  )`;

const SQL_USER_CREDITS = `select ma.user_id, ma.gen_credits from public.member_accounts ma`;

// ── 증명 로직 ──────────────────────────────────────────────────────────────────

function proveLot(row, malformed) {
  const orderUuid = asUuid(row.order_uuid, "lot.order_uuid", malformed);
  const userId = asUuid(row.user_id, "lot.user_id", malformed);
  const delivered = asInt(row.delivered, "lot.delivered", malformed);
  const refundLedgerCount = asInt(row.refund_ledger_count, "lot.refund_ledger_count", malformed) ?? 0;
  const clawback = asInt(row.clawback_credits, "lot.clawback_credits", malformed) ?? 0;
  const clawbackSum = asInt(row.clawback_sum, "lot.clawback_sum", malformed) ?? 0;
  const userConsumes = asInt(row.user_consumes, "lot.user_consumes", malformed) ?? 0;
  const status = typeof row.status === "string" ? row.status : null;

  const base = {
    order_uuid: orderUuid,
    user_id: userId,
    delivered_credits: delivered,
    status,
  };

  // orphan(주문 없음) — Q2 가 별도로도 잡지만 여기서도 unproven 처리.
  if (status === null) {
    return { ...base, remaining_paid_credits: null, proven: false, reason: "order_missing_for_purchase_ledger" };
  }
  if (orderUuid === null || userId === null || delivered === null) {
    return { ...base, remaining_paid_credits: null, proven: false, reason: "malformed_lot_row" };
  }

  // refunded lot: canceled + cancel_refund 원장 → remaining 0(외부 환불 확정, 크레딧 clawback).
  if (status === "canceled" && refundLedgerCount > 0) {
    const evidence = {
      order_uuid: orderUuid,
      user_id: userId,
      delivered_credits: delivered,
      proven_refunded: clawback,
      remaining_paid_credits: 0,
      source: "cancel_refund_ledger",
    };
    return {
      ...base,
      proven_consumed: Math.max(0, delivered - clawback),
      proven_refunded: clawback,
      remaining_paid_credits: 0,
      evidence_source: "cancel_refund_ledger",
      evidence_hash: sha256Hex(canonicalize(evidence)),
      confirmed_by: row.admin_id ? `admin:${row.admin_id}` : "admin:unknown",
      proven: true,
      // 참고: clawback_sum 은 원장 delta 합(교차확인용).
      note: clawbackSum === clawback ? undefined : `clawback_ledger_sum_mismatch(${clawbackSum})`,
    };
  }

  // active paid lot, 소비 0 → 전액 잔존(증명).
  if (status === "paid" && refundLedgerCount === 0 && userConsumes === 0) {
    const evidence = {
      order_uuid: orderUuid,
      user_id: userId,
      delivered_credits: delivered,
      proven_refunded: 0,
      remaining_paid_credits: delivered,
      source: "no_consume_full_remaining",
    };
    return {
      ...base,
      proven_consumed: 0,
      proven_refunded: 0,
      remaining_paid_credits: delivered,
      evidence_source: "no_consume_full_remaining",
      evidence_hash: sha256Hex(canonicalize(evidence)),
      confirmed_by: "system:allocation-manifest",
      proven: true,
    };
  }

  // 그 외 — pooled consume 로 lot 귀속 불가. 추정 금지 → unproven.
  return {
    ...base,
    proven_consumed: null,
    proven_refunded: refundLedgerCount > 0 ? clawback : 0,
    remaining_paid_credits: null,
    evidence_source: null,
    confirmed_by: null,
    proven: false,
    reason:
      status === "paid"
        ? "pooled_consume_unattributable"
        : `unexpected_status_for_purchase_lot(${status})`,
  };
}

/**
 * 전체 allocation manifest 를 조회·증명·집계해 반환. 파일은 쓰지 않는다(main 이 쓴다).
 * 반환: { ok, manifest, unprovenCount } — ok=false 면 호출측이 exit nonzero.
 */
export async function buildAllocationManifest(opts = {}) {
  const mgmt = opts.mgmt ?? getManagementEnv(opts.env);
  const q = (sql) => sbQuery(sql, { mgmt, fetchImpl: opts.fetchImpl });
  const generatedAt = opts.now ? opts.now() : new Date().toISOString();
  const malformed = [];

  const [lotRows, orphanPaid, orphanLedger, userRows] = await Promise.all([
    q(SQL_LOTS),
    q(SQL_ORPHAN_PAID_NO_LEDGER),
    q(SQL_ORPHAN_LEDGER_NO_ORDER),
    q(SQL_USER_CREDITS),
  ]);

  const lots = lotRows.map((r) => proveLot(r, malformed));

  // 유저별 gen_credits.
  const creditsByUser = new Map();
  for (const r of userRows) {
    const uid = asUuid(r.user_id, "member.user_id", malformed);
    const gc = asInt(r.gen_credits, "member.gen_credits", malformed);
    if (uid !== null && gc !== null) creditsByUser.set(uid, gc);
  }

  // 유저별 재구성(lot 있는 유저만) — Σ remaining_paid + free = gen_credits, free ≥ 0.
  const lotsByUser = new Map();
  for (const lot of lots) {
    if (!lot.user_id) continue;
    if (!lotsByUser.has(lot.user_id)) lotsByUser.set(lot.user_id, []);
    lotsByUser.get(lot.user_id).push(lot);
  }
  const users = [];
  for (const [uid, uLots] of lotsByUser) {
    const allProven = uLots.every((l) => l.proven);
    const remainingPaid = allProven
      ? uLots.reduce((s, l) => s + (l.remaining_paid_credits ?? 0), 0)
      : null;
    const genCredits = creditsByUser.has(uid) ? creditsByUser.get(uid) : null;
    const freeRemaining =
      allProven && genCredits !== null ? genCredits - remainingPaid : null;
    const proven =
      allProven &&
      genCredits !== null &&
      freeRemaining !== null &&
      freeRemaining >= 0;
    users.push({
      user_id: uid,
      gen_credits: genCredits,
      lot_count: uLots.length,
      proven_remaining_paid: remainingPaid,
      proven_free_remaining: freeRemaining,
      proven,
      reason: proven
        ? undefined
        : genCredits === null
          ? "member_account_missing"
          : !allProven
            ? "unprovable_lot"
            : freeRemaining !== null && freeRemaining < 0
              ? "negative_free_remaining_contradiction"
              : "unknown",
    });
  }

  // 집계.
  const provenLots = lots.filter((l) => l.proven).length;
  const unprovenLots = lots.filter((l) => !l.proven);
  const unprovenUsers = users.filter((u) => !u.proven);
  const globalRemainingPaid = lots.every((l) => l.proven)
    ? lots.reduce((s, l) => s + (l.remaining_paid_credits ?? 0), 0)
    : null;

  const orphans = {
    paid_orders_without_purchase_ledger: orphanPaid.map((r) => ({
      order_uuid: r.order_uuid,
      user_id: r.user_id,
      credits: r.credits,
    })),
    purchase_ledger_without_order: orphanLedger.map((r) => ({
      order_uuid: r.order_uuid,
      user_id: r.user_id,
    })),
  };
  const orphanCount =
    orphans.paid_orders_without_purchase_ledger.length +
    orphans.purchase_ledger_without_order.length;

  const rowCount = lots.length;
  const ok =
    unprovenLots.length === 0 &&
    unprovenUsers.length === 0 &&
    orphanCount === 0 &&
    malformed.length === 0 &&
    globalRemainingPaid !== null;

  // manifest_hash — detail 의 canonical projection 에 대한 SHA-256(§25: empty 도 안정 hash).
  const projection = {
    hash_version: HASH_VERSION,
    row_count: rowCount,
    lots: lots
      .map((l) => ({
        order_uuid: l.order_uuid,
        user_id: l.user_id,
        delivered: l.delivered_credits,
        remaining: l.remaining_paid_credits,
        source: l.evidence_source ?? null,
        proven: l.proven,
      }))
      .sort((a, b) => String(a.order_uuid).localeCompare(String(b.order_uuid))),
    global_remaining_paid: globalRemainingPaid,
  };
  const manifestHash = sha256Hex(canonicalize(toCanonicalSafe(projection)));

  const manifest = {
    header: {
      script_version: SCRIPT_VERSION,
      manifest_hash: manifestHash,
      hash_algorithm: "sha256",
      row_count: rowCount, // detail(lots) 행 수 — G/검증이 detail count 와 대조(§25)
      generated_at: generatedAt,
      source_env: { project_ref: mgmt.ref, api_host: mgmt.apiHost },
      ok,
    },
    summary: {
      lot_count: rowCount,
      proven_lots: provenLots,
      unproven_lots: unprovenLots.length,
      user_with_lots: users.length,
      unproven_users: unprovenUsers.length,
      orphan_count: orphanCount,
      malformed_count: malformed.length,
      global_remaining_paid: globalRemainingPaid,
    },
    lots,
    users,
    orphans,
    malformed,
  };

  return { ok, manifest, unprovenCount: unprovenLots.length + unprovenUsers.length + orphanCount };
}

/** projection 을 canonicalize 규약이 받아들이는 형태(null 허용·number/string)로 안전 변환. */
function toCanonicalSafe(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (v === undefined ? null : v))
  );
}

async function main() {
  let result;
  try {
    result = await buildAllocationManifest();
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    process.exit(2);
  }
  const { ok, manifest, unprovenCount } = result;
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");
  const s = manifest.summary;
  console.log(`=== paid-credit-allocation manifest ===`);
  console.log(`  manifest_hash : ${manifest.header.manifest_hash}`);
  console.log(`  lots          : ${s.lot_count} (proven ${s.proven_lots} / unproven ${s.unproven_lots})`);
  console.log(`  users w/ lots : ${s.user_with_lots} (unproven ${s.unproven_users})`);
  console.log(`  orphans       : ${s.orphan_count} · malformed: ${s.malformed_count}`);
  console.log(`  global paid remaining: ${s.global_remaining_paid}`);
  console.log(`  → ${OUT_PATH}`);
  if (!ok) {
    console.error(`[NO-GO] allocation not uniquely proven (unproven/orphan/malformed=${unprovenCount}).`);
    process.exit(1);
  }
  console.log(`[OK] every lot & user allocation uniquely proven.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
