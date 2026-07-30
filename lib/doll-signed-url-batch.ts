type SignedUrlResult = {
  data?: { signedUrl?: string | null } | null;
  error?: unknown | null;
};

type SignedUrlsResult = {
  data?:
    | Array<{
        path?: string | null;
        signedUrl?: string | null;
        error?: unknown | null;
      }>
    | null;
  error?: unknown | null;
};

export type DollSignedUrlBatchResult =
  | { ok: true; byPath: Map<string, string> }
  | { ok: false; error: unknown; failedPaths: string[] };

/**
 * active doll path 하나라도 서명하지 못하면 전체 요청을 실패시킨다. 일부 null을
 * 정상 응답으로 위장하면 Storage/권한 장애가 takedown처럼 보이기 때문이다.
 */
export async function signDollPaths(input: {
  paths: readonly string[];
  thumb: boolean;
  signOne: (path: string) => PromiseLike<SignedUrlResult>;
  signMany: (paths: string[]) => PromiseLike<SignedUrlsResult>;
}): Promise<DollSignedUrlBatchResult> {
  const paths = [...new Set(input.paths)];
  if (paths.length === 0) return { ok: true, byPath: new Map() };

  try {
    const byPath = new Map<string, string>();
    if (input.thumb) {
      const results = await Promise.all(
        paths.map(async (path) => ({
          path,
          result: await input.signOne(path),
        })),
      );
      const failedPaths: string[] = [];
      let firstError: unknown = new Error("signed_url_missing");
      for (const { path, result } of results) {
        if (
          result.error !== null &&
          result.error !== undefined
        ) {
          failedPaths.push(path);
          firstError = result.error;
        } else if (!result.data?.signedUrl) {
          failedPaths.push(path);
        } else {
          byPath.set(path, result.data.signedUrl);
        }
      }
      return failedPaths.length > 0
        ? { ok: false, error: firstError, failedPaths }
        : { ok: true, byPath };
    }

    const result = await input.signMany(paths);
    if (result.error !== null && result.error !== undefined) {
      return { ok: false, error: result.error, failedPaths: paths };
    }
    if (!Array.isArray(result.data)) {
      return {
        ok: false,
        error: new Error("signed_url_response_missing"),
        failedPaths: paths,
      };
    }
    let firstError: unknown = new Error("signed_url_missing");
    for (const signed of result.data) {
      if (
        typeof signed.path === "string" &&
        typeof signed.signedUrl === "string" &&
        signed.signedUrl.length > 0 &&
        (signed.error === null || signed.error === undefined)
      ) {
        byPath.set(signed.path, signed.signedUrl);
      } else if (signed.error !== null && signed.error !== undefined) {
        firstError = signed.error;
      }
    }
    const failedPaths = paths.filter((path) => !byPath.has(path));
    return failedPaths.length > 0
      ? { ok: false, error: firstError, failedPaths }
      : { ok: true, byPath };
  } catch (error) {
    return { ok: false, error, failedPaths: paths };
  }
}
