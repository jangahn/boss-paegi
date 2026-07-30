import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { NextRequest } = await import("next/server.js");
const {
  CONTENT_REPORT_MAX_BODY_BYTES,
  POST,
} = await import("../../app/api/report/route.ts");

function request(
  body: BodyInit,
  headers: Record<string, string> = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost:3000/api/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

test("public report rejects every modeled noncanonical or oversized declared length before dependencies", async () => {
  for (const value of [
    String(CONTENT_REPORT_MAX_BODY_BYTES + 1),
    "999999999999999999999999999999999999999",
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    "NaN",
    "Infinity",
  ]) {
    const response = await POST(
      request("{}", { "content-length": value }),
    );
    assert.equal(response.status, 413, value);
    assert.deepEqual(await response.json(), {
      error: "payload_too_large",
    });
  }
});

test("public report enforces actual UTF-8 bytes and malformed body contracts", async () => {
  const oversized = await POST(
    request("한".repeat(Math.floor(CONTENT_REPORT_MAX_BODY_BYTES / 3) + 1)),
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: "payload_too_large",
  });

  for (const req of [
    request("{"),
    request(Uint8Array.from([0xc3, 0x28])),
    request("{}", { "content-type": "text/plain" }),
  ]) {
    const response = await POST(req);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_body" });
  }
});
