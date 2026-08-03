import {
  HIGHLIGHTS_BUCKET,
  DOLLS_BUCKET,
} from "./storage-path.ts";
import {
  isCanonicalStoragePath,
  removeStorageObjects,
  storagePathBatches,
  SupabaseOperationError,
  type StorageExistsResult,
  type StorageRemoveResult,
} from "./supabase-operation.ts";
import { isUuid } from "./upload-write-safety.ts";
import { deletedEmailMarker } from "./oauth-metadata.ts";

export const AVATARS_BUCKET = "avatars";

type AuthScrubbedUser = {
  id: string;
  email?: string | null;
  user_metadata?: unknown;
};
type AuthUserResult = {
  data: { user: AuthScrubbedUser | null } | null;
  error: unknown | null;
};

export type AccountDeleteCleanupDependencies = {
  remove: (
    bucket: string,
    paths: string[],
  ) => PromiseLike<StorageRemoveResult>;
  exists: (
    bucket: string,
    path: string,
  ) => PromiseLike<StorageExistsResult>;
  scrubAuth: (
    userMetadataKeys: readonly string[],
  ) => PromiseLike<AuthUserResult>;
  readAuth: () => PromiseLike<AuthUserResult>;
};

export type AccountDeletionCleanupManifest = {
  dolls: string[];
  highlights: string[];
  avatar: string | null;
};

export type AccountDeletionCleanupTarget = {
  bucket: typeof DOLLS_BUCKET | typeof HIGHLIGHTS_BUCKET | typeof AVATARS_BUCKET;
  path: string;
};

export class AccountDeleteCleanupError extends Error {
  readonly failures: readonly SupabaseOperationError[];

  constructor(failures: readonly SupabaseOperationError[]) {
    super(`account cleanup failed in ${failures.length} operation(s)`);
    this.name = "AccountDeleteCleanupError";
    this.failures = failures;
  }
}

