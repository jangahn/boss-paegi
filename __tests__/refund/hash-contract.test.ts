// hash-contract.test.ts — canonical hash 계약 테스트 (§10·§46).
//
// 상태: generated / statically-verifiable — **node 로 실제 실행 가능**(라이브 DB·PG digest 불필요).
//   node:test 러너로 Node 24(타입 스트리핑) 또는 Node 22 `--experimental-strip-types` 에서 그대로 실행된다.
//   실행:
//     node --test __tests__/refund/hash-contract.test.ts          # Node 24+ (기본 타입 스트리핑)
//     node --experimental-strip-types --test __tests__/refund/hash-contract.test.ts   # Node 22.6~22.17
//
// 목적: scripts/refund/hash-golden-vectors.mjs 의 canonical/hash 구현이 레포에 고정된 8개 golden
//   벡터(scripts/refund/hash-goldens.json)를 **재계산으로 재현**함을 정적으로(=DB 없이) 증명한다.
//   canonical 은 0062 의 public.bp_canonical_json(jsonb) 와 **바이트 단위 등가**인 compact JSON
//   canonical(키 UTF-8 바이트순 정렬·공백 없음·JSON scalar 정규형)이며, hash 는
//   public.bp_versioned_hash(payload, 1) = encode(digest(convert_to(canonical,'UTF8'),'sha256'),'hex')
//   와 등가다(주석 계약 — 실 PG digest 대조는 runtime G-44 담당, 여기선 Node 내부 재현만 검증).
//
// 이 파일이 검증하는 dimension(§10): key order·whitespace·Unicode·timestamp·UUID·numeric boundary·
//   delimiter(`|`/`:`) — 그리고 base==key_order(키 순서 불변성)·delimiter 이스케이프 규약·
//   canonical==golden.canonical(base==key_order 의 canonical 동일)·모든 hash lowercase 64 hex.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  canonicalHash,
  canonicalize,
  sha256Hex,
  HASH_VERSION,
  uuid,
  ts,
} from "../../scripts/refund/hash-golden-vectors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDENS_PATH = join(HERE, "../../scripts/refund/hash-goldens.json");
const goldens = JSON.parse(readFileSync(GOLDENS_PATH, "utf8"));

const HEX64 = /^[0-9a-f]{64}$/;

test("goldens 파일 헤더가 v1 sha256/utf8 계약과 일치한다", () => {
  assert.equal(goldens.hash_version, HASH_VERSION, "hash_version 은 reference 구현과 동일해야 함");
  assert.equal(HASH_VERSION, 1);
  assert.equal(goldens.algorithm, "sha256");
  assert.equal(goldens.encoding, "utf8");
  assert.equal(goldens.vector_count, goldens.vectors.length, "vector_count == 실제 배열 길이");
  assert.equal(goldens.vectors.length, 8, "§10 은 8개 dimension 벡터를 요구");
  // canonical 규약이 bp_canonical_json / bp_versioned_hash 등가임을 파일이 명시(문서화 계약).
  assert.match(goldens.canonical_scheme, /bp_canonical_json v1/);
  assert.match(goldens.pg_equivalent, /bp_versioned_hash/);
  assert.match(goldens.pg_equivalent, /bp_canonical_json/);
});

test("8개 golden 벡터를 reference 구현으로 재계산하면 canonical·sha256 이 정확히 재현된다", () => {
  for (const v of goldens.vectors) {
    // golden.payload 는 {$uuid}/{$ts} 래퍼를 그대로 담고 있어 canonicalHash 가 직접 소비 가능.
    const { canonical, sha256 } = canonicalHash(v.payload);
    assert.equal(canonical, v.canonical, `[${v.name}] canonical 재현 불일치`);
    assert.equal(sha256, v.sha256, `[${v.name}] sha256 재현 불일치`);
    assert.match(sha256, HEX64, `[${v.name}] sha256 은 lowercase 64 hex 여야 함`);
    // canonical 은 hash_version:1 을 최상위에 병합(bp_versioned_hash 등가) → 문자열에 "hash_version":1 포함.
    assert.ok(canonical.includes('"hash_version":1'), `[${v.name}] hash_version merge 누락`);
    // sha256 은 canonical UTF-8 바이트의 digest 와 등가(구현 경로 교차검증).
    assert.equal(sha256Hex(canonical), sha256, `[${v.name}] sha256Hex(canonical) 불일치`);
  }
});

