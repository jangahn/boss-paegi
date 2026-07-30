export type FailClosedReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: unknown };

type SupabaseReadResponse<T> = {
  data: T;
  error: unknown | null;
};

/** Supabase의 resolved `{error}`와 thrown transport/client error를 같은 실패면으로 정규화한다. */
export async function resolveFailClosedRead<T>(
  query: () => PromiseLike<SupabaseReadResponse<T>>,
): Promise<FailClosedReadResult<T>> {
  try {
    const { data, error } = await query();
    if (error) return { ok: false, error };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 배치 시작점 조회처럼 "빈 성공"으로 축소할 수 없는 read failure를 상위 HTTP 경계까지 전달한다. */
export class FailClosedReadError extends Error {
  readonly readCause: unknown;

  constructor(message: string, readCause: unknown) {
    super(message);
    this.name = "FailClosedReadError";
    this.readCause = readCause;
  }
}
