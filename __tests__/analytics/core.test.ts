import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_SOURCE,
  MAX_TOKEN_LEN,
  SHARE_TARGETS,
  SURFACES,
  buildConversionRow,
  normalizeSource,
  normalizeToken,
  sanitizeTrackPayload,
} from "../../lib/analytics/core.ts";
import {
  TRACK_BODY_MAX_BYTES,
  readTrackJsonRequest,
  trackBodyBytesAllowed,
  trackContentLengthAllowed,
} from "../../lib/analytics/request-boundary.ts";

function trackRequestSurface(chunks: Uint8Array[]) {
  let index = 0;
  return {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]!);
      },
    }),
  };
}

test("analytics token normalization covers every ASCII code point and length edge", () => {
  for (let code = 0; code <= 127; code += 1) {
    const input = String.fromCharCode(code);
    const normalized = normalizeToken(input);
    const lower = input.toLowerCase();
    const expected = /^[a-z0-9._-]$/.test(lower) ? lower : null;
    assert.equal(normalized, expected, `ASCII ${code}`);
  }

  assert.equal(normalizeToken(" A-Z_09.example "), "a-z_09.example");
  assert.equal(normalizeToken("a".repeat(MAX_TOKEN_LEN)), "a".repeat(MAX_TOKEN_LEN));
  assert.equal(normalizeToken("a".repeat(MAX_TOKEN_LEN + 1)), null);
  for (const value of [
    "",
    "   ",
    "person@example.com",
    "person%40example.com",
    "host/path",
    "utm?x",
    "a&b",
    "a=b",
    "한글",
    null,
    undefined,
    1,
    {},
  ]) {
    assert.equal(normalizeToken(value), null, String(value));
  }
});

test("analytics request parsing preserves UTF-8 across every byte split", async () => {
  const bytes = new TextEncoder().encode('{"한":"😀"}');
  for (let split = 0; split <= bytes.byteLength; split += 1) {
    assert.deepEqual(
      await readTrackJsonRequest(
        trackRequestSurface([
          bytes.slice(0, split),
          bytes.slice(split),
        ]),
      ),
      { 한: "😀" },
    );
  }
  assert.equal(
    await readTrackJsonRequest(
      trackRequestSurface([Uint8Array.of(0xc3, 0x28)]),
    ),
    null,
  );
  assert.equal(
    await readTrackJsonRequest(
      trackRequestSurface([
        new Uint8Array(TRACK_BODY_MAX_BYTES + 1),
      ]),
    ),
    null,
  );
});

test("every source kind either canonicalizes exactly or becomes direct", () => {
  const valid = {
    direct: DIRECT_SOURCE,
    utm: {
      source_kind: "utm",
      source_value: "naver",
      referrer_domain: null,
      utm_source: "naver",
      utm_medium: "social",
      utm_campaign: "summer",
      viral_type: null,
    },
    referrer: {
      source_kind: "referrer",
      source_value: "m.example.com",
      referrer_domain: "m.example.com",
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      viral_type: null,
    },
    viralScore: {
      source_kind: "viral",
      source_value: "score",
      referrer_domain: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      viral_type: "score",
    },
    viralDoll: {
      source_kind: "viral",
      source_value: "doll",
      referrer_domain: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      viral_type: "doll",
    },
  } as const;

  assert.deepEqual(normalizeSource({ source_kind: "direct" }), valid.direct);
  assert.deepEqual(
    normalizeSource({
      source_kind: "utm",
      utm_source: " NAVER ",
      utm_medium: " Social ",
      utm_campaign: " SUMMER ",
      referrer_domain: "must-be-cleared.example",
      viral_type: "score",
    }),
    valid.utm,
  );
  assert.deepEqual(
    normalizeSource({
      source_kind: "referrer",
      referrer_domain: " M.Example.Com ",
      utm_source: "must-be-cleared",
      viral_type: "score",
    }),
    valid.referrer,
  );
  assert.deepEqual(
    normalizeSource({
      source_kind: "viral",
      viral_type: "score",
      utm_source: "must-be-cleared",
      referrer_domain: "must-be-cleared.example",
    }),
    valid.viralScore,
  );
  assert.deepEqual(
    normalizeSource({ source_kind: "viral", viral_type: "doll" }),
    valid.viralDoll,
  );

  for (const value of [
    null,
    undefined,
    {},
    { source_kind: "unknown" },
    { source_kind: "utm", utm_source: "person@example.com" },
    { source_kind: "referrer", referrer_domain: "host/path" },
    { source_kind: "viral", viral_type: "unknown" },
  ]) {
    assert.deepEqual(normalizeSource(value), DIRECT_SOURCE);
  }
});

