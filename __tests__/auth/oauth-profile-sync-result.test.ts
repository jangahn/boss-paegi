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

test("OAuth profile sync는 live exact 행 + email 하드싱크만 요구한다", () => {
  assert.equal(
    matchesOAuthProfileSyncPostcondition(profile, member, expected),
    true,
  );
  // 0103: 기존 회원 sync 는 닉네임·프사를 덮어쓰지 않으므로, 사용자 커스터마이징이
  // 남아 있는 fresh read(요청값과 다른 display_name/avatar_url)는 정상이다.
  assert.equal(
    matchesOAuthProfileSyncPostcondition(
      { ...profile, display_name: "다른닉네임" },
      member,
      expected,
    ),
    true,
  );
  assert.equal(
    matchesOAuthProfileSyncPostcondition(
      { ...profile, avatar_url: "https://example.test/other.png" },
      member,
      expected,
    ),
    true,
  );
  assert.equal(
    matchesOAuthProfileSyncPostcondition(
      { ...profile, avatar_url: null },
      member,
      expected,
    ),
    true,
  );
  for (const [badProfile, badMember] of [
    [null, member],
    [profile, null],
    [{ ...profile, id: "00000000-0000-4000-8000-000000000002" }, member],
    [{ ...profile, deleted_at: "2026-07-29T00:00:00.000Z" }, member],
    [{ ...profile, display_name: "" }, member],
    [{ ...profile, display_name: "  " }, member],
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

test("탈퇴 스크럽 플레이스홀더는 OAuth 이름이 있으면 sync 후 남아 있을 수 없다", () => {
  const scrubbed = { ...profile, display_name: "탈퇴한 사용자" };
  // 재활성 계정 재시드가 안 된 fresh read = postcondition 위반.
  assert.equal(
    matchesOAuthProfileSyncPostcondition(scrubbed, member, expected),
    false,
  );
  // OAuth 이름이 없으면 재시드가 불가능하므로 플레이스홀더 잔존은 허용.
  assert.equal(
    matchesOAuthProfileSyncPostcondition(scrubbed, member, {
      ...expected,
      displayName: null,
    }),
    true,
  );
  // OAuth 이름 자체가 플레이스홀더 문자열인 병리 케이스는 위반으로 보지 않는다.
  assert.equal(
    matchesOAuthProfileSyncPostcondition(scrubbed, member, {
      ...expected,
      displayName: "탈퇴한 사용자",
    }),
    true,
  );
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
