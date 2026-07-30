/**
 * Supabase SDK calls usually resolve with `{ error }` instead of rejecting.
 * Awaiting the promise without inspecting that field therefore turns a failed
 * destructive operation into a false success.
 *
 * This module deliberately has no server/runtime dependencies so fault
 * injection tests can exercise the contract without touching Supabase.
 */
export type SupabaseOperationResult = {
  error?: unknown;
};

export type SupabaseDataResult<T> = SupabaseOperationResult & {
  data: T | null;
};

export type SupabaseCountResult = SupabaseOperationResult & {
  count: number | null;
};

export type SupabasePageResult<T> = SupabaseDataResult<T[]> &
  SupabaseCountResult;

export type StorageListOptions = {
  limit: number;
  offset: number;
};

export type StorageListResult<T> = SupabaseOperationResult & {
  data: T[] | null;
};

export type StorageRemoveObject = {
  name: string;
};

export type StorageRemoveResult = SupabaseOperationResult & {
  data: StorageRemoveObject[] | null;
};

export type StorageExistsResult = SupabaseOperationResult & {
  data: boolean;
};

export const STORAGE_LIST_PAGE_SIZE = 100;
export const STORAGE_REMOVE_BATCH_SIZE = 100;

export class SupabaseOperationError extends Error {
  readonly operation: string;
  readonly operationError: unknown;

  constructor(operation: string, operationError: unknown) {
    super(`${operation} failed`);
    this.name = "SupabaseOperationError";
    this.operation = operation;
    this.operationError = operationError;
  }
}

export async function requireSupabaseSuccess<T extends SupabaseOperationResult>(
  operation: string,
  call: () => PromiseLike<T>,
): Promise<T> {
  try {
    const result = await call();
    if (result.error !== null && result.error !== undefined) {
      throw new SupabaseOperationError(operation, result.error);
    }
    return result;
  } catch (error) {
    if (error instanceof SupabaseOperationError) throw error;
    throw new SupabaseOperationError(operation, error);
  }
}

function invalidResult(operation: string, reason: string): SupabaseOperationError {
  return new SupabaseOperationError(operation, new Error(reason));
}

/**
 * 성공 시 반드시 한 값이 와야 하는 SELECT/RPC 계약.
 * `{ error:null, data:null }`도 "성공"으로 축소하지 않는다.
 */
export async function requireSupabaseData<T>(
  operation: string,
  call: () => PromiseLike<SupabaseDataResult<T>>,
): Promise<T> {
  const result = await requireSupabaseSuccess(operation, call);
  if (result.data === null || result.data === undefined) {
    throw invalidResult(operation, "required_data_missing");
  }
  return result.data;
}

/** no-row가 정상 의미인 maybeSingle용. resolved `{ error }`만 실패로 승격한다. */
export async function requireSupabaseOptionalData<T>(
  operation: string,
  call: () => PromiseLike<SupabaseDataResult<T>>,
): Promise<T | null> {
  const result = await requireSupabaseSuccess(operation, call);
  return result.data ?? null;
}

/** 일반 SELECT는 성공 시 배열이어야 한다. null/비배열을 빈 목록으로 오인하지 않는다. */
export async function requireSupabaseRows<T>(
  operation: string,
  call: () => PromiseLike<SupabaseDataResult<T[]>>,
): Promise<T[]> {
  const result = await requireSupabaseSuccess(operation, call);
  if (!Array.isArray(result.data)) {
    throw invalidResult(operation, "row_array_missing");
  }
  return result.data;
}

/** count:'exact' 계약. null·음수·비정수 count를 0으로 오인하지 않는다. */
export async function requireSupabaseExactCount(
  operation: string,
  call: () => PromiseLike<SupabaseCountResult>,
): Promise<number> {
  const result = await requireSupabaseSuccess(operation, call);
  if (
    result.count === null ||
    !Number.isSafeInteger(result.count) ||
    result.count < 0
  ) {
    throw invalidResult(operation, "exact_count_missing_or_invalid");
  }
  return result.count;
}

/** 목록+exact count를 한 쿼리에서 읽는 페이지 계약. */
export async function requireSupabasePage<T>(
  operation: string,
  call: () => PromiseLike<SupabasePageResult<T>>,
): Promise<{ rows: T[]; count: number }> {
  const result = await requireSupabaseSuccess(operation, call);
  if (!Array.isArray(result.data)) {
    throw invalidResult(operation, "row_array_missing");
  }
  if (
    result.count === null ||
    !Number.isSafeInteger(result.count) ||
    result.count < 0 ||
    result.count < result.data.length
  ) {
    throw invalidResult(operation, "exact_count_missing_or_invalid");
  }
  return { rows: result.data, count: result.count };
}

