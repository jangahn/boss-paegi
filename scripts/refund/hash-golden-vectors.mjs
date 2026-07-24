#!/usr/bin/env node
/**
 * hash-golden-vectors.mjs — 환불 saga canonical hash 규약의 참조(reference) 구현 + golden 고정.
 *
 * 상태: generated / statically-verifiable
 *   이 파일의 canonical 직렬화·SHA-256 계산은 Node 에서 실제 실행되어 golden 을 산출한다(라이브 DB 불필요).
 *   `node scripts/refund/hash-golden-vectors.mjs` 실행 시 재계산→검증→scripts/refund/hash-goldens.json 출력.
 *   골든은 "대상 DB 에서 계산한 값"이 아니라 **레포에 고정한 literal payload → literal hex** 벡터다(§10).
 *
 * 목적(§6.2·§10):
 *   1) hash_version:1 canonical 직렬화 규약을 Node 로 구현 — 0062 의 public.bp_canonical_json(jsonb) 과
 *      **동일한 JSON canonical 알고리즘**(키 바이트순 정렬·공백 없음·JSON scalar 정규형). 필드값은
 *      number(정수)·UUID lowercase·timestamp UTC microsecond 로 정규화한 뒤 일반 string 으로 직렬화.
 *   2) 여러 케이스(key order/whitespace/Unicode/timestamp/UUID/numeric boundary/delimiter)의
 *      literal payload → literal hex golden 벡터를 생성해 JSON 파일로 고정.
 *   3) 이 canonical/hash 구현을 named export 하여 preflight·allocation-manifest 스크립트가
 *      **동일 구현**을 재사용(1 개념 1 구현 — 워크스페이스 일관성 원칙).
 *
 * PostgreSQL 등가성(주석 계약 — §6.2·§10):
 *   canonical 은 native JSON printer 가 아니라 0062 의 public.bp_canonical_json(jsonb) 과 **바이트 단위로
 *   동일한** compact JSON canonical(RFC 8785 유사)을 Node 로 재구현한 것이다. 규칙:
 *     - object: 키를 UTF-8 바이트순(PG `order by key collate "C"`)으로 정렬하고 공백 없이
 *       `"key":canonical(value)` 를 `,` 로 이어 `{...}` 로 감싼다(키는 JSON 문자열 인코딩).
 *     - array: 각 원소 canonical 을 `,` 로 이어 `[...]`.
 *     - scalar: jsonb ::text 정규형 — 문자열은 표준 JSON escape(JS `JSON.stringify` 와 동일: `"`·`\`·
 *       제어문자만 escape, `/`·`:`·`|`·비ASCII 는 비escape), 정수는 String(n), bool 은 true/false,
 *       null 은 문자열 `null`.
 *   버전 바인딩: canonicalize(payload) 는 최상위 객체에 `hash_version` 을 merge(덮어쓰기) 한 뒤 전체를
 *   canonical — PG public.bp_versioned_hash(payload, version) 등가(= 병합 후 전체 키 재정렬).
 *   최종 hex 는 sha256(convert_to(canonical,'UTF8')) — PG:
 *     encode(extensions.digest(convert_to(<canonical>,'UTF8'),'sha256'),'hex')  (= public.bp_sha256_hex)
 *   Node↔PG 바이트 일치는 **동일 알고리즘 구현으로 by construction** 이며, 실제 PG digest 와의
 *   런타임 일치는 이 파일에서 검증하지 않는다 — **runtime-unverified**(라이브 대조는 G-44 가 확인).
 *
 * 입력 정규화 규칙(canonical 이전 단계 — canonical 자체는 결과 문자열을 일반 string 으로 처리):
 *   - uuid(v): 정규식 검증 후 lowercase. (PG: x::uuid::text)
 *   - ts(v):   UTC microsecond ISO `YYYY-MM-DDTHH:MM:SS.ffffffZ` 로 정규화.
 *              (PG: to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 *   - number:  안전정수만 허용(KRW 정수 금액) — 비정수/비유한/비안전정수는 throw(추정 금지).
 *
 * 실행:
 *   node scripts/refund/hash-golden-vectors.mjs            # 재계산·검증·hash-goldens.json 출력
 *   node scripts/refund/hash-golden-vectors.mjs --check    # 파일과 비교만(불일치 시 exit 1) — CI/G-44 용
 */

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const HASH_VERSION = 1;

const GOLDENS_PATH = join(dirname(fileURLToPath(import.meta.url)), "hash-goldens.json");

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/** 타입 래퍼 — JSON 엔 uuid/timestamp 타입이 없으므로 payload 에서 의도를 명시적으로 표기. */
export const uuid = (v) => ({ $uuid: v });
export const ts = (v) => ({ $ts: v });

