"use client";

import { useCallback, useEffect, useRef } from "react";

export type ScopedClientOperationRunner = <T>(
  operation: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

/**
 * Gives every client-side operation its own AbortController and aborts all
 * outstanding work when the owning component unmounts. A Set is used instead
 * of one render-time controller so React Strict Mode's effect probe cannot
 * leave later user actions attached to an already-aborted signal.
 */
export function useClientOperationScope(): ScopedClientOperationRunner {
  const controllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(
    () => () => {
      for (const controller of controllersRef.current) {
        controller.abort(new Error("client_component_unmounted"));
      }
      controllersRef.current.clear();
    },
    [],
  );

  return useCallback(async <T,>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      controllersRef.current.delete(controller);
    }
  }, []);
}
