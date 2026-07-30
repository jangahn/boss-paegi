export type StrictProfileSelf = {
  id: string;
  display_name: string;
  avatar_url: string | null;
};

export type StrictProfileMember = {
  gen_credits: number;
  is_admin: boolean;
};

export class InvalidProfileReadError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidProfileReadError";
  }
}

const PROFILE_NAME_MAX = 12;
const AVATAR_URL_MAX = 2048;

function validAvatarUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > AVATAR_URL_MAX) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function parseProfileSelf(
  value: unknown,
  expectedUserId: string,
): StrictProfileSelf {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidProfileReadError("invalid_profile_self");
  }
  const row = value as Record<string, unknown>;
  if (
    row.id !== expectedUserId ||
    typeof row.display_name !== "string" ||
    row.display_name.length === 0 ||
    row.display_name.length > PROFILE_NAME_MAX ||
    row.display_name !== row.display_name.trim() ||
    !validAvatarUrl(row.avatar_url)
  ) {
    throw new InvalidProfileReadError("invalid_profile_self");
  }
  return {
    id: row.id,
    display_name: row.display_name,
    avatar_url: row.avatar_url as string | null,
  };
}

export function parseProfileMember(value: unknown): StrictProfileMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidProfileReadError("invalid_profile_member");
  }
  const row = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.gen_credits) ||
    (row.gen_credits as number) < 0 ||
    typeof row.is_admin !== "boolean"
  ) {
    throw new InvalidProfileReadError("invalid_profile_member");
  }
  return {
    gen_credits: row.gen_credits as number,
    is_admin: row.is_admin,
  };
}

/** UPDATE ... select acknowledgement: zero/multi/mismatched rows are not a commit proof. */
export function isExactNicknameMutationRow(
  value: unknown,
  expectedUserId: string,
  expectedName: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  return (
    keys.length === 2 &&
    keys.includes("id") &&
    keys.includes("display_name") &&
    row.id === expectedUserId &&
    row.display_name === expectedName
  );
}
