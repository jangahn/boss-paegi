/**
 * no-direct-financial-write.js — 금융 테이블 직접 쓰기·구 금융 RPC·logCreditEvent 를 AST 로 금지(§37).
 *
 * 상태: generated / statically-verifiable
 *   brittle regex 대신 ESLint(=@typescript-eslint/parser) AST 로 판정한다. 이 파일은 규칙 정의만
 *   담으며, ESLint 실행 시 위반을 error 로 보고해 CI 를 실패시킨다(§37 "CI 위반 실패").
 *
 * 무엇을 막나:
 *   1) 지정 금융 테이블에 대한 .insert / .update / .upsert / .delete
 *        예) admin.from("orders").update({...})  ·  .from("credit_ledger").insert(...)
 *        멀티라인 체인 대응(AST 는 개행 무관). from() 인자가 리터럴이 아니면 정적 판정 불가 → 무시.
 *   2) 구 금융 RPC 직접 호출(항상 금지): consume_gen_credit · refund_gen_credit.
 *      (admin_cancel_order 는 0062 재정의 — 무결제 로컬 취소 전용 정식 RPC 라 deny 대상 아님.)
 *   3) logCreditEvent(...) 호출(앱 레벨 원장 기록 — 신규 RPC 내부 이관, 앱 호출 제거).
 *   4) (옵션) rpc() exact allowlist — options.rpcAllowlist 를 배열로 주면 그 목록 밖의 모든 rpc()
 *        이름을 금지(머니패스 파일 스코프용). 미지정(null)이면 deny-list 모드만(2번)로 동작 →
 *        get_admin_funnel 등 정상 read RPC 오탐 방지. 문자열 리터럴 아닌 동적 rpc 이름은 항상 보고
 *        (정적 검증 불가 = 금융 안전상 불허).
 *
 * 옵션(전부 선택):
 *   {
 *     financialTables?: string[]   // 기본 아래 DEFAULT_FINANCIAL_TABLES
 *     writeMethods?: string[]      // 기본 ["insert","update","upsert","delete"]
 *     deniedRpcs?: string[]        // 기본 아래 DEFAULT_DENIED_RPCS(항상 금지)
 *     rpcAllowlist?: string[]|null // 기본 null(deny-list 모드). 배열이면 exact-allowlist 모드
 *     deniedCalls?: string[]       // 기본 ["logCreditEvent"] — 금지 식별자 호출
 *   }
 *
 * 플랫 config 배선 예(eslint.config.mjs):
 *   import rule from "./eslint-rules/no-direct-financial-write.js";
 *   const bossPaegi = { rules: { "no-direct-financial-write": rule } };
 *   export default [
 *     // ...기존 config...
 *     {
 *       files: [ <앱/라이브러리 ts·tsx globs — 예: app 하위 .ts/.tsx, lib 하위 .ts> ],
 *       plugins: { "boss-paegi": bossPaegi },
 *       rules: { "boss-paegi/no-direct-financial-write": "error" },
 *     },
 *     // 머니패스 라우트만 exact-allowlist(신규 정의자 RPC 만 허용):
 *     {
 *       files: [ <머니패스 route globs — 예: app/api/admin, app/api/pay, app/api/ops 하위> ],
 *       plugins: { "boss-paegi": bossPaegi },
 *       rules: { "boss-paegi/no-direct-financial-write":
 *         ["error", { rpcAllowlist: ["create_pending_order", "mark_paid_and_grant", "create_generation_and_consume",
 *           "mark_generation_failed_and_refund", "admin_refund_request", "admin_refund_commit"] }] },
 *     },
 *   ];
 */

"use strict";

const DEFAULT_FINANCIAL_TABLES = [
  // 기존(0058·0047·0020·0001) 금융 테이블
  "orders",
  "member_accounts",
  "ai_generations",
  "credit_ledger",
  "admin_actions_ledger",
  // 신규 0062 금융 그래프(§2·§5·§13·§14) — 이름은 0062 실제 create table 과 1:1(A.3·A.7 S2)
  "credit_lots",
  "refund_requests",
  "order_refund_attempts",
  "payment_cancellation_events",
  "reconciliation_issues",
  "credit_refund_shortfalls",
  "legacy_refund_backfill_evidence",
  "cancellation_resolution_batches",
];

const DEFAULT_WRITE_METHODS = ["insert", "update", "upsert", "delete"];

// 항상 금지되는 구 금융 RPC(§37 "구 consume/refund·구 admin cancel/refund").
// admin_cancel_order 는 0062 재정의(무결제 로컬 취소 전용·paid=use_refund_saga fail-closed)로 정식 RPC —
// deny 대상은 0063 이 fail-closed stub 으로 굳히는 구 소비/환급 2종만.
const DEFAULT_DENIED_RPCS = ["consume_gen_credit", "refund_gen_credit"];

const DEFAULT_DENIED_CALLS = ["logCreditEvent"];

// §13 operational 컬럼 예외(0063 column-level grant 와 1:1 — G-43(c)/H2 allowlist 동일 소스).
// 이 테이블의 .update() 는 payload 객체 리터럴의 **모든 키가 아래 목록 안**일 때만 허용.
// 스프레드·계산 키·비리터럴 payload 는 정적 판정 불가 → 불허(fail-closed).
const DEFAULT_ALLOWED_UPDATE_COLUMNS = {
  orders: ["pg_status", "raw", "error_message"],
  member_accounts: ["email"],
  ai_generations: [
    "status", "fail_reason", "candidate_urls", "fal_request_id", "fal_request_ids",
    "picked_doll_id", "picked_index", "cost_cents", "role",
  ],
};

