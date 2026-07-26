// face-analysis.test.ts — interpretFaceChecks 판정 로직 회귀 가드.
//   실행: node --test __tests__/generation/face-analysis.test.ts   (Node 24 기본 strip-types)
//   face-analysis.ts 는 런타임 의존 0(순수) → alias 로더 불필요.
//
// moondream/query 는 compound 프롬프트를 첫 질문만 답해 무력화되므로 체크별 단일콜을 병렬 호출하고,
// 그 raw 답변을 이 함수가 판정한다. 판정은 **명시적 위반일 때만** 차단(fail-open). 실측 답변 형태 기반.

import test from "node:test";
import assert from "node:assert/strict";
import { interpretFaceChecks } from "../../lib/character-gen/face-analysis.ts";

test("정상 단독 얼굴 — 전부 통과", () => {
  const r = interpretFaceChecks({ face: "yes", count: "1", covered: "no", glasses: "no" });
  assert.equal(r.faceVisible, true);
  assert.equal(r.peopleCount, 1);
  assert.equal(r.singlePerson, true);
  assert.equal(r.faceClear, true);
  assert.equal(r.wearsGlasses, false);
});

test("여러 명 — singlePerson false", () => {
  assert.equal(interpretFaceChecks({ face: "yes", count: "3", covered: "no", glasses: "no" }).singlePerson, false);
  // 문장형 응답에서도 첫 정수 추출
  const r = interpretFaceChecks({ face: "yes", count: "There are 2 people", covered: "no", glasses: "no" });
  assert.equal(r.peopleCount, 2);
  assert.equal(r.singlePerson, false);
});

test("얼굴 가림 — faceClear false (covered=yes)", () => {
  assert.equal(interpretFaceChecks({ face: "yes", count: "1", covered: "yes", glasses: "no" }).faceClear, false);
});

test("얼굴 없음 — faceVisible false (face=no)", () => {
  assert.equal(interpretFaceChecks({ face: "no", count: "0", covered: "no", glasses: "no" }).faceVisible, false);
});

test("안경 — wearsGlasses true (반려 아님)", () => {
  assert.equal(interpretFaceChecks({ face: "yes", count: "1", covered: "no", glasses: "yes" }).wearsGlasses, true);
});

test("fail-open — 전부 null 이면 통과 판정", () => {
  const r = interpretFaceChecks({ face: null, count: null, covered: null, glasses: null });
  assert.equal(r.faceVisible, true);
  assert.equal(r.peopleCount, null);
  assert.equal(r.singlePerson, true); // count 미검출 → 통과
  assert.equal(r.faceClear, true);
  assert.equal(r.wearsGlasses, false);
});

test("단어경계 — 'nose' 는 'no' 로 오인하지 않음", () => {
  assert.equal(interpretFaceChecks({ face: "yes, a nose is visible", count: "1", covered: "no", glasses: "no" }).faceVisible, true);
});

test("covered 부정문 — 'No, nothing covers' 는 가림 아님", () => {
  assert.equal(interpretFaceChecks({ face: "yes", count: "1", covered: "No, nothing covers the face", glasses: "no" }).faceClear, true);
});

test("0명 — singlePerson 은 true 유지(빈 사진은 no_face 가 처리)", () => {
  const r = interpretFaceChecks({ face: "no", count: "0", covered: "no", glasses: "no" });
  assert.equal(r.peopleCount, 0);
  assert.equal(r.singlePerson, true);
});

test("대소문자 무시 — YES/NO 도 판정", () => {
  const r = interpretFaceChecks({ face: "YES", count: "1", covered: "YES", glasses: "YES" });
  assert.equal(r.faceVisible, true);
  assert.equal(r.faceClear, false);
  assert.equal(r.wearsGlasses, true);
});
