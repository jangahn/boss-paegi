import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedBirefnetOutputUrl,
  parseBirefnetOutput,
} from "../../lib/character-gen/birefnet-contract.ts";

test("BiRefNet output URL permits only lifecycle-controlled private fal CDN v3 objects", () => {
  for (const url of [
    "https://v3b.fal.media/files/b/panda/output.png",
    "https://v3b.fal.media/files/b/tiger/output.png?token=opaque",
  ]) {
    assert.equal(isAllowedBirefnetOutputUrl(url), true, url);
  }
  for (const url of [
    "",
    "relative.png",
    "https://fal.media/files/panda/output.png",
    "https://v3.fal.media/files/tiger/output.png?token=opaque",
    "https://storage.googleapis.com/falserverless/example_outputs/birefnet-output.png",
    "//fal.media/files/output.png",
    "http://fal.media/files/output.png",
    "https://user@fal.media/files/output.png",
    "https://fal.media:444/files/output.png",
    "https://fal.media/files/output.png#fragment",
    "https://fal.media/not-files/output.png",
    "https://evilfal.media/files/output.png",
    "https://fal.media.attacker.example/files/output.png",
    "https://storage.googleapis.com/other-bucket/output.png",
    "https://storage.googleapis.com.evil.example/falserverless/output.png",
    "https://localhost/files/output.png",
    "https://127.0.0.1/files/output.png",
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
  ]) {
    assert.equal(isAllowedBirefnetOutputUrl(url), false, url);
  }
});

test("BiRefNet success requires exact image evidence and safe dimensions", () => {
  const valid = {
    image: {
      url: "https://v3b.fal.media/files/b/panda/output.png",
      width: 1024,
      height: 1024,
      content_type: "image/png",
    },
  };
  assert.deepEqual(parseBirefnetOutput(valid), {
    url: valid.image.url,
    width: 1024,
    height: 1024,
    contentType: "image/png",
  });
  assert.deepEqual(
    parseBirefnetOutput({
      image: {
        url: valid.image.url,
        width: 1,
        height: 8192,
      },
    }),
    {
      url: valid.image.url,
      width: 1,
      height: 8192,
      contentType: null,
    },
  );

  for (const mutation of [
    null,
    [],
    {},
    { image: null },
    { image: [] },
    { image: { ...valid.image, url: "https://localhost/output.png" } },
    { image: { ...valid.image, width: 0 } },
    { image: { ...valid.image, width: 8193 } },
    { image: { ...valid.image, width: 1.5 } },
    { image: { ...valid.image, width: Number.NaN } },
    { image: { ...valid.image, height: 0 } },
    { image: { ...valid.image, height: 8193 } },
    { image: { ...valid.image, content_type: "image/jpeg" } },
    { image: { ...valid.image, content_type: null } },
  ]) {
    assert.equal(parseBirefnetOutput(mutation), null);
  }
});