export async function removeAccountDeletionCleanupTargets(
  targets: readonly AccountDeletionCleanupTarget[],
  dependencies: Pick<AccountDeleteCleanupDependencies, "remove" | "exists">,
): Promise<void> {
  const failures: SupabaseOperationError[] = [];
  const byBucket = new Map<string, string[]>();
  for (const target of targets) {
    const paths = byBucket.get(target.bucket) ?? [];
    if (!paths.includes(target.path)) paths.push(target.path);
    byBucket.set(target.bucket, paths);
  }
  for (const [bucket, paths] of byBucket) {
    for (const batch of storagePathBatches(paths)) {
      try {
        await removeStorageObjects(
          "account.cleanup.storage_remove",
          batch,
          (nextPaths) => dependencies.remove(bucket, nextPaths),
          (path) => dependencies.exists(bucket, path),
        );
      } catch (error) {
        failures.push(
          error instanceof SupabaseOperationError
            ? error
            : new SupabaseOperationError(
                "account.cleanup.storage_remove",
                error,
              ),
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new AccountDeleteCleanupError(failures);
  }
}

export async function scrubDeletedAccountAuth(
  userId: string,
  dependencies: Pick<
    AccountDeleteCleanupDependencies,
    "scrubAuth" | "readAuth"
  >,
): Promise<void> {
  const failures: SupabaseOperationError[] = [];
  let metadataKeys: string[] | null = null;
  try {
    const authBefore = await dependencies.readAuth();
    const prepared = authUserMetadataKeys(authBefore, userId);
    if (prepared instanceof Error) {
      failures.push(
        new SupabaseOperationError("auth.user_scrub_prepare", prepared),
      );
    } else {
      metadataKeys = prepared;
    }
  } catch (error) {
    failures.push(
      new SupabaseOperationError("auth.user_scrub_prepare", error),
    );
  }

  try {
    if (metadataKeys !== null) {
      const scrubResult = await dependencies.scrubAuth(metadataKeys);
      const error = validateAuthScrubbedUser(scrubResult, userId);
      if (error) {
        failures.push(new SupabaseOperationError("auth.user_scrub", error));
      }
    }
  } catch (error) {
    failures.push(new SupabaseOperationError("auth.user_scrub", error));
  }

  try {
    const authRead = await dependencies.readAuth();
    const error = validateAuthScrubbedUser(authRead, userId);
    if (error) {
      failures.push(
        new SupabaseOperationError("auth.user_scrub_verify", error),
      );
    }
  } catch (error) {
    failures.push(
      new SupabaseOperationError("auth.user_scrub_verify", error),
    );
  }

  if (failures.length > 0) {
    throw new AccountDeleteCleanupError(failures);
  }
}

export function parseAccountDeletionCleanupManifest(
  value: unknown,
  userId: string,
): AccountDeletionCleanupManifest {
  if (!isUuid(userId)) {
    throw new Error("invalid account cleanup user");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid account cleanup manifest");
  }
  const manifest = value as Record<string, unknown>;
  const stringArray = (field: string): string[] => {
    const candidate = manifest[field];
    if (
      !Array.isArray(candidate) ||
      candidate.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      throw new Error(`invalid account cleanup manifest.${field}`);
    }
    return [...new Set(candidate as string[])];
  };
  const avatar = manifest.avatar;
  if (avatar !== null && typeof avatar !== "string") {
    throw new Error("invalid account cleanup manifest.avatar");
  }
  const parsed = {
    dolls: stringArray("dolls"),
    highlights: stringArray("highlights"),
    avatar,
  };
  assertAccountCleanupPaths({
    userId,
    dollPaths: parsed.dolls,
    highlightPaths: parsed.highlights,
    highlightScoreIds: parsed.highlights.map((path) => path.split("/", 1)[0]),
    avatarPath: parsed.avatar,
  });
  return parsed;
}

function safePathSegments(path: string): string[] {
  if (!isCanonicalStoragePath(path)) {
    throw new Error("invalid account cleanup storage path");
  }
  return path.split("/");
}

function assertAccountCleanupPaths(input: {
  userId: string;
  dollPaths: readonly string[];
  highlightPaths: readonly string[];
  highlightScoreIds: readonly string[];
  avatarPath: string | null;
}): void {
  if (!isUuid(input.userId)) {
    throw new Error("invalid account cleanup user");
  }
  const scoreIds = new Set(input.highlightScoreIds);
  if ([...scoreIds].some((scoreId) => !isUuid(scoreId))) {
    throw new Error("invalid account cleanup score id");
  }
  for (const path of input.dollPaths) {
    const segments = safePathSegments(path);
    const filename = segments[1] ?? "";
    if (
      segments.length !== 2 ||
      segments[0] !== input.userId ||
      !filename.endsWith(".png") ||
      !isUuid(filename.slice(0, -".png".length))
    ) {
      throw new Error("invalid account cleanup doll path");
    }
  }
  for (const path of input.highlightPaths) {
    const segments = safePathSegments(path);
    const filename = segments.at(-1) ?? "";
    const dot = filename.lastIndexOf(".");
    const extension = dot >= 0 ? filename.slice(dot + 1) : "";
    if (
      segments.length !== 2 ||
      !isUuid(segments[0]) ||
      !scoreIds.has(segments[0]) ||
      dot <= 0 ||
      !isUuid(filename.slice(0, dot)) ||
      (extension !== "mp4" && extension !== "webm")
    ) {
      throw new Error("invalid account cleanup highlight path");
    }
  }
  if (input.avatarPath !== null) {
    const segments = safePathSegments(input.avatarPath);
    const filename = segments.at(-1) ?? "";
    const dot = filename.lastIndexOf(".");
    const extension = dot >= 0 ? filename.slice(dot + 1) : "";
    if (
      segments.length < 2 ||
      segments[0] !== input.userId ||
      dot <= 0 ||
      !["png", "jpg", "webp"].includes(extension)
    ) {
      throw new Error("invalid account cleanup avatar path");
    }
  }
}

function validateAuthScrubbedUser(
  result: AuthUserResult,
  userId: string,
): Error | null {
  if (result.error != null) {
    return result.error instanceof Error
      ? result.error
      : new Error("auth_user_scrub_dependency_error");
  }
  const user = result.data?.user;
  if (
    !user ||
    user.id !== userId ||
    user.email !== deletedEmailMarker(userId) ||
    !user.user_metadata ||
    typeof user.user_metadata !== "object" ||
    Array.isArray(user.user_metadata) ||
    Object.keys(user.user_metadata as Record<string, unknown>).length !== 0
  ) {
    return new Error("auth_user_scrub_postcondition_failed");
  }
  return null;
}

function authUserMetadataKeys(
  result: AuthUserResult,
  userId: string,
): string[] | Error {
  if (result.error != null) {
    return result.error instanceof Error
      ? result.error
      : new Error("auth_user_scrub_dependency_error");
  }
  const user = result.data?.user;
  if (
    !user ||
    user.id !== userId ||
    !user.user_metadata ||
    typeof user.user_metadata !== "object" ||
    Array.isArray(user.user_metadata)
  ) {
    return new Error("auth_user_scrub_prepare_failed");
  }
  return Object.keys(user.user_metadata as Record<string, unknown>);
}
