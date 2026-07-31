import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const supabaseConfig = readFileSync(
  new URL("../../supabase/config.toml", import.meta.url),
  "utf8",
);
const authClient = readFileSync(
  new URL("../../lib/auth-client.ts", import.meta.url),
  "utf8",
);
const supabaseClient = readFileSync(
  new URL("../../lib/supabase/client.ts", import.meta.url),
  "utf8",
);

test("the committed Supabase runtime enables the anonymous identity required by free play", () => {
  assert.match(
    supabaseConfig,
    /^\s*enable_anonymous_sign_ins\s*=\s*true\s*$/m,
  );
  assert.match(
    supabaseConfig,
    /^\s*anonymous_users\s*=\s*(?:[1-9]\d*)\s*$/m,
  );
  assert.match(
    authClient,
    /establishAnonymousAuthSession\([\s\S]*?requestSignal/,
  );
  assert.match(
    supabaseClient,
    /export function establishAnonymousAuthSession\([\s\S]*?auth\.getSession\(\)[\s\S]*?startSupabaseUnlockedSessionWriter\([\s\S]*?auth\.signInAnonymously\(\)[\s\S]*?anonymous_session_commit_mismatch/,
  );
});
