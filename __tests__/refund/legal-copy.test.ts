// legal-copy.test.ts — 법률 문구 byte golden 테스트 (§31·§11.5, gate G-46).
//
// 상태: statically-verifiable — **node 로 실제 실행 가능**(DB 불필요).
//   실행:
//     node --test __tests__/refund/legal-copy.test.ts          # Node 24+ (기본 타입 스트리핑)
//     node --experimental-strip-types --test __tests__/refund/legal-copy.test.ts   # Node 22.6~22.17
//
// 목적: docs/refund-saga/legal-golden.json 에 고정된 법률/탈퇴 고지 문자열이
//   app/account/page.tsx 원문에 **문자 그대로(byte-for-byte)** 존재하고, 각 문자열의
//   utf8 sha256 과 combined_sha256 이 golden literal 과 일치함을 검증한다.
//   동적 UI(환불가능 수량 안내 등)를 추가·수정해도 이 테스트가 우발적 법률 문구 변경을 게이트한다.
//
// **golden 재생성 금지(§31)**: 불일치 = 실패다. 현재 파일 내용으로 golden 을 다시 만들지 말 것 —
//   법률 문구를 바꿔야 한다면 정책 결정(약관 개정 절차)과 함께 golden 을 의도적으로 갱신한다.
//   line number 는 비정본 — 존재(includes) + hash 로만 검증한다.
//
// combined_sha256 산식(golden 재현으로 역산·확정): strings[].text 를 배열 순서대로 `\n` 으로
//   join 한 utf8 바이트의 sha256 hex — sha256Hex(strings.map(s => s.text).join("\n")).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type LegalGolden = {
  file: string;
  scheme: string;
  note: string;
  strings: { text: string; present: boolean; sha256: string }[];
  all_present: boolean;
  combined_sha256: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const GOLDEN_PATH = join(REPO_ROOT, "docs/refund-saga/legal-golden.json");

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as LegalGolden;
const source = readFileSync(join(REPO_ROOT, golden.file), "utf8");

const HEX64 = /^[0-9a-f]{64}$/;

/** utf8 sha256 hex (lowercase 64 hex) — golden 의 scheme "utf8-sha256" 재현. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("golden 파일 헤더가 utf8-sha256 계약과 일치한다", () => {
  assert.equal(golden.file, "app/account/page.tsx", "골든 대상 파일은 app/account/page.tsx");
  assert.equal(golden.scheme, "utf8-sha256", "hash scheme 은 utf8-sha256");
  assert.equal(golden.strings.length, 3, "§31 golden 은 3개 법률 문자열을 고정");
  assert.equal(golden.all_present, true, "all_present 는 true 로 고정");
  assert.match(golden.combined_sha256, HEX64, "combined_sha256 은 lowercase 64 hex");
});

test("각 법률 문자열이 원문에 문자 그대로 존재하고 utf8 sha256 이 golden 과 일치한다", () => {
  for (const s of golden.strings) {
    assert.equal(s.present, true, `[${s.text.slice(0, 20)}…] present 는 true 로 고정`);
    assert.match(s.sha256, HEX64, `[${s.text.slice(0, 20)}…] sha256 은 lowercase 64 hex`);
    // 존재 검증 — line number 비정본, includes(문자 그대로)로만 판정(§31).
    assert.ok(
      source.includes(s.text),
      `[${s.text.slice(0, 20)}…] 문자열이 ${golden.file} 원문에 byte-for-byte 존재해야 함`
    );
    // hash 검증 — golden literal 재현(불일치 = 법률 문구 변경 → 실패, 재생성 금지).
    assert.equal(
      sha256Hex(s.text),
      s.sha256,
      `[${s.text.slice(0, 20)}…] utf8 sha256 이 golden 과 불일치 — 법률 문구가 변경됨`
    );
  }
});

test("combined_sha256 = strings[].text 를 \\n 조인한 utf8 sha256 (golden 재현으로 역산한 산식)", () => {
  const combined = sha256Hex(golden.strings.map((s) => s.text).join("\n"));
  assert.equal(
    combined,
    golden.combined_sha256,
    "combined hash 불일치 — 법률 문자열 집합/순서가 변경됨(재생성 금지, 원문 복원이 정답)"
  );
});
