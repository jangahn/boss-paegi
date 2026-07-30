import {
  HIGHLIGHTS_BUCKET,
  DOLLS_BUCKET,
} from "./storage-path.ts";
import {
  listStorageObjectsPaginated,
  isCanonicalStoragePath,
  removeStorageObjects,
  storagePathBatches,
  SupabaseOperationError,
  type StorageListOptions,
  type StorageListResult,
  type StorageExistsResult,
  type StorageRemoveResult,
} from "./supabase-operation.ts";
import { isUuid } from "./upload-write-safety.ts";
import { deletedEmailMarker } from "./oauth-metadata.ts";

export const AVATARS_BUCKET = "avatars";

type StorageEntry = { name: string };
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
  list: (
    bucket: string,
    prefix: string,
    options: StorageListOptions,
  ) => PromiseLike<StorageListResult<StorageEntry>>;
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

export type AccountDeleteCleanupInput = {
  userId: string;
  dollPaths: readonly string[];
  highlightPaths: readonly string[];
  /** 탈퇴 계정 소유 score 전체. signed-upload token의 score prefix 최종 sweep용. */
  highlightScoreIds: readonly string[];
  avatarPath: string | null;
  dependencies: AccountDeleteCleanupDependencies;
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

/**
 * profiles.avatar_url 중 이 사용자가 avatars 버킷에 직접 업로드한 객체만 추출한다.
 * OAuth provider 외부 URL과 기본 이미지 경로는 null로 남겨 외부/공용 자산을 건드리지 않는다.
 */
export function uploadedAvatarPath(
  avatarUrl: string | null | undefined,
  userId: string,
): string | null {
  if (!avatarUrl) return null;
  let value = avatarUrl.trim();
  if (!value) return null;

  const marker = `/${AVATARS_BUCKET}/`;
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex >= 0) {
    value = value.slice(markerIndex + marker.length);
  } else if (value.includes("://")) {
    return null;
  }

  const suffixIndex = value.search(/[?#]/);
  if (suffixIndex >= 0) value = value.slice(0, suffixIndex);
  if (!value.startsWith(`${userId}/`)) return null;

  const filename = value.slice(userId.length + 1);
  const segments = filename.split("/");
  if (
    !filename ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return value;
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

function isSafeStorageListName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
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

/**
 * DB soft-delete 뒤 실행하는 외부 개인정보 정리.
 *
 * 각 단계는 서로 독립적으로 끝까지 시도하고 실패를 모아 throw한다. 한 객체 삭제가
 * 실패했다고 나머지 얼굴/아바타/auth 식별정보 정리를 포기하지 않되, 호출자는 모든
 * 실패가 없을 때만 성공 응답과 성공 로그를 내보낼 수 있다.
 */
export async function cleanupDeletedAccountAssets(
  input: AccountDeleteCleanupInput,
): Promise<void> {
  const {
    userId,
    dollPaths,
    highlightPaths,
    highlightScoreIds,
    avatarPath,
    dependencies,
  } = input;
  const failures: SupabaseOperationError[] = [];
  try {
    assertAccountCleanupPaths({
      userId,
      dollPaths,
      highlightPaths,
      highlightScoreIds,
      avatarPath,
    });
  } catch (error) {
    throw new AccountDeleteCleanupError([
      new SupabaseOperationError("account.cleanup.manifest", error),
    ]);
  }

  const remove = async (
    operation: string,
    bucket: string,
    paths: readonly string[],
  ): Promise<void> => {
    for (const batch of storagePathBatches(paths)) {
      try {
        await removeStorageObjects(
          operation,
          batch,
          (nextPaths) => dependencies.remove(bucket, nextPaths),
          (path) => dependencies.exists(bucket, path),
        );
      } catch (error) {
        failures.push(
          error instanceof SupabaseOperationError
            ? error
            : new SupabaseOperationError(operation, error),
        );
      }
    }
  };

  const listAll = async (
    operation: string,
    bucket: string,
    prefix: string,
  ): Promise<StorageEntry[] | null> => {
    try {
      const rows = await listStorageObjectsPaginated(operation, (options) =>
        dependencies.list(bucket, prefix, options),
      );
      if (
        rows.some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            !isSafeStorageListName(entry.name),
        )
      ) {
        throw new SupabaseOperationError(
          operation,
          new Error("invalid_storage_list_entry"),
        );
      }
      return rows;
    } catch (error) {
      failures.push(
        error instanceof SupabaseOperationError
          ? error
          : new SupabaseOperationError(operation, error),
      );
      return null;
    }
  };

  await remove("storage.dolls.remove", DOLLS_BUCKET, dollPaths);

  // 탈퇴와 경합한 doll pick은 DB INSERT trigger에서 거부된 뒤 방금 업로드한
  // `{owner}/{uuid}.png`를 보상삭제한다. 그 remove까지 실패/중단된 경우를
  // signed-upload horizon의 마지막 outbox pass가 owner root sweep으로 회수한다.
  const dollRoot = await listAll(
    "storage.doll_orphans.list",
    DOLLS_BUCKET,
    userId,
  );
  await remove(
    "storage.doll_orphans.remove",
    DOLLS_BUCKET,
    (dollRoot ?? [])
      .map((file) => file.name)
      .filter(
        (name) =>
          name.endsWith(".png") && isUuid(name.slice(0, -".png".length)),
      )
      .map((name) => `${userId}/${name}`),
  );

  const candidateRoot = await listAll(
    "storage.candidates.list",
    DOLLS_BUCKET,
    `${userId}/candidates`,
  );
  for (const generationName of new Set(
    (candidateRoot ?? []).map((generation) => generation.name),
  )) {
    const prefix = `${userId}/candidates/${generationName}`;
    const files = await listAll(
      "storage.candidate_files.list",
      DOLLS_BUCKET,
      prefix,
    );
    await remove(
      "storage.candidate_files.remove",
      DOLLS_BUCKET,
      (files ?? []).map((file) => `${prefix}/${file.name}`),
    );
  }

  const facePrefix = `tmp/face/${userId}`;
  const faceFiles = await listAll(
    "storage.face_tmp.list",
    DOLLS_BUCKET,
    facePrefix,
  );
  await remove(
    "storage.face_tmp.remove",
    DOLLS_BUCKET,
    (faceFiles ?? []).map((file) => `${facePrefix}/${file.name}`),
  );

  await remove(
    "storage.highlights.remove",
    HIGHLIGHTS_BUCKET,
    highlightPaths,
  );

  // createSignedUploadUrl token은 auth/profile 삭제 뒤에도 발급 시점부터 2시간
  // 유효하다. outbox가 final_sweep_after까지 active인 동안 매 pass에서 canonical
  // owner/score prefix를 전 페이지 조회해 manifest에 없던 late upload도 회수한다.
  for (const scoreId of new Set(highlightScoreIds)) {
    const files = await listAll(
      "storage.highlight_orphans.list",
      HIGHLIGHTS_BUCKET,
      scoreId,
    );
    await remove(
      "storage.highlight_orphans.remove",
      HIGHLIGHTS_BUCKET,
      (files ?? []).map((file) => `${scoreId}/${file.name}`),
    );
  }

  await remove(
    "storage.avatar.remove",
    AVATARS_BUCKET,
    avatarPath ? [avatarPath] : [],
  );
  const avatarFiles = await listAll(
    "storage.avatar_orphans.list",
    AVATARS_BUCKET,
    userId,
  );
  await remove(
    "storage.avatar_orphans.remove",
    AVATARS_BUCKET,
    (avatarFiles ?? []).map((file) => `${userId}/${file.name}`),
  );

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

  // GoTrue의 user_metadata 갱신은 merge semantics다. 빈 객체는 기존 키를
  // 지우지 않으므로, 직전 authoritative read에서 확인한 모든 키를 null로 보내
  // 각 키를 삭제해야 한다.
  let scrubResult: AuthUserResult | null = null;
  try {
    if (metadataKeys !== null) {
      scrubResult = await dependencies.scrubAuth(metadataKeys);
      const error = validateAuthScrubbedUser(scrubResult, userId);
      if (error) {
        failures.push(new SupabaseOperationError("auth.user_scrub", error));
      }
    }
  } catch (error) {
    failures.push(new SupabaseOperationError("auth.user_scrub", error));
  }

  // updateUserById's response is not enough: an intermediary can acknowledge
  // without persistence. A fresh Auth read is the terminal privacy proof.
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
