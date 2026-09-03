// face-analysis.test.ts — interpretFaceChecks 판정 로직 회귀 가드.
//   실행: node --test __tests__/generation/face-analysis.test.ts   (Node 24 기본 strip-types)
//   face-analysis.ts 는 런타임 의존 0(순수) → alias 로더 불필요.
//
// moondream/query 는 compound 프롬프트를 첫 질문만 답해 무력화되므로 체크별 단일콜을 병렬 호출하고,
// 그 raw 답변을 이 함수가 판정한다. 판정은 **명시적 위반일 때만** 차단(fail-open). 실측 답변 형태 기반.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FaceAnalysisUnavailableError,
  interpretFaceChecks,
} from "../../lib/character-gen/face-analysis.ts";

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

test("필수 체크의 null·빈값·모호 응답은 생성 승인으로 강등하지 않는다", () => {
  const base = { face: "yes", count: "1", covered: "no", glasses: "no" };
  for (const key of ["face", "count", "covered", "glasses"] as const) {
    for (const value of [null, "", "maybe", "yes and no"]) {
      assert.throws(
        () => interpretFaceChecks({ ...base, [key]: value }),
        FaceAnalysisUnavailableError,
        `${key}=${String(value)}`,
      );
    }
  }
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

test("face와 count는 서로 다른 술어라 조합이 상충으로 차단되지 않는다", () => {
  // face=no + count=1(사람은 있으나 얼굴이 안 보임)은 no_face 후보 사진의
  // 대표 형태다 — throw가 아니라 faceVisible:false로 재촬영 안내에 합류한다.
  const r = interpretFaceChecks({ face: "no", count: "1", covered: "no", glasses: "no" });
  assert.equal(r.faceVisible, false);
  assert.equal(r.peopleCount, 1);
  const crowd = interpretFaceChecks({ face: "no", count: "2", covered: "no", glasses: "no" });
  assert.equal(crowd.faceVisible, false);
  assert.equal(crowd.singlePerson, false);
  const empty = interpretFaceChecks({ face: "yes", count: "0", covered: "no", glasses: "no" });
  assert.equal(empty.faceVisible, true);
  assert.equal(empty.peopleCount, 0);
});

test("인원수는 하나의 안전 정수 증거만 허용한다", () => {
  const base = { face: "yes", covered: "no", glasses: "no" };
  // "1."(숫자+문장 마침표)은 유효한 단일 정수 증거로 수용한다.
  assert.equal(
    interpretFaceChecks({ ...base, count: "1." }).peopleCount,
    1,
  );
  for (const count of [
    "1 or 2",
    "-1",
    "1.5",
    "9007199254740992",
    "one",
  ]) {
    assert.throws(
      () => interpretFaceChecks({ ...base, count }),
      FaceAnalysisUnavailableError,
      count,
    );
  }
});

test("분석 불확실성은 generation row·크레딧·외부 생성 제출 전에 durable terminal로 끝난다", () => {
  const route = readFileSync(
    new URL("../../app/api/fal/route.ts", import.meta.url),
    "utf8",
  );
  // v1.20: commit→제출은 lib/character-gen/generation-continuation 으로 이동(route 는 위임).
  // 순서 계약은 route(얼굴검사 제출 → continuation 위임) + lib(commit → 외부 제출)로 이어진다.
  const continuation = readFileSync(
    new URL(
      "../../lib/character-gen/generation-continuation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const childSubmit = route.indexOf("submitFaceCheckOnce(");
  const delegate = route.indexOf("runGenerationContinuation({");
  const commit = continuation.indexOf('"commit_generation_preflight"');
  const submit = continuation.indexOf("provider.submitPlan");
  assert.ok(childSubmit > 0);
  assert.ok(delegate > childSubmit);
  assert.ok(commit > 0);
  assert.ok(submit > commit);
  assert.doesNotMatch(route, /analyzeInputFace|fal\.subscribe/);
  assert.doesNotMatch(continuation, /analyzeInputFace|fal\.subscribe/);

  const webhook = readFileSync(
    new URL("../../app/api/fal/face-webhook/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(webhook, /buildFaceAnalysis\(raw\)/);
  assert.match(webhook, /p_failure_reason: failureReason/);
  assert.match(webhook, /finalize_generation_face_checks/);
});
