import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isExactOAuthProfileSyncAck,
  matchesOAuthProfileSyncPostcondition,
} from "../../lib/oauth-profile-sync-result.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const expected = {
  userId: USER_ID,
  displayName: "테스터",
  avatarUrl: "https://example.test/avatar.png",
  email: "tester@example.test",
};
const profile = {
  id: USER_ID,
  deleted_at: null,
  display_name: expected.displayName,
  avatar_url: expected.avatarUrl,
};
const member = {
  user_id: USER_ID,
  email: expected.email,
};

test("OAuth profile sync는 exact {ok:true}만 mutation ack로 인정한다", () => {
  assert.equal(isExactOAuthProfileSyncAck({ ok: true }), true);
  for (const malformed of [
    null,
    true,
    {},
    { ok: false },
    { ok: 1 },
    { ok: true, extra: true },
  ]) {
    assert.equal(isExactOAuthProfileSyncAck(malformed), false);
  }
});

test("OAuth profile sync는 active profile/member fresh read가 요청값과 일치해야 한다", () => {
  assert.equal(
    matchesOAuthProfileSyncPostcondition(profile, member, expected),
    true,
  );
  for (const [badProfile, badMember] of [
    [null, member],
    [profile, null],
    [{ ...profile, id: "00000000-0000-4000-8000-000000000002" }, member],
    [{ ...profile, deleted_at: "2026-07-29T00:00:00.000Z" }, member],
    [{ ...profile, display_name: "다른닉네임" }, member],
    [{ ...profile, avatar_url: "https://example.test/other.png" }, member],
    [profile, { ...member, email: "other@example.test" }],
    [profile, { ...member, user_id: "00000000-0000-4000-8000-000000000002" }],
    [{ ...profile, extra: true }, member],
    [profile, { ...member, extra: true }],
  ] as const) {
    assert.equal(
      matchesOAuthProfileSyncPostcondition(
        badProfile,
        badMember,
        expected,
      ),
      false,
    );
  }
});

test("null OAuth fields preserve values but still require a live exact owner row", () => {
  assert.equal(
    matchesOAuthProfileSyncPostcondition(profile, member, {
      userId: USER_ID,
      displayName: null,
      avatarUrl: null,
      email: null,
    }),
    true,
  );
});

test("account-onboard validates ack before two authoritative postreads", () => {
  const source = readFileSync(
    new URL("../../lib/account-onboard.ts", import.meta.url),
    "utf8",
  );
  const ack = source.indexOf("if (!isExactOAuthProfileSyncAck");
  const profileRead = source.indexOf("onboard.profile_sync.profile_verify");
  const memberRead = source.indexOf("onboard.profile_sync.member_verify");
  const verify = source.indexOf("!matchesOAuthProfileSyncPostcondition");
  assert.ok(ack >= 0);
  assert.ok(profileRead > ack);
  assert.ok(memberRead > ack);
  assert.ok(verify > memberRead);
});
