// eslint-rule-selftest.mjs — no-direct-financial-write 룰 자기검증(RuleTester, §37).
// 실행: node scripts/refund/eslint-rule-selftest.mjs  (통과 시 "[OK] rule self-test passed")
// 검증: 금융 테이블 직접 DML 탐지 · §13 operational 컬럼 UPDATE 허용(allowedUpdateColumns) ·
//       구 소비/환급 RPC deny · admin_cancel_order 는 deny 아님(0062 재정의) · logCreditEvent deny ·
//       rpcAllowlist 모드 · 동적 rpc 이름.
import { RuleTester } from "eslint";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rule = require("../../eslint-rules/no-direct-financial-write.js");

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

tester.run("no-direct-financial-write", rule, {
  valid: [
    // 비금융 테이블 write
    `admin.from("scores").update({ review_status: "clear" }).eq("id", id);`,
    // 금융 테이블 read
    `admin.from("orders").select("order_uuid, refunded_credits").eq("user_id", u);`,
    // 정상 신규 RPC
    `admin.rpc("mark_paid_and_grant", { p_order_uuid: o, p_pg_tx_id: t, p_price: 1000, p_raw: r, p_paid_at: at, p_receipt_url: null });`,
    // admin_cancel_order 는 0062 재정의 정식 RPC — deny 아님
    `admin.rpc("admin_cancel_order", { p_admin: a, p_order_uuid: o, p_clawback: false, p_reason: r, p_pg_done: false });`,
    // §13 operational 컬럼 한정 UPDATE 허용
    `admin.from("orders").update({ pg_status: s, raw: r }).eq("order_uuid", o);`,
    `admin.from("orders").update({ error_message: m }).eq("order_uuid", o);`,
    `admin.from("member_accounts").update({ email: e }).eq("user_id", u);`,
    `admin.from("ai_generations").update({ status: "failed", fail_reason: "no_face" }).eq("id", g);`,
    `admin.from("ai_generations").update({ fal_request_ids: ids }).eq("id", g);`,
    `admin.from("ai_generations").update({ status: "picked", picked_doll_id: d, picked_index: i }).eq("id", g);`,
    // 동적 from — 정적 판정 불가는 통과(일반 모드)
    `admin.from(tableName).update({ x: 1 });`,
  ],
  invalid: [
    // 금융 테이블 직접 DML
    { code: `admin.from("credit_lots").insert({ user_id: u, qty: 1 });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("refund_requests").update({ state: "completed" });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("order_refund_attempts").delete().eq("id", a);`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("credit_ledger").insert({ delta: 1 });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("admin_actions_ledger").insert({ action_type: "cs_adjust" });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("reconciliation_issues").update({ state: "resolved" });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("payment_cancellation_events").upsert({ cancellation_id: c });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("credit_refund_shortfalls").update({ state: "resolved" });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("legacy_refund_backfill_evidence").update({ classification: c });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("cancellation_resolution_batches").insert({ order_uuid: o });`, errors: [{ messageId: "directWrite" }] },
    // 금융/금융인접 컬럼 UPDATE — allowlist 밖
    { code: `admin.from("orders").update({ status: "canceled", canceled_at: t });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("orders").update({ pg_status: s, refunded_amount: 0 });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("member_accounts").update({ gen_credits: 0 });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("ai_generations").update({ credit_lot_id: l });`, errors: [{ messageId: "directWrite" }] },
    // 비리터럴 payload — 판정 불가 → 불허
    { code: `admin.from("orders").update(payload);`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("orders").update({ ...patch });`, errors: [{ messageId: "directWrite" }] },
    // insert 는 operational allowlist 대상 아님(§13 — INSERT 는 RPC 만)
    { code: `admin.from("orders").insert({ pg_status: s });`, errors: [{ messageId: "directWrite" }] },
    { code: `admin.from("ai_generations").insert({ owner_id: u, status: "queued", role: r });`, errors: [{ messageId: "directWrite" }] },
    // 구 금융 RPC deny(0063 fail-closed stub 대상)
    { code: `admin.rpc("consume_gen_credit", { p_user: u });`, errors: [{ messageId: "deniedRpc" }] },
    { code: `admin.rpc("refund_gen_credit", { p_user: u });`, errors: [{ messageId: "deniedRpc" }] },
    // logCreditEvent deny
    { code: `await logCreditEvent(admin, { userId: u });`, errors: [{ messageId: "deniedCall" }] },
    // allowlist 모드 — 목록 밖 rpc·동적 rpc
    {
      code: `admin.rpc("get_admin_funnel", {});`,
      options: [{ rpcAllowlist: ["mark_paid_and_grant"] }],
      errors: [{ messageId: "notAllowlisted" }],
    },
    {
      code: `admin.rpc(name, {});`,
      options: [{ rpcAllowlist: ["mark_paid_and_grant"] }],
      errors: [{ messageId: "dynamicRpc" }],
    },
  ],
});

console.log("[OK] rule self-test passed");
