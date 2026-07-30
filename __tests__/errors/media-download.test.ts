import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  fetchMediaBlob,
  MediaDownloadError,
} from "../../lib/media-download.ts";

const MEDIA_URL =
  "https://storage.example.test/signed/object?token=secret";
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x10,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);
const WEBM = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3,
  0x01, 0x00, 0x00, 0x00,
]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

function response(
  body: BodyInit,
  type: string,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": type, ...extraHeaders },
  });
}

test("valid video and image media require status, MIME, size, and magic bytes", async () => {
  const mp4 = await fetchMediaBlob(
    MEDIA_URL,
    { kind: "video", maxBytes: 1024 },
    async () => response(MP4, "video/mp4"),
  );
  assert.equal(mp4.type, "video/mp4");
  assert.equal(mp4.extension, "mp4");
  assert.equal(mp4.blob.size, MP4.byteLength);

  const webm = await fetchMediaBlob(
    MEDIA_URL,
    { kind: "video", maxBytes: 1024 },
    async () => response(WEBM, "video/webm; charset=binary"),
  );
  assert.equal(webm.extension, "webm");

  const png = await fetchMediaBlob(
    MEDIA_URL,
    { kind: "image", maxBytes: 1024 },
    async () => response(PNG, "image/png"),
  );
  assert.equal(png.extension, "png");
});

test("HTTP error bodies and 200 JSON/text bodies can never become share files", async () => {
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "video", maxBytes: 1024 },
        async () => response('{"error":"expired"}', "application/json", 403),
      ),
    (error: unknown) =>
      error instanceof MediaDownloadError &&
      error.kind === "http" &&
      error.status === 403,
  );
  for (const type of ["application/json", "text/html", "video/quicktime"]) {
    await assert.rejects(
      () =>
        fetchMediaBlob(
          MEDIA_URL,
          { kind: "video", maxBytes: 1024 },
          async () => response("not video", type),
        ),
      (error: unknown) =>
        error instanceof MediaDownloadError &&
        error.kind === "content_type",
    );
  }
});

test("lying MIME, empty bodies, declared oversize, and actual oversize fail closed", async () => {
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "video", maxBytes: 1024 },
        async () => response("not mp4", "video/mp4"),
      ),
    (error: unknown) =>
      error instanceof MediaDownloadError && error.kind === "signature",
  );
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "video", maxBytes: 1024 },
        async () => response("", "video/mp4"),
      ),
    (error: unknown) =>
      error instanceof MediaDownloadError && error.kind === "empty",
  );
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "video", maxBytes: 8 },
        async () =>
          response(MP4, "video/mp4", 200, {
            "content-length": String(MP4.byteLength),
          }),
      ),
    (error: unknown) =>
      error instanceof MediaDownloadError && error.kind === "too_large",
  );
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "video", maxBytes: 8 },
        async () => response(MP4, "video/mp4"),
      ),
    (error: unknown) =>
      error instanceof MediaDownloadError && error.kind === "too_large",
  );

  for (const declared of [
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    "NaN",
    "Infinity",
    "999999999999999999999999999999999999999999",
  ]) {
    await assert.rejects(
      () =>
        fetchMediaBlob(
          MEDIA_URL,
          { kind: "video", maxBytes: 1024 },
          async () =>
            response(MP4, "video/mp4", 200, {
              "content-length": declared,
            }),
        ),
      (error: unknown) =>
        error instanceof MediaDownloadError && error.kind === "too_large",
      declared,
    );
  }
});

test("chunked media is cancelled at the first byte beyond the cap", async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(PNG.slice(0, 4));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "image", maxBytes: 8 },
        async () =>
          ({
            ok: true,
            status: 200,
            url: MEDIA_URL,
            headers: new Headers({ "content-type": "image/png" }),
            body,
          }) as Response,
      ),
    (error: unknown) =>
      error instanceof MediaDownloadError && error.kind === "too_large",
  );
  assert.equal(cancelled, true);
  assert.equal(pulls <= 4, true);
});

test("invalid URLs and transport failures remain failures", async () => {
  for (const url of [
    "",
    "relative/path",
    "data:video/mp4;base64,AAAA",
    "https://user:password@example.test/file",
  ]) {
    await assert.rejects(
      () =>
        fetchMediaBlob(
          url,
          { kind: "video", maxBytes: 1024 },
          async () => response(MP4, "video/mp4"),
        ),
      (error: unknown) =>
        error instanceof MediaDownloadError && error.kind === "invalid_url",
    );
  }
  await assert.rejects(
    () =>
      fetchMediaBlob(
        MEDIA_URL,
        { kind: "video", maxBytes: 1024 },
        async () => {
          throw new Error("transport failed");
        },
      ),
    /transport failed/,
  );
});

test("all share-file surfaces use strict media download instead of raw response blobs", () => {
  for (const file of [
    "../../components/HighlightPlayer.tsx",
    "../../components/ShareReportButton.tsx",
    "../../lib/doll-share.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /fetchMediaBlob\(/, file);
    assert.doesNotMatch(source, /await (?:res|r)\.blob\(\)/, file);
  }
});

test("server OG image surfaces also use bounded, typed media downloads", () => {
  for (const file of [
    "../../app/doll/[id]/opengraph-image.tsx",
    "../../app/share/[scoreId]/opengraph-image.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /fetchMediaBlob\(/, file);
    assert.match(source, /OG_DOLL_IMAGE_DOWNLOAD_MAX_BYTES/, file);
    assert.match(source, /redirect:\s*"error"/, file);
    assert.doesNotMatch(source, /await (?:r|res)\.arrayBuffer\(\)/, file);
  }
});