/** UTF-8 바이트순 비교 — PG object 키 정렬(`order by key collate "C"`) 과 동일 순서(BMP 밖 코드포인트 포함). */
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** 문자열 → JSON 문자열 리터럴. PG to_json(text)::text / jsonb string ::text 와 동일 escape. */
function encodeString(s) {
  return JSON.stringify(String(s));
}

function encodeNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`canonical: non-finite number: ${String(n)}`);
  }
  if (!Number.isSafeInteger(n)) {
    // 금융 canonical 은 정수(KRW) 만 — 부동소수/비안전정수는 재현 불가·추정 금지.
    throw new Error(`canonical: number must be a safe integer: ${n}`);
  }
  return String(n);
}

function normalizeTimestamp(input) {
  const raw = input instanceof Date ? input.toISOString() : String(input);
  const m = TS_RE.exec(raw);
  if (!m) throw new Error(`canonical: invalid timestamp: ${raw}`);
  const [, y, mo, d, h, mi, s, frac = "", off] = m;
  // 오프셋(분 단위)을 초 성분에 적용해 UTC 로. microsecond 는 오프셋(분단위)에 불변이라 별도 보존.
  let offsetMin = 0;
  if (off && off !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const digits = off.slice(1).replace(":", "");
    offsetMin = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10));
  }
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMin * 60_000;
  const dt = new Date(utcMs);
  const micros = (frac + "000000").slice(0, 6); // 소수부를 microsecond 6자리로 pad/truncate
  const p = (v, w) => String(v).padStart(w, "0");
  return (
    `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1, 2)}-${p(dt.getUTCDate(), 2)}` +
    `T${p(dt.getUTCHours(), 2)}:${p(dt.getUTCMinutes(), 2)}:${p(dt.getUTCSeconds(), 2)}.${micros}Z`
  );
}

/**
 * bp_canonical_json 등가 — 값을 compact JSON canonical 문자열로 직렬화(키 바이트순·공백 없음).
 * uuid/timestamp 래퍼는 정규화된 '문자열'로 접어 일반 string 으로 처리한다(canonical 은 타입 태그를 두지 않음).
 */
function canonicalJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return encodeNumber(v);
  if (typeof v === "string") return encodeString(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    if (typeof v.$uuid === "string") {
      if (!UUID_RE.test(v.$uuid)) throw new Error(`canonical: invalid uuid: ${v.$uuid}`);
      return encodeString(v.$uuid.toLowerCase());
    }
    if (v.$ts !== undefined) return encodeString(normalizeTimestamp(v.$ts));
    const keys = Object.keys(v).sort(compareUtf8);
    return "{" + keys.map((k) => encodeString(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  throw new Error(`canonical: unsupported value type: ${typeof v}`);
}

/**
 * 최상위 canonical 문자열 — payload 에 hash_version 을 merge 후 canonical(PG bp_versioned_hash 등가).
 * merge 는 우변 우선(기존 hash_version 이 있으면 덮어씀) — jsonb `p || jsonb_build_object('hash_version', v)` 와 동일.
 */
export function canonicalize(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("canonical: top-level payload must be an object");
  }
  return canonicalJson({ ...payload, hash_version: HASH_VERSION });
}

/** canonical UTF-8 바이트열의 SHA-256 hex(lowercase 64). PG encode(digest(convert_to(...,'UTF8'),'sha256'),'hex') 등가. */
export function sha256Hex(s) {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

/** payload → { canonical, sha256 }. 재구성 가능 immutable 입력만 넣을 것(§10). */
export function canonicalHash(payload) {
  const canonical = canonicalize(payload);
  return { canonical, sha256: sha256Hex(canonical) };
}

// ── golden 벡터 정의(literal payload) — 각 케이스는 §10 이 요구한 dimension 하나씩 고정 ──────────
const CASES = [
  {
    name: "base",
    dimension: "baseline refund-attempt plan",
    payload: {
      attempt_id: uuid("6f9619ff-8b86-d011-b42d-00c04fc964ff"),
      order_uuid: uuid("00000000-0000-4000-8000-000000000001"),
      amount: 3000,
      qty: 3,
      rail: "portone",
      reason: "customer_request",
    },
  },
  {
    name: "key_order",
    dimension: "key order — 입력 키 순서만 다름 → base 와 동일 hash 여야 함",
    expectSameAs: "base",
    payload: {
      reason: "customer_request",
      rail: "portone",
      qty: 3,
      amount: 3000,
      order_uuid: uuid("00000000-0000-4000-8000-000000000001"),
      attempt_id: uuid("6f9619ff-8b86-d011-b42d-00c04fc964ff"),
    },
  },
  {
    name: "whitespace",
    dimension: "whitespace — 값 안의 공백/개행은 보존(문자열 값 민감)",
    payload: { note: "  leading and  inner\ttabs and trailing  ", amount: 0 },
  },
  {
    name: "unicode",
    dimension: "Unicode — 한글/이모지 문자열",
    payload: { reason: "테스트 환불 사유 — 오류 정정 🔁", label: "생성권" },
  },
  {
    name: "timestamp",
    dimension: "timestamp — +09:00 입력을 UTC microsecond 로 정규화",
    payload: {
      paid_at: ts("2026-07-24T18:30:45.123456+09:00"),
      granted_at: ts("2026-07-24T09:30:45.123456Z"),
    },
  },
  {
    name: "uuid",
    dimension: "UUID — 대문자 입력을 lowercase 로 정규화",
    payload: { cancellation_id: uuid("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE") },
  },
  {
    name: "numeric_boundary",
    dimension: "numeric boundary — 0 · 대형 KRW · MAX_SAFE_INTEGER · 음수",
    payload: { zero: 0, krw: 1_000_000, max_safe: Number.MAX_SAFE_INTEGER, neg: -3000 },
  },
  {
    name: "delimiter",
    dimension: "delimiter — 값에 `|` 와 `:` 포함(correlation marker) → 이스케이프 검증",
    payload: {
      marker: "BP_REFUND:6f9619ff-8b86-d011-b42d-00c04fc964ff",
      pipe: "a|b|c",
      mixed: "k:v|k2:v2",
    },
  },
];

function build() {
  const vectors = CASES.map((c) => {
    const { canonical, sha256 } = canonicalHash(c.payload);
    return { name: c.name, dimension: c.dimension, payload: c.payload, canonical, sha256 };
  });

  // 자체 검증 1: expectSameAs 케이스는 참조 케이스와 hash 동일(순서 불변성 증명).
  const byName = Object.fromEntries(vectors.map((v) => [v.name, v]));
  for (const c of CASES) {
    if (c.expectSameAs) {
      const a = byName[c.name].sha256;
      const b = byName[c.expectSameAs].sha256;
      if (a !== b) {
        throw new Error(`golden self-check failed: ${c.name} hash ${a} != ${c.expectSameAs} ${b}`);
      }
    }
  }
  // 자체 검증 2: 모든 hash 는 lowercase 64 hex.
  for (const v of vectors) {
    if (!/^[0-9a-f]{64}$/.test(v.sha256)) throw new Error(`golden ${v.name}: bad hex ${v.sha256}`);
    if (canonicalHash(v.payload).sha256 !== v.sha256) {
      throw new Error(`golden ${v.name}: recompute mismatch`);
    }
  }
  return {
    hash_version: HASH_VERSION,
    algorithm: "sha256",
    encoding: "utf8",
    canonical_scheme:
      'bp_canonical_json v1 — compact JSON, keys sorted by UTF-8 bytes (collate "C"), jsonb-normal scalars; hash_version merged at top level (bp_versioned_hash equivalent)',
    pg_equivalent:
      "public.bp_versioned_hash(<payload>, hash_version) = encode(extensions.digest(convert_to(public.bp_canonical_json(<payload> || jsonb_build_object('hash_version', hash_version)),'UTF8'),'sha256'),'hex')",
    generated_by: "scripts/refund/hash-golden-vectors.mjs",
    vector_count: vectors.length,
    vectors,
  };
}

function main() {
  const check = process.argv.includes("--check");
  const built = build();
  const json = JSON.stringify(built, null, 2) + "\n";

  if (check) {
    let onDisk;
    try {
      onDisk = readFileSync(GOLDENS_PATH, "utf8");
    } catch {
      console.error(`[FAIL] goldens file missing: ${GOLDENS_PATH}`);
      process.exit(1);
    }
    if (onDisk !== json) {
      console.error("[FAIL] hash-goldens.json out of date — run without --check to regenerate.");
      process.exit(1);
    }
    console.log(`[OK] ${built.vector_count} golden vectors match on disk.`);
    return;
  }

  writeFileSync(GOLDENS_PATH, json);
  console.log(`[OK] wrote ${built.vector_count} golden vectors → ${GOLDENS_PATH}`);
  for (const v of built.vectors) console.log(`  ${v.name.padEnd(17)} ${v.sha256}`);
}

// import 시엔 실행하지 않음(preflight/allocation-manifest 가 canonicalize/sha256Hex 재사용).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
