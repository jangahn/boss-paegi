import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const apiRoot = fileURLToPath(
  new URL("../../app/api/", import.meta.url),
);

function routeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) files.push(...routeFiles(path));
    else if (name === "route.ts") files.push(path);
  }
  return files;
}

test("every API route consumes request bodies through an explicit bounded reader", () => {
  const files = routeFiles(apiRoot);
  assert.equal(files.length, 58, "the complete API route inventory changed");
  for (const addedWebhook of [
    "/account/generation-provider-acceptance/route.ts",
    "/fal/face-webhook/route.ts",
    "/fal/pick-webhook/route.ts",
    "/ops/privacy-maintain/route.ts",
  ]) {
    assert.ok(
      files.some((file) => file.endsWith(addedWebhook)),
      `${addedWebhook} must remain in the bounded-body inventory`,
    );
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:req|request)\.(?:json|text|arrayBuffer|blob|formData)\s*\(/,
      file,
    );
  }
});
