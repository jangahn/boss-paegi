import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { NextRequest } = await import("next/server.js");
const { POST } = await import("../../app/api/track/route.ts");

function request(
  body: string,
  headers: Record<string, string> = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      // v1.08 봇 게이트: 기본 정상 UA — 각 케이스가 의도한 계층(경계/원본/파싱)에 도달하게 한다.
      "user-agent": "Mozilla/5.0 (Macintosh; test agent)",
      ...headers,
    },
    body,
  });
}

async function assertDropped(req: InstanceType<typeof NextRequest>) {
  const response = await POST(req);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
}

test("track route drops every oversized or non-canonical declared length before dependencies", async () => {
  for (const declared of [
    "4097",
    "999999999999999999999999999999999999",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "NaN",
  ]) {
    await assertDropped(request("{}", { "content-length": declared }));
  }
});

test("track route enforces UTF-8 bytes even without Content-Length", async () => {
  await assertDropped(request("한".repeat(1366) + "a"));
  await assertDropped(request("😀".repeat(1025)));
});

test("track route cross-origin and malformed JSON drops stay indistinguishable", async () => {
  await assertDropped(
    request('{"kind":"visit","source_scope":"current"}', {
      origin: "https://attacker.example",
    }),
  );
  await assertDropped(request("{"));
});

test("track route drops crawler and missing user agents before any dependency", async () => {
  await assertDropped(
    request('{"kind":"visit","source_scope":"current","source_kind":"direct"}', {
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    }),
  );
  await assertDropped(
    request('{"kind":"visit","source_scope":"current","source_kind":"direct"}', {
      "user-agent": "kakaotalk-scrap/1.0",
    }),
  );
  await assertDropped(
    request('{"kind":"visit","source_scope":"current","source_kind":"direct"}', {
      "user-agent": "",
    }),
  );
});
