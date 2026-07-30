import {
  clientMutationResponseNeedsReconciliation,
  runReplayedJsonMutation,
} from "./client-mutation.ts";
import {
  parseConfigWriteHttpAck,
  type ConfigWriteHttpAck,
} from "./config/write-result.ts";

export type AdminConfigClientResult =
  | {
      ok: true;
      status: number;
      ack: ConfigWriteHttpAck;
      error: null;
      unconfirmed: false;
    }
  | {
      ok: false;
      status: number;
      ack: null;
      error: string;
      unconfirmed: boolean;
    }
  | {
      ok: false;
      status: 0;
      ack: null;
      error: "aborted";
      unconfirmed: true;
    };

export type AdminConfigMutationOptions = {
  body: Record<string, unknown>;
  baseVersion: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  deadlineMs?: number;
  attemptMs?: number;
};

export async function submitAdminConfigMutation(
  options: AdminConfigMutationOptions,
): Promise<AdminConfigClientResult> {
  const serializedBody = JSON.stringify(options.body);
  const outcome = await runReplayedJsonMutation({
    input: "/api/admin/config",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializedBody,
    },
    signal: options.signal,
    fetcher: options.fetcher,
    deadlineMs: options.deadlineMs,
    attemptMs: options.attemptMs,
    classify: (response, body) => {
      const ack = response.ok
        ? parseConfigWriteHttpAck(body, options.baseVersion)
        : null;
      if (ack) {
        return {
          kind: "confirmed",
          value: { status: response.status, ack },
        };
      }
      const error =
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      if (
        clientMutationResponseNeedsReconciliation(
          response.status,
          response.ok,
        )
      ) {
        return {
          kind: "unconfirmed",
          reason: "config_response_unconfirmed",
          error,
        };
      }
      return {
        kind: "rejected",
        error: { status: response.status, code: error },
      };
    },
  });
  if (outcome.kind === "confirmed") {
    return {
      ok: true,
      status: outcome.value.status,
      ack: outcome.value.ack,
      error: null,
      unconfirmed: false,
    };
  }
  if (outcome.kind === "aborted") {
    return {
      ok: false,
      status: 0,
      ack: null,
      error: "aborted",
      unconfirmed: true,
    };
  }
  if (
    outcome.kind === "rejected" &&
    outcome.error &&
    typeof outcome.error === "object" &&
    !Array.isArray(outcome.error)
  ) {
    const rejection = outcome.error as {
      status?: unknown;
      code?: unknown;
    };
    return {
      ok: false,
      status: Number.isSafeInteger(rejection.status)
        ? (rejection.status as number)
        : 0,
      ack: null,
      error:
        typeof rejection.code === "string"
          ? rejection.code
          : "config_update_failed",
      unconfirmed: false,
    };
  }
  return {
    ok: false,
    status: 0,
    ack: null,
    error: "result_unconfirmed",
    unconfirmed: true,
  };
}
