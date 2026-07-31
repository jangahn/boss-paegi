type AttemptResult =
  | { ok: true }
  | { ok: false; error: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseServerSignOutAck(
  value: unknown,
  expected?: {
    flowId: string | null;
    userId: string;
    sessionId: string;
  },
): boolean {
  return (
    isObject(value) &&
    Object.keys(value).length === 4 &&
    value.ok === true &&
    (value.flowId === null ||
      (
        typeof value.flowId === "string" &&
        UUID_RE.test(value.flowId)
      )) &&
    typeof value.userId === "string" &&
    UUID_RE.test(value.userId) &&
    typeof value.sessionId === "string" &&
    UUID_RE.test(value.sessionId) &&
    (expected === undefined ||
      (value.flowId === expected.flowId &&
        value.userId === expected.userId &&
        value.sessionId === expected.sessionId))
  );
}

async function resolveServerAttempt(
  run: () => PromiseLike<{ responseOk: boolean; data: unknown }>,
): Promise<AttemptResult> {
  try {
    const result = await run();
    if (!result.responseOk) {
      return { ok: false, error: new Error("signout_server_http_failed") };
    }
    if (!parseServerSignOutAck(result.data)) {
      return {
        ok: false,
        error: new Error("signout_server_response_invalid"),
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function resolveLocalAttempt(
  run: () => PromiseLike<unknown>,
): Promise<AttemptResult> {
  try {
    const result = await run();
    if (
      !isObject(result) ||
      !Object.prototype.hasOwnProperty.call(result, "error")
    ) {
      return {
        ok: false,
        error: new Error("signout_local_response_invalid"),
      };
    }
    return result.error == null
      ? { ok: true }
      : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error };
  }
}

export type SignOutResolution = {
  /**
   * Server success is mandatory: only that response proves the httpOnly
   * migration cookie and every auth-cookie chunk were expired.
   */
  ok: boolean;
  server: AttemptResult;
  local: AttemptResult;
};

export async function resolveSignOutAttempts(args: {
  server: () => PromiseLike<{ responseOk: boolean; data: unknown }>;
  local: () => PromiseLike<unknown>;
}): Promise<SignOutResolution> {
  const [server, local] = await Promise.all([
    resolveServerAttempt(args.server),
    resolveLocalAttempt(args.local),
  ]);
  return { ok: server.ok, server, local };
}
