import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveStorageSigningResult,
  StorageSigningError,
} from "../../lib/storage-signing-result.ts";

test("storage signing returns null only for an authoritatively absent source", () => {
  assert.equal(
    resolveStorageSigningResult("sign", null, undefined),
    null,
  );
  assert.equal(
    resolveStorageSigningResult("sign", undefined, undefined),
    null,
  );
  assert.equal(
    resolveStorageSigningResult("sign", "owner/doll.png", {
      data: { signedUrl: "https://storage.example.test/object?token=x" },
      error: null,
    }),
    "https://storage.example.test/object?token=x",
  );
});

test("present storage objects fail closed on thrown-equivalent, resolved, and malformed signing acks", () => {
  for (const [source, result] of [
    ["owner/doll.png", { data: null, error: new Error("storage down") }],
    ["owner/doll.png", { data: null, error: null }],
    ["owner/doll.png", { data: { signedUrl: "" }, error: null }],
    [
      "owner/doll.png",
      { data: { signedUrl: "javascript:alert(1)" }, error: null },
    ],
    ["", { data: { signedUrl: "https://example.test" }, error: null }],
    [" padded ", { data: { signedUrl: "https://example.test" }, error: null }],
  ] as const) {
    assert.throws(
      () => resolveStorageSigningResult("sign", source, result),
      StorageSigningError,
    );
  }
});

test("server signing consumers never substitute a raw private path after dependency failure", () => {
  const storage = readFileSync(
    new URL("../../lib/storage.ts", import.meta.url),
    "utf8",
  );
  const pending = readFileSync(
    new URL("../../app/api/generations/route.ts", import.meta.url),
    "utf8",
  );
  const users = readFileSync(
    new URL("../../lib/admin-users.ts", import.meta.url),
    "utf8",
  );
  const dollPage = readFileSync(
    new URL("../../app/doll/[id]/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(storage, /resolveStorageSigningResult/);
  assert.doesNotMatch(storage, /return error \? null/);
  assert.doesNotMatch(pending, /signedDollUrl\(u, 21600\)\s*\?\? u/);
  assert.doesNotMatch(
    users,
    /signedDollUrl\(d\.image_url[^\n]+\?\? d\.image_url/,
  );
  assert.doesNotMatch(
    dollPage,
    /signedDollUrl\(doll\.image_url[^\n]+\?\? DEFAULT_BOSS/,
  );
});

test("doll and highlight buckets stay private and highlight reads stay signed-only", () => {
  const storage = readFileSync(
    new URL("../../lib/storage.ts", import.meta.url),
    "utf8",
  );
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008901_generation_storage_cost_controls.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const highlightRead = readFileSync(
    new URL("../../lib/score-detail.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /\('highlights',\s*'highlights',\s*false\)/,
  );
  assert.match(
    migration,
    /\('dolls',\s*false\)[\s\S]*expected\(id,\s*is_public\)/,
  );
  assert.match(storage, /\.from\(HIGHLIGHTS_BUCKET\)[\s\S]*\.createSignedUrl\(/);
  assert.doesNotMatch(storage, /\.from\(HIGHLIGHTS_BUCKET\)\.getPublicUrl/);
  assert.match(highlightRead, /signedHighlightUrl\(s\.highlight_clip_path\)/);
});

test("present doll image load failures remain visible instead of impersonating the default boss", () => {
  const fadeImg = readFileSync(
    new URL("../../components/FadeImg.tsx", import.meta.url),
    "utf8",
  );
  const consumers = [
    "../../components/ScoreReport.tsx",
    "../../app/doll/[id]/page.tsx",
    "../../app/share/[scoreId]/page.tsx",
    "../../app/history/[userId]/[scoreId]/page.tsx",
  ].map((relative) =>
    readFileSync(new URL(relative, import.meta.url), "utf8"),
  );

  assert.match(fadeImg, /stage: "primary" \| "fallback"/);
  assert.match(fadeImg, /failure\.stage === "fallback"/);
  assert.match(fadeImg, /role="status"/);
  assert.match(fadeImg, /\{errorText\}/);
  for (const source of consumers) {
    assert.doesNotMatch(
      source,
      /fallbackSrc="\/sprites\/boss-default\.png"/,
    );
    assert.match(
      source,
      /errorText="캐릭터 이미지를 불러오지 못했어요\."/,
    );
  }
});