/** update 호출의 callee.object 체인을 내려가며 `from("table")` 의 테이블 리터럴을 찾는다. */
function fromTableOf(startNode) {
  let n = startNode;
  let guard = 0;
  while (n && guard++ < 64) {
    if (n.type === "CallExpression") {
      const callee = n.callee;
      if (
        callee &&
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property &&
        callee.property.type === "Identifier" &&
        callee.property.name === "from"
      ) {
        const arg = n.arguments && n.arguments[0];
        if (arg && arg.type === "Literal" && typeof arg.value === "string") return arg.value;
        return null; // from(<non-literal>) — 정적 판정 불가
      }
      n = callee && callee.type === "MemberExpression" ? callee.object : null;
    } else if (n.type === "MemberExpression") {
      n = n.object;
    } else {
      n = null;
    }
  }
  return null;
}

/** 호출 식별자 이름(bare `f()` 또는 `obj.f()` 의 f). */
function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid direct DML on financial tables, legacy money RPCs, and logCreditEvent; enforce rpc allowlist where configured.",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          financialTables: { type: "array", items: { type: "string" } },
          writeMethods: { type: "array", items: { type: "string" } },
          deniedRpcs: { type: "array", items: { type: "string" } },
          rpcAllowlist: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          deniedCalls: { type: "array", items: { type: "string" } },
          allowedUpdateColumns: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      directWrite:
        "Direct .{{method}}() on financial table '{{table}}' is forbidden — route the write through a SECURITY DEFINER RPC.",
      deniedRpc:
        "Legacy money RPC '{{name}}' is forbidden — use the replacement refund-saga RPC.",
      dynamicRpc:
        "rpc() with a non-literal name is forbidden in financial code — the RPC name must be a static string.",
      notAllowlisted:
        "rpc('{{name}}') is not in the allowed RPC list for this scope — add it to rpcAllowlist or use an allowed RPC.",
      deniedCall:
        "'{{name}}(...)' is forbidden — credit/ledger writes must happen inside the definer RPC, not the app.",
    },
  },

  create(context) {
    const opts = context.options[0] || {};
    const financialTables = new Set(opts.financialTables || DEFAULT_FINANCIAL_TABLES);
    const writeMethods = new Set(opts.writeMethods || DEFAULT_WRITE_METHODS);
    const deniedRpcs = new Set(opts.deniedRpcs || DEFAULT_DENIED_RPCS);
    const deniedCalls = new Set(opts.deniedCalls || DEFAULT_DENIED_CALLS);
    const rpcAllowlist =
      opts.rpcAllowlist === undefined || opts.rpcAllowlist === null
        ? null
        : new Set(opts.rpcAllowlist);
    const allowedUpdateColumns = opts.allowedUpdateColumns || DEFAULT_ALLOWED_UPDATE_COLUMNS;

    /** .update(payload) 가 operational 컬럼 allowlist 안에서만 쓰는지(§13) — 아니면 null. */
    function isOperationalUpdate(table, node) {
      const allow = allowedUpdateColumns[table];
      if (!allow) return false;
      const allowSet = new Set(allow);
      const payload = node.arguments && node.arguments[0];
      if (!payload || payload.type !== "ObjectExpression") return false; // 비리터럴 = 판정 불가 → 불허
      for (const prop of payload.properties) {
        if (prop.type !== "Property" || prop.computed) return false; // 스프레드·계산 키 → 불허
        const key =
          prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key.type === "Literal" && typeof prop.key.value === "string"
              ? prop.key.value
              : null;
        if (!key || !allowSet.has(key)) return false;
      }
      return true;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        const method = calleeName(callee);

        // 3) 금지 식별자 호출(logCreditEvent 등)
        if (method && deniedCalls.has(method)) {
          context.report({ node, messageId: "deniedCall", data: { name: method } });
        }

        // 1) 금융 테이블 직접 DML
        if (
          method &&
          writeMethods.has(method) &&
          callee.type === "MemberExpression"
        ) {
          const table = fromTableOf(callee.object);
          if (table && financialTables.has(table)) {
            // §13 operational 컬럼 한정 UPDATE 는 허용(0063 column grant·G-43(c) allowlist 와 동일).
            if (!(method === "update" && isOperationalUpdate(table, node))) {
              context.report({ node, messageId: "directWrite", data: { method, table } });
            }
          }
        }

        // 2)/4) rpc() — 구 RPC 금지 + (옵션) exact allowlist
        if (method === "rpc" && callee.type === "MemberExpression") {
          const arg = node.arguments && node.arguments[0];
          if (arg && arg.type === "Literal" && typeof arg.value === "string") {
            const name = arg.value;
            if (deniedRpcs.has(name)) {
              context.report({ node, messageId: "deniedRpc", data: { name } });
            } else if (rpcAllowlist && !rpcAllowlist.has(name)) {
              context.report({ node, messageId: "notAllowlisted", data: { name } });
            }
          } else if (arg) {
            // 동적 rpc 이름 — 정적 검증 불가. allowlist 모드에서만 강제(일반 모드에선 무시).
            if (rpcAllowlist) {
              context.report({ node, messageId: "dynamicRpc" });
            }
          }
        }
      },
    };
  },
};

module.exports = rule;
