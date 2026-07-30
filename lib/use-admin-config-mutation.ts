"use client";

import { useCallback } from "react";

import {
  submitAdminConfigMutation,
  type AdminConfigClientResult,
  type AdminConfigMutationOptions,
} from "./admin-config-client";
import { useClientOperationScope } from "./use-client-operation-scope";

type ScopedAdminConfigOptions = Omit<
  AdminConfigMutationOptions,
  "signal"
>;

/**
 * Component-scoped config publisher. The transport still has its hard total
 * deadline and exact deterministic replay, while this hook also aborts it
 * when its editor leaves the tree.
 */
export function useAdminConfigMutation(): (
  options: ScopedAdminConfigOptions,
) => Promise<AdminConfigClientResult> {
  const runScopedOperation = useClientOperationScope();
  return useCallback(
    (options: ScopedAdminConfigOptions) =>
      runScopedOperation((signal) =>
        submitAdminConfigMutation({ ...options, signal }),
      ),
    [runScopedOperation],
  );
}
