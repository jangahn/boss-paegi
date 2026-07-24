#!/usr/bin/env node
/**
 * preflight-portone-legacy.mjs — 0062 이전 PortOne·DB 레거시 preflight(§12.3·§23·§24·§25·§27).
 *
 * 상태: generated / runtime-unverified (no live DB in authoring env)
 *   Management API(read-only) 조회·PortOne 단건 GET·증명 로직은 실제 코드이나, 라이브 DB/PG 없이
 *   실행 검증은 불가. read-only 전송·PortOne GET 은 lib/portone.ts 방식(REST)과 동일.
 *   canonical hash 와 allocation 증명은 각각 hash-golden-vectors.mjs / paid-credit-allocation-manifest.mjs
 *   의 **동일 구현**을 재사용한다(1 개념 1 구현).
 *
 * 검사 항목:
 *   1) 레거시 status='canceled' 주문 manifest universe(§12.3):
 *        canceled+paid_at → pg_refunded_full · canceled+unpaid → local_only_canceled.
 *        양방향 exact·orphan 검사(모든 canceled 주문이 정확히 한 버킷). 불명확 1건이라도 전체 중단(§44-6).
 *   2) cancellation ID 중복 0(§23): canceled+paid PortOne 주문을 fresh GET → cancellations[].id 수집·유일성.
 *        각 건이 실제 CANCELLED/PARTIAL_CANCELLED 로 확정되는지도 확인(로컬 canceled 만 믿지 않음).
 *   3) PortOne fresh GET 분류(§23·§27): 로컬 pending(=VA/READY 포함) 주문의 실제 상태를
 *        PAID/CANCELLED/PARTIAL_CANCELLED/FAILED/READY/PENDING/VIRTUAL_ACCOUNT 로 분류(비공식 PAY_PENDING 금지).
 *        늦은 PAID·PARTIAL_CANCELLED·진행형(READY/PENDING/VA)·NOT_FOUND 은 운영자 결정 필요 → exit nonzero.
 *   4) paid_credit_allocation 증명(§24): buildAllocationManifest 임베드. 유일 증명 불가 → exit nonzero.
 *   5) manifest header(hash·row count·generated at·env·script version, empty 지원 §25)·SHA-256 서명·safe JSON(§26).
 *
 * PortOne 상태 정규화(§23·§27): PAY_PENDING→PENDING · VIRTUAL_ACCOUNT_ISSUED→VIRTUAL_ACCOUNT.
 *   알려지지 않은 상태는 불명확 → 중단(임의 failed/canceled 금지).
 *
 * 실행:
 *   node --env-file=.env.local scripts/refund/preflight-portone-legacy.mjs
 *   필요 env: BOSS_PAEGI_SUPABASE_ACCESS_TOKEN·BOSS_PAEGI_SUPABASE_PROJECT_REF(zshenv) · PORTONE_V2_API_SECRET(.env.local)
 *   → scripts/refund/preflight-portone-legacy.json 출력. 불명확/미해결/미증명 1건이라도 exit 1.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalize, sha256Hex, HASH_VERSION } from "./hash-golden-vectors.mjs";
import {
  sbQuery,
  getManagementEnv,
  buildAllocationManifest,
  asInt,
  asUuid,
  asStr,
  asTimestamp,
} from "./paid-credit-allocation-manifest.mjs";

export const SCRIPT_VERSION = "preflight-portone-legacy/1";
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "preflight-portone-legacy.json");
const PORTONE_API_URL = "https://api.portone.io";

// PortOne 원시 상태 → 내부 정규화 버킷(§23 허용 집합). 비공식 PAY_PENDING 은 PENDING 으로.
const PORTONE_STATUS_MAP = {
  PAID: "PAID",
  CANCELLED: "CANCELLED",
  PARTIAL_CANCELLED: "PARTIAL_CANCELLED",
  FAILED: "FAILED",
  READY: "READY",
  PENDING: "PENDING",
  PAY_PENDING: "PENDING", // 비공식 명칭 정규화
  VIRTUAL_ACCOUNT_ISSUED: "VIRTUAL_ACCOUNT",
};
const NORMALIZED_STATUSES = new Set(Object.values(PORTONE_STATUS_MAP));

// ── PortOne 단건 GET(REST — lib/portone.ts 방식) ─────────────────────────────
/** GET /payments/{paymentId}. 반환: {ok, status(normalized), cancellations[], raw} 또는 {ok:false, kind}. */
async function getPortonePayment(paymentId, secret, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${PORTONE_API_URL}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `PortOne ${secret}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (res.status === 404) return { ok: false, kind: "NOT_FOUND" };
    if (!res.ok) return { ok: false, kind: "http_error", status: res.status };
    const payment = await res.json();
    const raw = payment?.status;
    const status = PORTONE_STATUS_MAP[raw];
    if (!status || !NORMALIZED_STATUSES.has(status)) {
      return { ok: false, kind: "unknown_status", raw };
    }
    const cancellations = Array.isArray(payment?.cancellations) ? payment.cancellations : [];
    return { ok: true, status, cancellations, rawStatus: raw };
  } catch {
    return { ok: false, kind: "unreachable" };
  }
}

// ── 조회 SQL(전부 SELECT — read-only) ─────────────────────────────────────────
const SQL_LEGACY_CANCELED = `
select o.order_uuid, o.user_id, o.provider, o.payment_id, o.status,
       o.paid_at, o.canceled_at, o.clawback_credits, o.credits, o.refund_state,
       exists (
         select 1 from public.admin_actions_ledger al
         where al.order_uuid = o.order_uuid and al.action_type = 'cancel_refund'
       ) as has_cancel_refund_ledger
from public.orders o
where o.status = 'canceled'
order by o.order_uuid`;

const SQL_PORTONE_PENDING = `
select o.order_uuid, o.user_id, o.payment_id, o.amount, o.is_test, o.created_at
from public.orders o
where o.status = 'pending' and o.provider = 'portone' and o.payment_id is not null
order by o.created_at`;

// ── 레거시 canceled 분류(§12.3) ────────────────────────────────────────────────
function classifyCanceled(row, malformed) {
  const orderUuid = asUuid(row.order_uuid, "canceled.order_uuid", malformed);
  const userId = asUuid(row.user_id, "canceled.user_id", malformed);
  const paidAt = asTimestamp(row.paid_at, "canceled.paid_at", malformed);
  const provider = asStr(row.provider, "canceled.provider", malformed);
  const paymentId = asStr(row.payment_id, "canceled.payment_id", malformed);
  const status = asStr(row.status, "canceled.status", malformed);
  const hasLedger = row.has_cancel_refund_ledger === true;

  if (status !== "canceled") {
    return { order_uuid: orderUuid, bucket: "unclear", reason: `unexpected_status(${status})` };
  }
  // 정확히 한 버킷 — paid_at 유/무로 배타적 분할(§12.3 양방향 exact).
  const bucket = paidAt ? "pg_refunded_full" : "local_only_canceled";
  return {
    order_uuid: orderUuid,
    user_id: userId,
    provider,
    payment_id: paymentId,
    paid_at: paidAt,
    has_cancel_refund_ledger: hasLedger,
    bucket,
    // pg_refunded_full 은 PortOne 확정(CANCELLED/PARTIAL_CANCELLED)이 필요 → step2 에서 검증·불명확 표시.
    needs_portone_confirm: bucket === "pg_refunded_full" && provider === "portone" && !!paymentId,
  };
}

// ── 메인 오케스트레이션 ─────────────────────────────────────────────────────────
export async function runPreflight(opts = {}) {
  const mgmt = opts.mgmt ?? getManagementEnv(opts.env);
  const portoneSecret = (opts.env ?? process.env).PORTONE_V2_API_SECRET;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const q = (sql) => sbQuery(sql, { mgmt, fetchImpl });
  const generatedAt = opts.now ? opts.now() : new Date().toISOString();
  const malformed = [];
  const blockers = [];

  // 1) 레거시 canceled universe.
  const canceledRows = await q(SQL_LEGACY_CANCELED);
  const classified = canceledRows.map((r) => classifyCanceled(r, malformed));
  const buckets = { pg_refunded_full: [], local_only_canceled: [], unclear: [] };
  for (const c of classified) buckets[c.bucket]?.push(c);
  // orphan/exact 검사: 모든 canceled 주문이 정확히 한 버킷(unclear 는 blocker).
  const partitionOk = buckets.pg_refunded_full.length + buckets.local_only_canceled.length === classified.length;
  if (!partitionOk || buckets.unclear.length > 0) {
    blockers.push(`legacy_canceled_unclear: ${buckets.unclear.length} unclear of ${classified.length}`);
  }

  // 2) PortOne 확정 + cancellation ID 중복 검사(canceled+paid portone).
  const needPortone = [
    ...buckets.pg_refunded_full.filter((c) => c.needs_portone_confirm),
  ];
  const cancellationIds = new Map(); // id → [order_uuid...]
  const portoneConfirm = [];
  let portoneUnavailable = false;

  // 3) 로컬 pending(=VA/READY 포함) 주문 fresh GET 분류.
  const pendingRows = await q(SQL_PORTONE_PENDING);
  const pendingClassified = [];

  const anyPortoneNeeded = needPortone.length > 0 || pendingRows.length > 0;
  if (anyPortoneNeeded && !portoneSecret) {
    portoneUnavailable = true;
    blockers.push("portone_unconfigured: PORTONE_V2_API_SECRET missing but PortOne verification required");
  }

  if (portoneSecret && !portoneUnavailable) {
    // 2) canceled+paid 확정 + cancellation id 수집(직렬 — reconcile 관용구).
    for (const c of needPortone) {
      const got = await getPortonePayment(c.payment_id, portoneSecret, fetchImpl);
      if (!got.ok) {
        blockers.push(`portone_confirm_failed[${c.order_uuid}]: ${got.kind}${got.raw ? "(" + got.raw + ")" : ""}`);
        portoneConfirm.push({ order_uuid: c.order_uuid, status: null, error: got.kind });
        continue;
      }
      if (got.status !== "CANCELLED" && got.status !== "PARTIAL_CANCELLED") {
        // 로컬은 canceled 인데 PortOne 은 아직 취소 아님 → 불명확(중단).
        blockers.push(`portone_not_canceled[${c.order_uuid}]: portone=${got.status}`);
      }
      for (const cx of got.cancellations) {
        const cid = asStr(cx?.id, "cancellation.id", malformed);
        if (!cid) continue;
        if (!cancellationIds.has(cid)) cancellationIds.set(cid, []);
        cancellationIds.get(cid).push(c.order_uuid);
      }
      portoneConfirm.push({
        order_uuid: c.order_uuid,
        status: got.status,
        cancellation_ids: got.cancellations.map((x) => x?.id).filter(Boolean),
      });
    }

    // 3) pending fresh GET 분류.
    for (const r of pendingRows) {
      const orderUuid = asUuid(r.order_uuid, "pending.order_uuid", malformed);
      const paymentId = asStr(r.payment_id, "pending.payment_id", malformed);
      if (!paymentId) {
        pendingClassified.push({ order_uuid: orderUuid, portone_status: null, resolution: "unclear" });
        blockers.push(`pending_no_payment_id[${orderUuid}]`);
        continue;
      }
      const got = await getPortonePayment(paymentId, portoneSecret, fetchImpl);
      if (!got.ok) {
        // NOT_FOUND / unreachable / unknown_status → 운영자 결정.
        pendingClassified.push({ order_uuid: orderUuid, portone_status: got.kind, resolution: "operator_required" });
        blockers.push(`pending_unresolved[${orderUuid}]: ${got.kind}${got.raw ? "(" + got.raw + ")" : ""}`);
        continue;
      }
      // 종단(CANCELLED/FAILED)만 무해. 그 외(PAID 늦은지급/PARTIAL/진행형)는 컷오버 전 반드시 처리.
      const terminalOk = got.status === "CANCELLED" || got.status === "FAILED";
      const resolution = terminalOk ? "terminal" : "operator_required";
      pendingClassified.push({ order_uuid: orderUuid, portone_status: got.status, resolution });
      if (!terminalOk) {
        blockers.push(`pending_inflight[${orderUuid}]: portone=${got.status}`);
      }
    }
  }

  // cancellation ID 중복.
  const duplicateCancellationIds = [...cancellationIds.entries()]
    .filter(([, orders]) => orders.length > 1)
    .map(([id, orders]) => ({ cancellation_id: id, orders }));
  if (duplicateCancellationIds.length > 0) {
    blockers.push(`duplicate_cancellation_ids: ${duplicateCancellationIds.length}`);
  }

  // 4) allocation 증명(임베드).
  let allocation;
  try {
    const res = await buildAllocationManifest({ mgmt, fetchImpl, now: () => generatedAt });
    allocation = res.manifest;
    if (!res.ok) blockers.push(`allocation_not_proven: unproven/orphan/malformed=${res.unprovenCount}`);
  } catch (e) {
    allocation = { error: e.message };
    blockers.push(`allocation_query_failed: ${e.message}`);
  }

  if (malformed.length > 0) blockers.push(`malformed_rows: ${malformed.length}`);

  const ok = blockers.length === 0;
  const rowCount = classified.length; // universe = 레거시 canceled 건수(§25: empty 지원)

  // manifest_hash — universe detail 의 canonical projection(정렬·타입 안전).
  const projection = {
    hash_version: HASH_VERSION,
    row_count: rowCount,
    canceled: buckets_projection(buckets),
    pending: pendingClassified
      .map((p) => ({ order_uuid: p.order_uuid ?? null, portone_status: p.portone_status ?? null, resolution: p.resolution }))
      .sort((a, b) => String(a.order_uuid).localeCompare(String(b.order_uuid))),
    allocation_hash: allocation?.header?.manifest_hash ?? null,
  };
  const manifestHash = sha256Hex(canonicalize(sanitize(projection)));

  const manifest = {
    header: {
      script_version: SCRIPT_VERSION,
      manifest_hash: manifestHash,
      hash_algorithm: "sha256",
      row_count: rowCount,
      generated_at: generatedAt,
      source_env: { project_ref: mgmt.ref, api_host: mgmt.apiHost, portone_configured: !!portoneSecret },
      ok,
    },
    summary: {
      legacy_canceled_total: classified.length,
      pg_refunded_full: buckets.pg_refunded_full.length,
      local_only_canceled: buckets.local_only_canceled.length,
      unclear: buckets.unclear.length,
      portone_pending_checked: pendingClassified.length,
      pending_inflight_or_operator: pendingClassified.filter((p) => p.resolution === "operator_required").length,
      duplicate_cancellation_ids: duplicateCancellationIds.length,
      allocation_ok: allocation?.header?.ok ?? null,
      malformed_count: malformed.length,
      blocker_count: blockers.length,
    },
    legacy_canceled: buckets,
    portone_confirm: portoneConfirm,
    portone_pending: pendingClassified,
    duplicate_cancellation_ids: duplicateCancellationIds,
    allocation_header: allocation?.header ?? null,
    allocation_summary: allocation?.summary ?? null,
    blockers,
    malformed,
  };
  return { ok, manifest };
}

function buckets_projection(buckets) {
  const proj = (arr) =>
    arr
      .map((c) => ({ order_uuid: c.order_uuid ?? null, bucket: c.bucket }))
      .sort((a, b) => String(a.order_uuid).localeCompare(String(b.order_uuid)));
  return {
    pg_refunded_full: proj(buckets.pg_refunded_full),
    local_only_canceled: proj(buckets.local_only_canceled),
    unclear: proj(buckets.unclear),
  };
}

function sanitize(obj) {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (v === undefined ? null : v)));
}

async function main() {
  let result;
  try {
    result = await runPreflight();
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    process.exit(2);
  }
  const { ok, manifest } = result;
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");
  const s = manifest.summary;
  console.log(`=== preflight-portone-legacy ===`);
  console.log(`  manifest_hash : ${manifest.header.manifest_hash}`);
  console.log(`  canceled      : total ${s.legacy_canceled_total} (pg_refunded_full ${s.pg_refunded_full} / local_only ${s.local_only_canceled} / unclear ${s.unclear})`);
  console.log(`  pending GET   : ${s.portone_pending_checked} (operator_required ${s.pending_inflight_or_operator})`);
  console.log(`  dup cancel id : ${s.duplicate_cancellation_ids}`);
  console.log(`  allocation ok : ${s.allocation_ok} · malformed: ${s.malformed_count}`);
  console.log(`  → ${OUT_PATH}`);
  if (!ok) {
    console.error(`[NO-GO] ${manifest.blockers.length} blocker(s):`);
    for (const b of manifest.blockers) console.error(`    - ${b}`);
    process.exit(1);
  }
  console.log(`[OK] legacy PortOne/DB preflight clean — safe to proceed.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
