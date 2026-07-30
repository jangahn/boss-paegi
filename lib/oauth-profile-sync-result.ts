export type OAuthProfileSyncExpectation = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
};

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

export function isExactOAuthProfileSyncAck(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactKeys(value as Record<string, unknown>, ["ok"]) &&
    (value as { ok?: unknown }).ok === true
  );
}

export function matchesOAuthProfileSyncPostcondition(
  profileValue: unknown,
  memberValue: unknown,
  expected: OAuthProfileSyncExpectation,
): boolean {
  if (
    !profileValue ||
    typeof profileValue !== "object" ||
    Array.isArray(profileValue) ||
    !memberValue ||
    typeof memberValue !== "object" ||
    Array.isArray(memberValue)
  ) {
    return false;
  }
  const profile = profileValue as Record<string, unknown>;
  const member = memberValue as Record<string, unknown>;
  if (
    !exactKeys(profile, [
      "id",
      "deleted_at",
      "display_name",
      "avatar_url",
    ]) ||
    !exactKeys(member, ["user_id", "email"]) ||
    profile.id !== expected.userId ||
    profile.deleted_at !== null ||
    typeof profile.display_name !== "string" ||
    (profile.avatar_url !== null && typeof profile.avatar_url !== "string") ||
    member.user_id !== expected.userId ||
    (member.email !== null && typeof member.email !== "string")
  ) {
    return false;
  }
  if (
    expected.displayName !== null &&
    profile.display_name !== expected.displayName
  ) {
    return false;
  }
  if (expected.avatarUrl !== null && profile.avatar_url !== expected.avatarUrl) {
    return false;
  }
  if (expected.email !== null && member.email !== expected.email) {
    return false;
  }
  return true;
}
