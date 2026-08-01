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
      /** validation_failed 시 서버 zod issues 요약 — 어느 규칙이 걸렸는지 그대로 표시용. */
      issues?: string[];
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
      const rawIssues =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { issues?: unknown }).issues
          : undefined;
      const issues = Array.isArray(rawIssues)
        ? rawIssues
            .slice(0, 5)
            .flatMap((issue) => {
              if (!issue || typeof issue !== "object") return [];
              const row = issue as {
                path?: unknown;
                message?: unknown;
              };
              const path = Array.isArray(row.path)
                ? row.path.join(".")
                : "";
              return typeof row.message === "string"
                ? [path ? `${path}: ${row.message}` : row.message]
                : [];
            })
        : undefined;
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
        error: { status: response.status, code: error, issues },
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
      issues?: unknown;
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
      ...(Array.isArray(rejection.issues) &&
      rejection.issues.every((v) => typeof v === "string")
        ? { issues: rejection.issues as string[] }
        : {}),
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
