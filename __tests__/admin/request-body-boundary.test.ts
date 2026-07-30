import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES,
  ADMIN_JSON_BODY_MAX_BYTES,
  readAdminJsonRequest,
} from "../../lib/http/admin-json-request.ts";

type RequestSurface = {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

function request(
  chunks: Uint8Array[],
  headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  },
): RequestSurface {
  return {
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

test("admin JSON boundary accepts browser JSON and rejects every unsafe body class", async () => {
  const encoder = new TextEncoder();
  assert.deepEqual(
    await readAdminJsonRequest(
      request([encoder.encode('{"ok":true}')]),
      64,
    ),
    { ok: true, value: { ok: true } },
  );

  const rejectedContentTypes: Array<Record<string, string>> = [
    {},
    { "content-type": "text/plain" },
    { "content-type": "application/problem+json" },
  ];
  for (const headers of rejectedContentTypes) {
    assert.deepEqual(
      await readAdminJsonRequest(request([encoder.encode("{}")], headers), 64),
      { ok: false, error: "invalid_body", status: 400 },
    );
  }

  assert.deepEqual(
    await readAdminJsonRequest(
      request([encoder.encode("{}")], {
        "content-type": "application/json",
        "content-length": "02",
      }),
      64,
    ),
    { ok: false, error: "payload_too_large", status: 413 },
  );
  assert.deepEqual(
    await readAdminJsonRequest(
      request([encoder.encode("{}")], {
        "content-type": "application/json",
        "content-length": "65",
      }),
      64,
    ),
    { ok: false, error: "payload_too_large", status: 413 },
  );
  assert.deepEqual(
    await readAdminJsonRequest(
      request([new Uint8Array(40), new Uint8Array(25)]),
      64,
    ),
    { ok: false, error: "payload_too_large", status: 413 },
  );
  assert.deepEqual(
    await readAdminJsonRequest(
      request([Uint8Array.from([0xc3, 0x28])]),
      64,
    ),
    { ok: false, error: "invalid_body", status: 400 },
  );
  assert.deepEqual(
    await readAdminJsonRequest(request([encoder.encode("{")]), 64),
    { ok: false, error: "invalid_body", status: 400 },
  );
});

const standardRoutes = [
  "resolve-cancellation",
  "adjust",
  "cancel",
  "mutations/receipt",
  "event-image",
  "resolve-issue",
  "site-asset",
  "reviewers",
  "settle",
  "integrity/ban",
  "integrity/unban",
  "integrity/clear",
  "integrity/void",
  "refund-credits",
  "reactivate",
  "moderation/restore",
  "moderation/permanent-delete",
  "moderation/takedown",
  "moderation/dismiss",
] as const;
const documentRoutes = ["config", "events", "legal"] as const;

test("owned admin routes parse bounded JSON only after the admin gate", () => {
  let boundedCalls = 0;
  for (const route of [...standardRoutes, ...documentRoutes]) {
    const source = readFileSync(
      new URL(`../../app/api/admin/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /\b(?:req|request)\.json\s*\(/,
      `${route} must not use the unbounded Request.json() buffer`,
    );
    const gate = source.indexOf("await requireAdmin()");
    const bounded = source.indexOf("await readAdminJsonRequest(", gate);
    assert.ok(gate >= 0, `${route} must retain requireAdmin`);
    assert.ok(
      bounded > gate,
      `${route} must parse the body only after requireAdmin`,
    );
    boundedCalls += source.match(/await readAdminJsonRequest\(/g)?.length ?? 0;
  }
  assert.equal(boundedCalls, 26);
});

test("document payload routes use the larger evidenced budget and all others stay at 64 KiB", () => {
  assert.equal(ADMIN_JSON_BODY_MAX_BYTES, 64 * 1024);
  assert.equal(ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES, 1024 * 1024);

  for (const route of documentRoutes) {
    const source = readFileSync(
      new URL(`../../app/api/admin/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES/);
  }
  for (const route of standardRoutes) {
    const source = readFileSync(
      new URL(`../../app/api/admin/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES/);
  }
});
