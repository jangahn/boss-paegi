import { runClientMutation } from "./client-mutation.ts";

export type BoundedClientOperationOptions = {
  signal?: AbortSignal;
  deadlineMs?: number;
  attemptMs?: number;
};

/**
 * Bound a single non-HTTP SDK/read operation without replaying it. The
 * operation receives the attempt signal so cooperative SDKs can cancel their
 * underlying request; the hard deadline still settles a non-cooperative one.
 */
export async function runBoundedClientOperation<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  options: BoundedClientOperationOptions = {},
): Promise<T> {
  const outcome = await runClientMutation<T>({
    attempt: async (signal) => {
      try {
        return {
          kind: "confirmed",
          value: await operation(signal),
        };
      } catch (error) {
        return { kind: "rejected", error };
      }
    },
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    attemptMs: options.attemptMs,
  });
  if (outcome.kind === "confirmed") return outcome.value;
  if (outcome.kind === "rejected") throw outcome.error;
  if (outcome.kind === "aborted") {
    throw options.signal?.reason ??
      new Error("client_operation_aborted");
  }
  throw new Error("client_operation_unconfirmed");
}