test("visit sanitizer covers every scope and source validity combination", () => {
  const scopes = ["current", "first_touch", null, "", "unknown"] as const;
  const sources = [
    { source_kind: "direct" },
    { source_kind: "utm", utm_source: "naver" },
    { source_kind: "utm", utm_source: "person@example.com" },
    { source_kind: "referrer", referrer_domain: "m.example.com" },
    { source_kind: "viral", viral_type: "score" },
    { source_kind: "viral", viral_type: "unknown" },
  ] as const;

  for (const source_scope of scopes) {
    for (const source of sources) {
      const actual = sanitizeTrackPayload({
        kind: "visit",
        source_scope,
        ...source,
        ignored: "not-persisted",
      });
      if (source_scope !== "current" && source_scope !== "first_touch") {
        assert.equal(actual, null, JSON.stringify({ source_scope, source }));
      } else {
        assert.deepEqual(actual, {
          kind: "visit",
          source_scope,
          ...normalizeSource(source),
        });
      }
    }
  }
});

test("share sanitizer covers the full surface/target/tier Cartesian product", () => {
  const surfaces = [...SURFACES, "unknown", null] as const;
  const targets = [...SHARE_TARGETS, "unknown", null] as const;
  const tiers = [
    -1,
    ...Array.from({ length: 11 }, (_, i) => i),
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    null,
  ] as const;

  for (const surface of surfaces) {
    for (const target of targets) {
      for (const score_tier of tiers) {
        const actual = sanitizeTrackPayload({
          kind: "share",
          surface,
          target,
          score_tier,
          result: "forged",
          ignored: "not-persisted",
        });
        if (!SURFACES.includes(surface as never) || !SHARE_TARGETS.includes(target as never)) {
          assert.equal(actual, null, JSON.stringify({ surface, target, score_tier }));
          continue;
        }
        const expectedTier =
          target === "score" &&
          typeof score_tier === "number" &&
          Number.isInteger(score_tier) &&
          score_tier >= 0 &&
          score_tier <= 9
            ? score_tier
            : null;
        assert.deepEqual(actual, {
          kind: "share",
          surface,
          target,
          score_tier: expectedTier,
          result: "attempt",
        });
      }
    }
  }

  for (const value of [
    null,
    [],
    {},
    { kind: "conversion" },
    { kind: "unknown" },
  ]) {
    assert.equal(sanitizeTrackPayload(value), null);
  }
});

test("conversion builder is canonical for both steps and hostile source input", () => {
  for (const conversion_step of ["play", "signup"] as const) {
    assert.deepEqual(
      buildConversionRow(conversion_step, {
        source_kind: "utm",
        utm_source: " NAVER ",
        referrer_domain: "must-be-cleared.example",
      }),
      {
        kind: "conversion",
        conversion_step,
        source_scope: "first_touch",
        source_kind: "utm",
        source_value: "naver",
        referrer_domain: null,
        utm_source: "naver",
        utm_medium: null,
        utm_campaign: null,
        viral_type: null,
      },
    );
    assert.deepEqual(
      buildConversionRow(conversion_step, {
        source_kind: "utm",
        utm_source: "person@example.com",
      }),
      {
        kind: "conversion",
        conversion_step,
        source_scope: "first_touch",
        ...DIRECT_SOURCE,
      },
    );
  }
});

test("public track body limit is exact in declared bytes and UTF-8 bytes", () => {
  for (const value of [
    null,
    "0",
    "1",
    String(TRACK_BODY_MAX_BYTES - 1),
    String(TRACK_BODY_MAX_BYTES),
  ]) {
    assert.equal(trackContentLengthAllowed(value), true, String(value));
  }
  for (const value of [
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    " 1",
    "1 ",
    "NaN",
    "Infinity",
    String(TRACK_BODY_MAX_BYTES + 1),
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.equal(trackContentLengthAllowed(value), false, value);
  }

  const cases = [
    { unit: "a", bytes: 1 },
    { unit: "한", bytes: 3 },
    { unit: "😀", bytes: 4 },
  ];
  for (const { unit, bytes } of cases) {
    const exact = unit.repeat(Math.floor(TRACK_BODY_MAX_BYTES / bytes));
    assert.equal(Buffer.byteLength(exact, "utf8") <= TRACK_BODY_MAX_BYTES, true);
    assert.equal(trackBodyBytesAllowed(exact), true, unit);
    assert.equal(trackBodyBytesAllowed(exact + unit), false, unit);
  }
});
