import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { NextRequest } = await import("next/server.js");
const {
  POST,
  SCORE_SUBMISSION_MAX_BODY_BYTES,
} = await import("../../app/api/score/route.ts");

test("score rejects every modeled noncanonical or oversized declaration before auth dependencies", async () => {
  for (const value of [
    String(SCORE_SUBMISSION_MAX_BODY_BYTES + 1),
    "999999999999999999999999999999999999",
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
    const request = new NextRequest(
      "http://localhost:3000/api/score",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": value,
        },
        body: "{}",
      },
    );
    const response = await POST(request);
    assert.equal(response.status, 413, value);
    assert.deepEqual(await response.json(), {
      error: "payload_too_large",
    });
  }
});
