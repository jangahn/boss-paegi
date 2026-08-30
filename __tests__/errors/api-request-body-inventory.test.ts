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
const oauthFlowRoot = fileURLToPath(
  new URL("../../app/api/auth/oauth-flow/", import.meta.url),
);

const OAUTH_FLOW_ROUTES = [
  "abandon/route.ts",
  "bind-target/route.ts",
  "cancel/route.ts",
  "complete-signout/route.ts",
  "expire/route.ts",
  "finalize/route.ts",
  "preflight/route.ts",
  "release/route.ts",
  "revoke-bound-target/route.ts",
  "rotate-target/route.ts",
  "signout/route.ts",
  "status/route.ts",
] as const;

const DIRECT_DEFAULT_LIMIT_OAUTH_FLOW_ROUTES =
  OAUTH_FLOW_ROUTES.filter(
    (route) =>
      route !== "bind-target/route.ts" &&
      route !== "signout/route.ts",
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
  assert.equal(files.length, 69, "the complete API route inventory changed");
  for (const addedWebhook of [
    "/fal/face-webhook/route.ts",
    "/fal/pick-webhook/route.ts",
    "/ops/privacy-maintain/route.ts",
  ]) {
    assert.ok(
      files.some((file) => file.endsWith(addedWebhook)),
      `${addedWebhook} must remain in the bounded-body inventory`,
    );
  }

  const oauthFlowRoutes = routeFiles(oauthFlowRoot)
    .map((file) => file.slice(oauthFlowRoot.length + 1))
    .sort();
  assert.deepEqual(
    oauthFlowRoutes,
    [...OAUTH_FLOW_ROUTES].sort(),
    "every OAuth flow mutation/status route must remain in this security inventory",
  );

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:req|request)\.(?:json|text|arrayBuffer|blob|formData)\s*\(/,
      file,
    );
  }
});

test("all direct OAuth flow routes read one bounded object before parsing or admin work", () => {
  for (const route of DIRECT_DEFAULT_LIMIT_OAUTH_FLOW_ROUTES) {
    const file = `${oauthFlowRoot}/${route}`;
    const source = readFileSync(file, "utf8");
    const reader =
      /const body = await readApiJsonObjectRequest\(\s*request\s*\);/gu;
    assert.equal(
      source.match(reader)?.length ?? 0,
      1,
      `${route} must use exactly one default bounded JSON-object read`,
    );
    const bodyRead = source.search(reader);
    const bodyUse = source.indexOf("body.value", bodyRead);
    const invalidBody = source.indexOf('"invalid_body"', bodyUse);
    const privilegedBoundary = [
      "readOAuthFlowRouteAuthority({",
      "discoverOAuthFlowRouteAuthority({",
      "readOAuthFlowStatusStrict(",
      "createAdminClient()",
      "cancelForProvider(",
    ]
      .map((needle) => source.indexOf(needle, invalidBody + 1))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    assert.ok(bodyRead >= 0, `${route} has no bounded body read`);
    assert.ok(
      bodyUse > bodyRead,
      `${route} must not parse input before the bounded body read`,
    );
    assert.ok(
      invalidBody > bodyUse,
      `${route} must fail closed after parsing a malformed body`,
    );
    assert.ok(
      privilegedBoundary > invalidBody,
      `${route} must reject malformed bodies before authority or privileged work`,
    );
  }
});

test("OAuth bind-target keeps its explicit 132 KiB proof envelope cap", () => {
  const source = readFileSync(
    `${oauthFlowRoot}/bind-target/route.ts`,
    "utf8",
  );
  assert.match(
    source,
    /const BIND_TARGET_MAX_BODY_BYTES = 132 \* 1024;/u,
  );
  const reader =
    /const body = await readApiJsonObjectRequest\(\s*request,\s*BIND_TARGET_MAX_BODY_BYTES,\s*\);/gu;
  assert.equal(source.match(reader)?.length ?? 0, 1);
  const bodyRead = source.search(reader);
  const bodyUse = source.indexOf("body.value", bodyRead);
  const adminUse = source.indexOf("createAdminClient()", bodyRead);
  assert.ok(bodyUse > bodyRead);
  assert.ok(adminUse > bodyUse);
  assert.doesNotMatch(
    source,
    /readApiJsonObjectRequest\(\s*request\s*\)/u,
    "bind-target must not silently fall back to the default cap",
  );
});

test("OAuth signout delegates once to the shared bounded ordinary/OAuth handler", () => {
  const oauthSource = readFileSync(
    `${oauthFlowRoot}/signout/route.ts`,
    "utf8",
  );
  const sharedSource = readFileSync(
    `${apiRoot}/auth/signout/route.ts`,
    "utf8",
  );

  assert.match(
    oauthSource,
    /return handleSignoutRequest\(request, "oauth"\);/u,
  );
  assert.equal(
    oauthSource.match(/handleSignoutRequest\(request, "oauth"\)/gu)
      ?.length ?? 0,
    1,
  );
  assert.doesNotMatch(
    oauthSource,
    /\b(?:req|request)\.(?:json|text|arrayBuffer|blob|formData)\s*\(/u,
  );

  const reader =
    /const body = await readApiJsonObjectRequest\(\s*request\s*\);/gu;
  assert.equal(sharedSource.match(reader)?.length ?? 0, 1);
  const bodyRead = sharedSource.search(reader);
  const parse = sharedSource.indexOf("parseInput(body.value)", bodyRead);
  const adminUse = sharedSource.indexOf("createAdminClient()", bodyRead);
  assert.ok(parse > bodyRead);
  assert.ok(adminUse > parse);
  assert.match(
    sharedSource,
    /mode: "ordinary" \| "oauth"/u,
    "the shared parser must retain an explicit closed mode union",
  );
});
