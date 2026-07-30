import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateIndexFromPath,
  candidateRequests,
  hasIncompleteCandidates,
  hasUnresolvedSubmitAcknowledgement,
  isRecoverableGeneration,
  mergeCandidatePaths,
  nextGenerationState,
  requestSlotsFromSubmissions,
  type GenerationEvent,
  type GenerationState,
} from "../../lib/character-gen/generation-state.ts";
import type { SubmitResult } from "../../lib/character-gen/types.ts";

const STATES: GenerationState[] = [
  "queued",
  "done",
  "picked",
  "failed",
  "expired",
];
const EVENTS: GenerationEvent[] = ["recover", "pick", "fail", "expire"];

test("부분 제출의 가능한 2^3 조합이 원 candidate index를 보존한다", () => {
  for (let mask = 0; mask < 1 << 3; mask++) {
    const submissions: SubmitResult[] = [0, 1, 2].map((index) => {
      const submitted = (mask & (1 << index)) !== 0;
      return {
        index,
        requestId: submitted ? `request-${index}` : null,
        status: submitted ? "submitted" : "failed",
        httpStatus: submitted ? 200 : 422,
      };
    });
    const slots = requestSlotsFromSubmissions(submissions);
    assert.equal(slots.length, 3);
    for (let index = 0; index < 3; index++) {
      assert.equal(
        slots[index],
        (mask & (1 << index)) !== 0 ? `request-${index}` : null,
        `mask=${mask.toString(2).padStart(3, "0")}, index=${index}`,
      );
    }
    assert.deepEqual(
      candidateRequests(slots).map(({ index }) => index),
      [0, 1, 2].filter((index) => (mask & (1 << index)) !== 0),
    );
  }
});

test("provenance index가 압축된 레거시 배열보다 우선한다", () => {
  const requests = candidateRequests(["request-1", "request-2"], {
    generation: {
      candidates: [
        { index: 0, requestId: null },
        { index: 1, requestId: "request-1" },
        { index: 2, requestId: "request-2" },
      ],
    },
  });
  assert.deepEqual(requests, [
    { index: 1, requestId: "request-1" },
    { index: 2, requestId: "request-2" },
  ]);
});

test("손상 provenance는 거르고 index/request id 중복을 결정적으로 제거한다", () => {
  const requests = candidateRequests([], {
    generation: {
      candidates: [
        { index: 2, requestId: "same" },
        { index: 0, requestId: "same" },
        { index: 1, requestId: "one" },
        { index: 1, requestId: "duplicate-index" },
        { index: -1, requestId: "negative" },
        { index: 3, requestId: "overflow" },
        { index: 0, requestId: "" },
      ],
    },
  });
  assert.deepEqual(requests, [
    { index: 0, requestId: "same" },
    { index: 1, requestId: "one" },
  ]);
});

test("후보 path 병합은 누락 index를 당기지 않고 index별 최신값으로 수렴한다", () => {
  const base = "owner/candidates/generation";
  assert.equal(candidateIndexFromPath(`${base}/0.jpg`), 0);
  assert.equal(candidateIndexFromPath(`${base}/2.jpg?token=x`), 2);
  assert.equal(candidateIndexFromPath(`${base}/3.jpg`), null);
  assert.deepEqual(
    mergeCandidatePaths(
      [`${base}/0.jpg`, `${base}/2.jpg`],
      [`${base}/1.jpg`, `${base}/2.jpg?revision=2`],
    ),
    [
      `${base}/0.jpg`,
      `${base}/1.jpg`,
      `${base}/2.jpg?revision=2`,
    ],
  );
});

test("완료 후보 수와 요청 수의 모든 0..3 경계를 판정한다", () => {
  const base = "owner/candidates/generation";
  for (let requestCount = 0; requestCount <= 3; requestCount++) {
    const slots = Array.from(
      { length: 3 },
      (_, index) => (index < requestCount ? `r${index}` : null),
    );
    for (let storedCount = 0; storedCount <= 3; storedCount++) {
      const urls = Array.from(
        { length: storedCount },
        (_, index) => `${base}/${index}.jpg`,
      );
      assert.equal(
        hasIncompleteCandidates(urls, slots),
        requestCount > storedCount,
        `requests=${requestCount}, stored=${storedCount}`,
      );
    }
  }
});

test("submit acknowledgement 후보 상태의 5^3 조합을 전수 판정한다", () => {
  const states = [
    "planned",
    "submitting",
    "uncertain",
    "acknowledged",
    "rejected",
  ] as const;
  for (const a of states) {
    for (const b of states) {
      for (const c of states) {
        const candidateStates = [a, b, c];
        const genParams = {
          generation: {
            candidates: candidateStates.map((submitState, index) => ({
              index,
              submitState,
              requestId:
                submitState === "acknowledged" ? `request-${index}` : null,
            })),
          },
        };
        const expected = candidateStates.some(
          (state) => state === "submitting" || state === "uncertain",
        );
        assert.equal(
          hasUnresolvedSubmitAcknowledgement(genParams),
          expected,
          candidateStates.join(","),
        );
        assert.equal(
          hasIncompleteCandidates([], [], genParams),
          expected ||
            candidateStates.some((state) => state === "acknowledged"),
          `incomplete:${candidateStates.join(",")}`,
        );
      }
    }
  }
});

test("상태×이벤트 전이 행렬을 전수 검증한다", () => {
  const allowed = new Map<string, GenerationState>([
    ["queued:recover", "done"],
    ["queued:fail", "failed"],
    ["done:recover", "done"],
    ["done:pick", "picked"],
    ["done:expire", "expired"],
  ]);
  for (const state of STATES) {
    for (const event of EVENTS) {
      assert.equal(
        nextGenerationState(state, event),
        allowed.get(`${state}:${event}`) ?? null,
        `${state} + ${event}`,
      );
    }
  }
});

test("길이 7 이하의 모든 이벤트열에서 terminal 상태는 되살아나지 않는다", () => {
  const walk = (
    state: GenerationState,
    depth: number,
    terminalSeen: GenerationState | null,
  ): void => {
    if (depth === 7) return;
    for (const event of EVENTS) {
      const next = nextGenerationState(state, event);
      const effective = next ?? state;
      if (terminalSeen) {
        assert.equal(effective, terminalSeen);
        assert.equal(next, null);
      }
      walk(
        effective,
        depth + 1,
        terminalSeen ??
          (["picked", "failed", "expired"].includes(effective)
            ? effective
            : null),
      );
    }
  };
  for (const state of STATES) {
    walk(
      state,
      0,
      ["picked", "failed", "expired"].includes(state) ? state : null,
    );
  }
});

test("환급된 행과 terminal 행은 복구 대상이 아니다", () => {
  for (const state of STATES) {
    assert.equal(
      isRecoverableGeneration(state, "2026-07-29T00:00:00.000Z"),
      false,
    );
  }
  assert.equal(isRecoverableGeneration("queued", null), true);
  assert.equal(isRecoverableGeneration("done", null), true);
  assert.equal(isRecoverableGeneration("picked", null), false);
  assert.equal(isRecoverableGeneration("failed", null), false);
  assert.equal(isRecoverableGeneration("expired", null), false);
});
