import type { ZodType } from "zod";
import {
  SupabaseOperationError,
} from "../supabase-operation.ts";
import type { DomainKey } from "./keys.ts";

export class InvalidStrictConfigError extends Error {
  readonly key: DomainKey;

  constructor(key: DomainKey) {
    super(`invalid_config:${key}`);
    this.name = "InvalidStrictConfigError";
    this.key = key;
  }
}

/**
 * Pure strict-config boundary used by economic/external-side-effect callers.
 * A genuinely absent row uses the code seed. A resolved dependency error or a
 * malformed persisted row must remain distinguishable and fail closed.
 */
export function resolveStrictSettingResult<T>(
  key: DomainKey,
  schema: ZodType<T>,
  codeDefault: T,
  result: {
    data: { value: unknown; version: number } | null;
    error: unknown | null;
  },
): T {
  if (result.error) {
    throw new SupabaseOperationError(`config.strict.${key}`, result.error);
  }
  if (!result.data) return codeDefault;
  const parsed = schema.safeParse(result.data.value);
  if (!parsed.success) throw new InvalidStrictConfigError(key);
  return parsed.data;
}
