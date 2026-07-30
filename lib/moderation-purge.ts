import {
  removeStorageObjects,
  type StorageExistsResult,
  type StorageRemoveResult,
} from "./supabase-operation.ts";

export type ModerationPurgeTarget = { bucket: string; path: string };

export type ModerationPurgeDependencies = {
  remove: (
    bucket: string,
    paths: string[],
  ) => PromiseLike<StorageRemoveResult>;
  exists: (
    bucket: string,
    path: string,
  ) => PromiseLike<StorageExistsResult>;
};

/**
 * Bucket별 삭제를 끝까지 시도하고 resolved `{ error }`와 throw를 모두
 * path 단위 실패로 반환한다. 호출자는 실패가 0일 때만 purge 완료를 확정한다.
 */
export async function removeModerationPurgeTargets(
  targets: readonly ModerationPurgeTarget[],
  dependencies: ModerationPurgeDependencies,
): Promise<ModerationPurgeTarget[]> {
  const byBucket = new Map<string, string[]>();
  for (const target of targets) {
    const paths = byBucket.get(target.bucket) ?? [];
    if (!paths.includes(target.path)) paths.push(target.path);
    byBucket.set(target.bucket, paths);
  }

  const failed: ModerationPurgeTarget[] = [];
  for (const [bucket, paths] of byBucket) {
    try {
      await removeStorageObjects(
        "moderation.purge.storage_remove",
        paths,
        (nextPaths) => dependencies.remove(bucket, nextPaths),
        (path) => dependencies.exists(bucket, path),
      );
    } catch {
      failed.push(...paths.map((path) => ({ bucket, path })));
    }
  }
  return failed;
}
