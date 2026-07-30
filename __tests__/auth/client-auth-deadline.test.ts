import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAbortableFetch } from "../../lib/http/abortable-fetch.ts";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("signal-bound SDK fetch forwards owner cancellation", async () => {
  const owner = new AbortController();
  let observed: AbortSignal | null = null;
  const fetcher = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    observed = init?.signal ?? null;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  const request = createAbortableFetch(owner.signal, fetcher)(
    "https://example.test/auth",
  );
  const expected = new Error("owner_disposed");
  owner.abort(expected);
  await assert.rejects(
    request,
    (error: unknown) => error === expected,
  );
  assert.equal(
    (observed as AbortSignal | null)?.aborted,
    true,
  );
});

test("auth SDK calls are hard-bounded and lifecycle-fenced", () => {
  const client = source("lib/supabase/client.ts");
  const auth = source("lib/auth-client.ts");
  const oauth = source("lib/auth-oauth.ts");
  const login = source("app/login/LoginForm.tsx");

  assert.match(client, /isSingleton: false/);
  assert.match(client, /createAbortableFetch\(signal\)/);

  assert.match(
    auth,
    /runClientMutation\(\{[\s\S]*createClient\(requestSignal\)\.auth\.getSession\(\)/,
  );
  assert.match(
    auth,
    /runClientMutation\(\{[\s\S]*\.auth\.signInAnonymously\(\)/,
  );
  assert.match(auth, /const shared = inflightAnon;[\s\S]*signal,/);

  for (const method of ["getUser", "signInWithOAuth", "signOut"]) {
    assert.match(oauth, new RegExp(`\\.auth\\.${method}\\(`));
  }
  assert.ok((oauth.match(/runClientMutation\(\{/g) ?? []).length >= 4);
  assert.match(oauth, /signal: opts\?\.signal/);
  assert.match(oauth, /if \(opts\?\.signal\?\.aborted\)/);

  assert.match(login, /authAbortRef\.current\?\.abort/);
  assert.match(login, /runClientMutation\(\{/);
  assert.match(login, /\.auth\.signInWithPassword\(/);
  assert.match(login, /signal: controller\.signal/);
  assert.match(login, /login_bfcache_restored/);
});