/**
 * PostgREST 기본 max-rows(통상 1,000)에 잘리지 않도록 안정 정렬된 range를 끝까지 읽는다.
 * 중간 페이지의 resolved/throw 오류는 부분 목록을 반환하지 않고 전체 호출을 실패시킨다.
 */
export async function readSupabaseRowsPaginated<T>(
  operation: string,
  readPage: (
    offset: number,
    limit: number,
  ) => PromiseLike<SupabaseDataResult<T[]>>,
  pageSize = 500,
): Promise<T[]> {
  const limit = Math.max(1, Math.min(Math.trunc(pageSize), 1_000));
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const page = await requireSupabaseRows(
      `${operation}[offset=${offset}]`,
      () => readPage(offset, limit),
    );
    rows.push(...page);
    if (page.length < limit) return rows;
    offset += page.length;
  }
}

export async function removeStorageObjects(
  operation: string,
  paths: readonly string[],
  remove: (paths: string[]) => PromiseLike<StorageRemoveResult>,
  exists: (path: string) => PromiseLike<StorageExistsResult>,
): Promise<void> {
  const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];
  if (uniquePaths.length === 0) return;
  for (const path of uniquePaths) {
    if (!isCanonicalStoragePath(path)) {
      throw invalidResult(operation, "invalid_storage_remove_path");
    }
  }

  const removed = await requireSupabaseRows(
    operation,
    () => remove(uniquePaths),
  );
  const requested = new Set(uniquePaths);
  const acknowledged = new Set<string>();
  for (const entry of removed) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      !requested.has(entry.name) ||
      acknowledged.has(entry.name)
    ) {
      throw invalidResult(operation, "invalid_storage_remove_ack");
    }
    acknowledged.add(entry.name);
  }

  // remove([]) can legitimately return an empty array when a retry finds the
  // object already absent. Therefore returned rows alone are not terminal
  // proof; every requested path gets an exact absence postcondition.
  for (const path of uniquePaths) {
    let result: StorageExistsResult;
    try {
      result = await exists(path);
    } catch (error) {
      throw new SupabaseOperationError(`${operation}.verify_absent`, error);
    }
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.data !== "boolean"
    ) {
      throw invalidResult(
        `${operation}.verify_absent`,
        "invalid_storage_exists_response",
      );
    }
    if (result.data) {
      throw invalidResult(
        `${operation}.verify_absent`,
        "storage_object_still_exists",
      );
    }
    if (
      result.error !== null &&
      result.error !== undefined &&
      !isStorageNotFoundError(result.error)
    ) {
      throw new SupabaseOperationError(
        `${operation}.verify_absent`,
        result.error,
      );
    }
  }
}

/** Bucket-relative path only; traversal, URL, control and ambiguous separators are rejected. */
export function isCanonicalStoragePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1024 ||
    path !== path.trim() ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("://")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== "..",
  );
}

/** Supabase Storage exists() represents an absent object as false + 400/404 error. */
export function isStorageNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as {
    status?: unknown;
    statusCode?: unknown;
    originalError?: unknown;
  };
  const status =
    typeof row.status === "number"
      ? row.status
      : typeof row.status === "string"
        ? Number(row.status)
        : typeof row.statusCode === "number"
          ? row.statusCode
          : typeof row.statusCode === "string"
            ? Number(row.statusCode)
            : null;
  if (status === 400 || status === 404) return true;
  if (row.originalError && typeof row.originalError === "object") {
    const nested = row.originalError as { status?: unknown };
    return nested.status === 400 || nested.status === 404;
  }
  return false;
}

/** Supabase Storage list의 기본 100개 제한을 offset pagination으로 끝까지 순회한다. */
export async function listStorageObjectsPaginated<T>(
  operation: string,
  list: (
    options: StorageListOptions,
  ) => PromiseLike<StorageListResult<T>>,
  pageSize = STORAGE_LIST_PAGE_SIZE,
): Promise<T[]> {
  const limit = Math.max(1, Math.min(Math.trunc(pageSize), 1000));
  const all: T[] = [];
  let offset = 0;

  while (true) {
    const page = await requireSupabaseRows(operation, () =>
      list({ limit, offset }),
    );
    all.push(...page);
    if (page.length < limit) return all;
    // page.length가 0이면 위 조건에 걸린다. offset은 실제 수신량만큼 증가해 누락/중복을 피한다.
    offset += page.length;
  }
}

export function storagePathBatches(
  paths: readonly string[],
  batchSize = STORAGE_REMOVE_BATCH_SIZE,
): string[][] {
  const size = Math.max(1, Math.trunc(batchSize));
  const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];
  const batches: string[][] = [];
  for (let index = 0; index < uniquePaths.length; index += size) {
    batches.push(uniquePaths.slice(index, index + size));
  }
  return batches;
}
