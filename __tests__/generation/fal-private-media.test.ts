import assert from "node:assert/strict";
import test from "node:test";

import {
  FAL_CDN_TOKEN_TTL_SECONDS,
  fetchPrivateFalMediaBlob,
} from "../../lib/character-gen/fal-private-media.ts";

const PRIVATE_URL =
  "https://v3b.fal.media/files/b/private-store/output.png";
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

test("private fal output is read only with a short-lived owner token", async () => {
  let tokenCalls = 0;
  let mediaCalls = 0;
  const downloaded = await fetchPrivateFalMediaBlob({
    url: PRIVATE_URL,
    credentials: "fal-secret",
    kind: "image",
    maxBytes: 1024,
    tokenFetchImpl: (async (input, init) => {
      tokenCalls += 1;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://rest.fal.ai");
      assert.equal(url.pathname, "/storage/auth/token");
      assert.equal(url.searchParams.get("storage_type"), "fal-cdn-v3");
      assert.equal(new Headers(init?.headers).get("authorization"), "Key fal-secret");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        expiration_seconds: FAL_CDN_TOKEN_TTL_SECONDS,
      });
      return Response.json({ token: "owner-token" });
    }) as typeof fetch,
    mediaFetchImpl: (async (input, init) => {
      mediaCalls += 1;
      assert.equal(String(input), PRIVATE_URL);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer owner-token",
      );
      assert.equal(init?.redirect, "error");
      return new Response(PNG, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(PNG.byteLength),
        },
      });
    }) as typeof fetch,
  });
  assert.equal(tokenCalls, 1);
  assert.equal(mediaCalls, 1);
  assert.equal(downloaded.type, "image/png");
  assert.equal(downloaded.blob.size, PNG.byteLength);
});

test("legacy public/provider fallback URLs are rejected before credentials move", async () => {
  for (const url of [
    "https://fal.media/files/output.png",
    "https://v3.fal.media/files/output.png",
    "https://storage.googleapis.com/falserverless/output.png",
    "https://v3b.fal.media/files/not-bucket/output.png",
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchPrivateFalMediaBlob({
        url,
        credentials: "fal-secret",
        kind: "image",
        maxBytes: 1024,
        tokenFetchImpl: (async () => {
          calls += 1;
          return Response.json({ token: "must-not-be-used" });
        }) as typeof fetch,
      }),
      /fal_private_media_url_invalid/,
    );
    assert.equal(calls, 0, url);
  }
});

test("token responses are bounded and fail closed", async () => {
  for (const response of [
    new Response("{}", { status: 200 }),
    new Response("{", { status: 200 }),
    new Response("", { status: 503 }),
  ]) {
    await assert.rejects(
      fetchPrivateFalMediaBlob({
        url: PRIVATE_URL,
        credentials: "fal-secret",
        kind: "image",
        maxBytes: 1024,
        tokenFetchImpl: (async () => response) as typeof fetch,
      }),
    );
  }
});
