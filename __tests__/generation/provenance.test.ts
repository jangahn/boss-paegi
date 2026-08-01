// provenance.test.ts — gen_params 계약 회귀 가드(정상/입력거부/구레코드 파싱).
//   실행: node --test __tests__/generation/provenance.test.ts   (Node 24 기본 strip-types)
//   provenance.ts 는 zod 외 런타임 의존 없음.

import test from "node:test";
import assert from "node:assert/strict";
import { provenanceSchema, parseProvenance } from "../../lib/character-gen/provenance.ts";

const analyze = {
  model: "fal-ai/moondream3-preview/query",
  status: "ok",
  faceVisible: true,
  singlePerson: true,
  peopleCount: 1,
  faceClear: true,
  wearsGlasses: false,
  checks: [{ key: "face", prompt: "...", rawOutput: "yes" }],
};

const fullGeneration = {
  provider: "flux-pulid",
  model: "fal-ai/flux-pulid",
  role: "boss",
  request: {
    imageSize: "square_hd",
    numInferenceSteps: 25,
    guidanceScale: 5,
    trueCfg: 3,
    idWeight: 1,
    candidateCount: 3,
    enableSafetyChecker: true,
    maxSequenceLength: 128,
  },
  // v2 스냅샷(현행) — 통짜 template + 롤 subject/body.
  snapshot: {
    template: "t",
    roleSubject: "s",
    roleBody: "b",
    glasses: "",
    glassesIdentity: "",
    negative: "n",
  },
  candidates: [
    { index: 0, suitColor: "navy", positivePrompt: "p", requestId: "r0", seed: 1, status: "completed" },
  ],
};

test("정상 생성 record — config+generation 있음, 파싱 OK", () => {
  const r = provenanceSchema.safeParse({
    schemaVersion: 1,
    config: { key: "generation_config", source: "db", version: 6, invalid: false },
    analyze,
    generation: fullGeneration,
    postprocess: null,
    picked: null,
  });
  assert.equal(r.success, true);
});

test("입력 거부 record — config/generation 없이 analyze+rejected 로 파싱 OK", () => {
  const r = provenanceSchema.safeParse({
    schemaVersion: 1,
    analyze: { ...analyze, singlePerson: false, peopleCount: 3 },
    rejected: { reason: "multiple_people" },
  });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.rejected?.reason, "multiple_people");
  assert.equal(r.success && r.data.generation, undefined);
});

test("구 레코드(레거시 analyze 단일콜 필드) — 파싱 OK(back-compat)", () => {
  const p = parseProvenance({
    schemaVersion: 1,
    config: { key: "generation_config", source: "default", version: null, invalid: false },
    analyze: {
      model: "fal-ai/moondream3-preview/query",
      status: "ok",
      faceVisible: true,
      wearsGlasses: false,
      prompt: "old compound prompt",
      rawOutput: "face=yes",
    },
    generation: fullGeneration,
  });
  assert.notEqual(p, null);
});

test("구 레코드(v1 스냅샷 필드) — 파싱 OK(back-compat, 있는 필드만 표기)", () => {
  const p = parseProvenance({
    schemaVersion: 1,
    config: { key: "generation_config", source: "db", version: 6, invalid: false },
    analyze,
    generation: {
      ...fullGeneration,
      snapshot: {
        headTemplate: "h",
        tail: "t",
        identity: "i",
        negative: "n",
        glassesPrompt: "",
        glassesIdentityPrompt: "",
        subject: "s",
        attireTemplate: "a",
        expression: "e",
      },
    },
  });
  assert.notEqual(p, null);
  assert.equal(p?.generation?.snapshot.template, undefined);
  assert.equal(p?.generation?.snapshot.headTemplate, "h");
  assert.equal(p?.generation?.snapshot.negative, "n");
});

test("parseProvenance — null/손상은 null 반환(상세 안 깨짐)", () => {
  assert.equal(parseProvenance(null), null);
  assert.equal(parseProvenance({ schemaVersion: 99 }), null);
});
