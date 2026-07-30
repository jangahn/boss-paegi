export type GenerationArtifactWriteClaim =
  | { ok: true; leaseToken: string }
  | { ok: false; outcome: string; error?: unknown };

type RpcResult = {
  data?: unknown;
  error?: unknown | null;
};

function rpcOutcome(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/** Supabase RPC의 resolved `{ error }`와 malformed success를 모두 fail-closed로 파싱한다. */
export async function claimGenerationArtifactWrite(
  claim: () => PromiseLike<RpcResult>,
): Promise<GenerationArtifactWriteClaim> {
  try {
    const result = await claim();
    if (result.error !== null && result.error !== undefined) {
      return { ok: false, outcome: "rpc_error", error: result.error };
    }
    const row = rpcOutcome(result.data);
    if (
      row?.outcome === "claimed" &&
      typeof row.lease_token === "string" &&
      row.lease_token.length > 0
    ) {
      return { ok: true, leaseToken: row.lease_token };
    }
    return {
      ok: false,
      outcome:
        typeof row?.outcome === "string" ? row.outcome : "malformed_response",
    };
  } catch (error) {
    return { ok: false, outcome: "rpc_throw", error };
  }
}

export async function releaseGenerationArtifactWrite(
  release: () => PromiseLike<RpcResult>,
): Promise<{ ok: true } | { ok: false; error: unknown; outcome?: string }> {
  try {
    const result = await release();
    const row = rpcOutcome(result.data);
    const outcome =
      typeof row?.outcome === "string" ? row.outcome : undefined;
    if (result.error !== null && result.error !== undefined) {
      return { ok: false, error: result.error, outcome };
    }
    if (outcome !== "released") {
      return {
        ok: false,
        error: new Error("unexpected_artifact_write_release_outcome"),
        outcome,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
