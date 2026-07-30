import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  InvalidPendingGenerationsResponseError,
  parsePendingGenerationsResponse,
} from "../../lib/pending-generations-response.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("pending generation response validates every row and signed candidate URL", () => {
  assert.deepEqual(
    parsePendingGenerationsResponse({
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: ["https://storage.example.test/a?token=x"],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    }),
    [
      {
        id: ID,
        kind: "ready",
        candidateUrls: ["https://storage.example.test/a?token=x"],
        createdAt: "2026-07-29T00:00:00.000Z",
        role: "boss",
      },
    ],
  );
  assert.deepEqual(
    parsePendingGenerationsResponse({
      pending: [
        {
          id: ID,
          kind: "generating",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:00+09:00",
          role: "teamlead",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "interrupted",
          reason: "photo",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:00.123456Z",
          role: "client",
        },
      ],
    }).map((row) => row.kind),
    ["generating", "interrupted"],
  );

  for (const value of [
    null,
    {},
    { pending: [], extra: true },
    { pending: null },
    { pending: [{ id: ID }] },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: ["javascript:alert(1)"],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "unknown",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: [
            "https://storage.example.test/a",
            "https://storage.example.test/a",
          ],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "generating",
          candidateUrls: ["https://storage.example.test/a"],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: ["https://storage.example.test/a"],
          createdAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: ["https://storage.example.test/a"],
          createdAt: " 2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: ["https://user:secret@storage.example.test/a"],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "ready",
          candidateUrls: ["https://storage.example.test/a"],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
          reason: "photo",
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "generating",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
          extra: true,
        },
      ],
    },
    {
      pending: [
        {
          id: ID,
          kind: "generating",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          role: "boss",
        },
        {
          id: ID,
          kind: "generating",
          candidateUrls: [],
          createdAt: "2026-07-29T00:00:01.000Z",
          role: "boss",
        },
      ],
    },
  ]) {
    assert.throws(
      () => parsePendingGenerationsResponse(value),
      InvalidPendingGenerationsResponseError,
    );
  }
});

test("gallery exposes pending-generation read failure and retry", () => {
  const gallery = readFileSync(
    new URL("../../app/gallery/page.tsx", import.meta.url),
    "utf8",
  );
  const polling = readFileSync(
    new URL("../../lib/gallery-pending-poll.ts", import.meta.url),
    "utf8",
  );
  assert.match(gallery, /pollGalleryPendingGenerations/);
  assert.match(polling, /parsePendingGenerationsResponse/);
  assert.match(gallery, /pendingLoadError/);
  assert.match(gallery, /생성 상태 다시 확인/);
  assert.match(polling, /if \(!response\.ok\) throw/);
  assert.doesNotMatch(polling, /if \(!response\.ok\) return/);
});

test("generate entry and polling never collapse an unknown active generation into a new request", () => {
  const page = readFileSync(
    new URL("../../app/generate/page.tsx", import.meta.url),
    "utf8",
  );
  const polling = readFileSync(
    new URL("../../app/generate/useGenerationPolling.ts", import.meta.url),
    "utf8",
  );
  assert.match(page, /parsePendingGenerationsResponse/);
  assert.match(page, /if \(!res\.ok\)[\s\S]*pending_generations_http_/);
  assert.match(
    page,
    /generation\.kind === "ready"[\s\S]*generation\.kind === "generating"/,
  );
  assert.match(page, /새 생성은 시작하지 않았습니다/);
  assert.match(page, /stage === "generating"[\s\S]*role="alert"/);
  assert.match(page, /생성 상태 다시 확인/);
  assert.match(polling, /result\.status === "unavailable"/);
  assert.doesNotMatch(
    polling,
    /result\.status === "unavailable"[\s\S]{0,300}setStage\("upload"\)/,
  );
});
