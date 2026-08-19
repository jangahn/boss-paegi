import { SCRUBBED_PROFILE_DISPLAY_NAME } from "./oauth-metadata.ts";

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
  // 0103 이후 기존 회원 sync 는 닉네임·프사를 덮어쓰지 않는다(사용자 커스터마이징 보존,
  // 탈퇴 스크럽 플레이스홀더 재시드만 예외). 그래서 display_name/avatar_url 은 요청값
  // equality 대신 sync 불변식만 검증한다: display_name 은 비어있지 않아야 하고, OAuth
  // 이름이 있으면 플레이스홀더가 남아 있을 수 없다(재시드 보장 — OAuth 이름 자체가
  // 플레이스홀더 문자열인 병리 케이스만 예외). email 은 계속 하드 싱크라 equality 유지.
  if (profile.display_name.trim().length === 0) {
    return false;
  }
  if (
    expected.displayName !== null &&
    expected.displayName !== SCRUBBED_PROFILE_DISPLAY_NAME &&
    profile.display_name === SCRUBBED_PROFILE_DISPLAY_NAME
  ) {
    return false;
  }
  if (expected.email !== null && member.email !== expected.email) {
    return false;
  }
  return true;
}
