// 오류 카탈로그 계약 — 코드→status/문구/동작의 단일 소스(lib/pay/error-catalog)가
// DB raise 전수·라우트 생성 코드와 어긋나지 않음을 강제한다.
//
// 2026-08-19 사고의 구조 원인(4계층 오류 사전 수동 동기화 — 등록 하나 빠지면
// 가짜 fatal 500 + 무정보 문구)의 재발 방지 장치: 새 raise 코드는 카탈로그에
// 등록(정상 거절)하거나 `npm run gen:db-raise-codes` 로 스냅샷을 갱신(불변식
// 위반 계열)해야 이 테스트를 통과한다 — 어느 쪽도 하지 않은 머지는 차단된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  PAY_ERROR_CATALOG,
  resolvePayError,
  payErrorMessage,
  payErrorAction,
  type PayErrorEntry,
} from "../../lib/pay/error-catalog.ts";
import { DB_RAISE_CODES } from "../../lib/pay/db-raise-codes.gen.ts";
// .mjs 생성기 모듈 — 추출 규칙의 단일 소스(타입은 호출부 단언으로 좁힘).
import { extractDbRaiseCodes } from "../../scripts/gen/db-raise-codes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const entries = Object.entries(PAY_ERROR_CATALOG) as Array<
  [string, PayErrorEntry]
>;

test("스냅샷 신선도: db-raise-codes.gen.ts 는 마이그레이션 raise 전수와 일치한다", () => {
  const { codes, nonLiteral } = extractDbRaiseCodes(migrationsDir) as {
    codes: string[];
    nonLiteral: string[];
  };
  assert.deepEqual(
    nonLiteral,
    [],
    "비-리터럴 raise 발견 — scripts/gen/db-raise-codes.mjs 의 추출 규칙을 먼저 확장할 것",
  );
  const live = new Set(codes);
  const stale = [...DB_RAISE_CODES].filter((c) => !live.has(c));
  const missing = codes.filter((c) => !DB_RAISE_CODES.has(c));
  assert.deepEqual(
    { stale, missing },
    { stale: [], missing: [] },
    "마이그레이션 raise 전수가 바뀜 — `npm run gen:db-raise-codes` 로 스냅샷을 재생성할 것",
  );
});

test("유령 방지: 카탈로그의 db-origin 코드는 전부 실제 raise 된다", () => {
  const ghosts = entries
    .filter(([, entry]) => entry.origin === "db")
    .map(([code]) => code)
    .filter((code) => !DB_RAISE_CODES.has(code));
  assert.deepEqual(
    ghosts,
    [],
    "어떤 마이그레이션도 raise 하지 않는 코드가 카탈로그에 등록됨(오타/제거 잔존)",
  );
});

test("route-origin 코드는 전부 앱 소스가 실제로 생성한다", () => {
  const roots = ["app", "lib"].map((d) => path.join(repoRoot, d));
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".gen.ts")) {
        sources.push(readFileSync(p, "utf8"));
      }
    }
  };
  roots.forEach(walk);
  const corpus = sources.join("\n");
  const ghosts = entries
    .filter(([, entry]) => entry.origin === "route")
    .map(([code]) => code)
    .filter((code) => !corpus.includes(`"${code}"`));
  assert.deepEqual(
    ghosts,
    [],
    "앱 소스 어디에서도 생성되지 않는 route-origin 코드가 카탈로그에 등록됨",
  );
});

test("stale_reload 액션 코드는 재발(2회차) 표시용 문구를 반드시 가진다", () => {
  const silent = entries
    .filter(([, entry]) => entry.action === "stale_reload" && !entry.message)
    .map(([code]) => code);
  assert.deepEqual(silent, []);
});

test("resolvePayError 3분류: cataloged / invariant / uncataloged", () => {
  // 정상 거절 — 카탈로그 매핑 그대로.
  const cataloged = resolvePayError("checkout_prior_intent_unresolved", DB_RAISE_CODES);
  assert.equal(cataloged.kind, "cataloged");
  assert.equal(
    cataloged.kind === "cataloged" ? cataloged.entry.status : null,
    409,
  );
  // 카탈로그 밖 + raise 전수 안 = 불변식 위반(도달 자체가 버그).
  const invariantSample = [...DB_RAISE_CODES].find(
    (c) => !Object.prototype.hasOwnProperty.call(PAY_ERROR_CATALOG, c),
  );
  assert.ok(invariantSample, "불변식 계열 코드가 최소 1개는 존재해야 함");
  assert.equal(resolvePayError(invariantSample!, DB_RAISE_CODES).kind, "invariant");
  // 어느 쪽에도 없는 미지 토큰 = 등록 누락 결함 신호.
  assert.equal(
    resolvePayError("no_such_code_ever", DB_RAISE_CODES).kind,
    "uncataloged",
  );
});

test("클라 문구: 사전에 없는 코드도 사유 코드를 숨기지 않는다", () => {
  assert.equal(
    payErrorMessage("rate_limited"),
    "결제 요청이 너무 잦아요. 잠시 후 다시 시도해주세요.",
  );
  assert.match(payErrorMessage("some_unknown_code"), /사유 코드: some_unknown_code/);
  assert.equal(payErrorAction("client_refresh_required"), "stale_reload");
  assert.equal(payErrorAction("unauthorized"), "login");
  assert.equal(payErrorAction("rate_limited"), null);
});
