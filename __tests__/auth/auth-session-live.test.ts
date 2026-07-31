import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  readCurrentAuthSessionState,
} from "../../lib/auth-session-live.ts";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/0093_oauth_flow_intents.sql",
    import.meta.url,
  ),
  "utf8",
);

test("current Auth session state accepts only exact boolean RPC evidence", async () => {
  assert.deepEqual(
    await readCurrentAuthSessionState(async () => ({
      data: true,
      error: null,
    })),
    { kind: "live" },
  );
  assert.deepEqual(
    await readCurrentAuthSessionState(async () => ({
      data: false,
      error: null,
    })),
    { kind: "revoked" },
  );

  for (const data of [null, 0, 1, "true", {}, []]) {
    const state = await readCurrentAuthSessionState(async () => ({
      data,
      error: null,
    }));
    assert.equal(state.kind, "unavailable");
  }

  const resolvedError = new Error("rpc unavailable");
  assert.deepEqual(
    await readCurrentAuthSessionState(async () => ({
      data: true,
      error: resolvedError,
    })),
    { kind: "unavailable", error: resolvedError },
  );
  const thrownError = new Error("transport unavailable");
  assert.deepEqual(
    await readCurrentAuthSessionState(async () => {
      throw thrownError;
    }),
    { kind: "unavailable", error: thrownError },
  );
});

test("private browser policies require a live JWT session row and reject tombstoned IDs", () => {
  const helper = migration.match(
    /create or replace function\s+public\.oauth_current_auth_session_live\(\)[\s\S]*?\$\$([\s\S]*?)\$\$;/u,
  )?.[1];
  assert.ok(helper);
  assert.match(
    helper,
    /v_session_id_text !~[\s\S]*v_session_id := v_session_id_text::uuid/u,
  );
  assert.match(helper, /auth_session\.id = v_session_id/u);
  assert.match(helper, /auth_session\.user_id = v_user_id/u);
  assert.match(
    helper,
    /oauth_auth_session_id_tombstones[\s\S]*tombstone\.session_id = v_session_id/u,
  );

  for (const policy of [
    "dolls: owner read",
    "member_accounts: self read",
    "profiles: self update",
    "user_badges: self read",
  ]) {
    const escaped = policy.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const body = migration.match(
      new RegExp(
        `create policy "${escaped}"[\\s\\S]*?(?=\\n(?:create|drop|alter|revoke|grant|--)|$)`,
        "u",
      ),
    )?.[0];
    assert.ok(body, `${policy} must exist`);
    assert.match(
      body,
      /oauth_current_(?:auth_session_live|badge_owner_readable)\(\)/u,
      `${policy} must reject a deleted JWT session`,
    );
  }
});

test("all shared server identity gates recheck DB session existence after getUser", () => {
  for (const relativePath of [
    "../../lib/auth-server.ts",
    "../../lib/supabase/middleware.ts",
    "../../app/consent/page.tsx",
    "../../app/credits/page.tsx",
    "../../app/api/telemetry/route.ts",
    "../../app/api/report/route.ts",
    "../../app/api/track/route.ts",
  ]) {
    const source = readFileSync(
      new URL(relativePath, import.meta.url),
      "utf8",
    );
    assert.match(source, /auth\.getUser\(\)/u, relativePath);
    assert.match(
      source,
      /oauth_current_auth_session_live/u,
      relativePath,
    );
  }
});