test("base == key_order (키 순서만 다른 입력은 동일 canonical·동일 hash)", () => {
  const base = goldens.vectors.find((v: { name: string }) => v.name === "base");
  const keyOrder = goldens.vectors.find((v: { name: string }) => v.name === "key_order");
  assert.ok(base && keyOrder, "base·key_order 벡터 존재");
  // §10: 키 정렬이 canonical 을 결정하므로 두 벡터의 canonical 문자열 자체가 동일해야 함.
  assert.equal(keyOrder.canonical, base.canonical, "key_order 의 canonical 은 base 와 동일");
  assert.equal(keyOrder.sha256, base.sha256, "key_order 의 hash 는 base 와 동일");
  // reference 구현으로도 순서 불변성 재확인.
  assert.equal(canonicalHash(keyOrder.payload).sha256, canonicalHash(base.payload).sha256);
});

test("delimiter 케이스: `|`·`:` 는 이스케이프하지 않고 canonical 에 원문 보존", () => {
  const d = goldens.vectors.find((v: { name: string }) => v.name === "delimiter");
  assert.ok(d, "delimiter 벡터 존재");
  const { canonical, sha256 } = canonicalHash(d.payload);
  assert.equal(canonical, d.canonical);
  assert.equal(sha256, d.sha256);
  // JSON 문자열 규약: `:`·`|` 는 비이스케이프(백슬래시 미부착)로 그대로 나타난다.
  assert.ok(
    canonical.includes("BP_REFUND:6f9619ff-8b86-d011-b42d-00c04fc964ff"),
    "correlation marker 의 `:` 는 원문 보존",
  );
  assert.ok(canonical.includes("a|b|c"), "pipe `|` 는 원문 보존");
  assert.ok(canonical.includes("k:v|k2:v2"), "혼합 delimiter 원문 보존");
  assert.ok(!canonical.includes("\\:") && !canonical.includes("\\|"), "`:`/`|` 는 이스케이프되지 않음");
});

test("exported 래퍼(uuid/ts)로 재구성한 payload 가 base golden 을 재현한다 (helper 경로 교차검증)", () => {
  const base = goldens.vectors.find((v: { name: string }) => v.name === "base");
  // 원 payload 를 코드로 재구성(uuid()/ts() named export 사용).
  const rebuilt = canonicalHash({
    reason: "customer_request",
    rail: "portone",
    qty: 3,
    amount: 3000,
    order_uuid: uuid("00000000-0000-4000-8000-000000000001"),
    attempt_id: uuid("6F9619FF-8B86-D011-B42D-00C04FC964FF"), // 대문자 입력 → lowercase 정규화
  });
  assert.equal(rebuilt.sha256, base.sha256, "uuid 대문자 입력·키 순서 뒤섞임에도 base 재현");
  assert.equal(rebuilt.canonical, base.canonical);
});

test("timestamp 케이스: +09:00 입력이 UTC microsecond 로 정규화되어 UTC 입력과 동일 hash", () => {
  const tsVec = goldens.vectors.find((v: { name: string }) => v.name === "timestamp");
  assert.ok(tsVec, "timestamp 벡터 존재");
  const { canonical, sha256 } = canonicalHash(tsVec.payload);
  assert.equal(canonical, tsVec.canonical);
  assert.equal(sha256, tsVec.sha256);
  // paid_at(+09:00) 과 granted_at(Z) 는 동일 절대시각 → canonical 에서 동일 UTC 문자열로 접힘.
  assert.ok(canonical.includes("2026-07-24T09:30:45.123456Z"), "UTC microsecond 정규화 확인");
  // 코드로 직접 정규화해도 동일.
  assert.equal(
    canonicalize({ paid_at: ts("2026-07-24T18:30:45.123456+09:00"), granted_at: ts("2026-07-24T09:30:45.123456Z") }),
    tsVec.canonical,
  );
});

test("canonicalize 는 top-level object 만 허용(계약 위반은 throw)", () => {
  assert.throws(() => canonicalize([1, 2, 3] as unknown as Record<string, unknown>), /top-level payload must be an object/);
  assert.throws(() => canonicalize(null as unknown as Record<string, unknown>), /top-level payload must be an object/);
});
