import {
  removeStorageObjects,
  type StorageExistsResult,
  type StorageRemoveResult,
} from "./supabase-operation.ts";

/** Supabase createSignedUploadUrl token validity (official contract): 2 hours. */
export const SIGNED_UPLOAD_VALID_MS = 2 * 60 * 60 * 1000;
/** Allow small clock/transport skew between Storage and the app server. */
export const SIGNED_UPLOAD_ATTACH_GRACE_MS = 5 * 60 * 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

export type UploadIntentMutationResult =
  | { ok: true; data: unknown }
  | { ok: false; error: unknown };

/** Normalize both Supabase resolved errors and transport/client rejects. */
export async function resolveUploadIntentMutation(
  run: () => PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<UploadIntentMutationResult> {
  try {
    const result = await run();
    return result.error
      ? { ok: false, error: result.error }
      : { ok: true, data: result.data };
  } catch (error) {
    return { ok: false, error };
  }
}

export function uploadIntentErrorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "";
}

export type CreatedUploadIntent = {
  intentId: string;
  expiresAt?: string;
  tokenIssueSequence?: 1 | 2;
};

/** Exact acknowledgement for signed/client and server-side upload intents. */
export function parseCreatedUploadIntent(
  value: unknown,
  options: { expires: boolean; nowMs?: number },
): CreatedUploadIntent | null {
  if (!isJsonObject(value) || value.ok !== true) return null;
  const rollingKeys = ["ok", "intent_id", "expires_at"];
  const boundedKeys = [
    "ok",
    "intent_id",
    "expires_at",
    "token_issue_sequence",
  ];
  const exactExpiryShape =
    options.expires &&
    (hasExactKeys(value, rollingKeys) ||
      hasExactKeys(value, boundedKeys));
  if (
    (options.expires
      ? !exactExpiryShape
      : !hasExactKeys(value, ["ok", "intent_id"])) ||
    !isUuid(value.intent_id)
  ) {
    return null;
  }
  if (!options.expires) return { intentId: value.intent_id };
  if (
    typeof value.expires_at !== "string" ||
    value.expires_at !== value.expires_at.trim() ||
    !TIMESTAMP_RE.test(value.expires_at)
  ) {
    return null;
  }
  const expiresMs = Date.parse(value.expires_at);
  const nowMs = options.nowMs ?? Date.now();
  if (
    !Number.isFinite(expiresMs) ||
    expiresMs < nowMs - SIGNED_UPLOAD_ATTACH_GRACE_MS ||
    expiresMs >
      nowMs +
        SIGNED_UPLOAD_VALID_MS +
        2 * SIGNED_UPLOAD_ATTACH_GRACE_MS
  ) {
    return null;
  }
  if (
    "token_issue_sequence" in value &&
    value.token_issue_sequence !== 1 &&
    value.token_issue_sequence !== 2
  ) {
    return null;
  }
  return {
    intentId: value.intent_id,
    expiresAt: value.expires_at,
    ...("token_issue_sequence" in value
      ? {
          tokenIssueSequence: value.token_issue_sequence as 1 | 2,
        }
      : {}),
  };
}

export function parseConfirmedUploadIntent(
  value: unknown,
): "confirmed" | "already_attached" | null {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ["ok", "outcome"]) ||
    value.ok !== true
  ) {
    return null;
  }
  return value.outcome === "confirmed" ||
    value.outcome === "already_attached"
    ? value.outcome
    : null;
}

export type ConfirmedUploadIntentWithLegacyAdoption =
  | {
      ok: true;
      outcome: "confirmed" | "already_attached";
      adoptedLegacy: boolean;
    }
  | {
      ok: false;
      error: unknown;
      phase:
        | "initial_confirmation"
        | "legacy_intent_creation"
        | "adopted_confirmation";
    };

function invalidUploadIntentAcknowledgement(
  operation: "confirm" | "create",
): Error {
  return new Error(`invalid_upload_intent_${operation}_acknowledgement`);
}

/**
 * Bridge a signed-upload token issued by a pre-intent app deployment.
 *
 * Callers MUST first verify the authenticated owner/admin, canonical path,
 * persisted object metadata, and signed-token freshness. We only attempt an
 * adoption after the exact "upload_intent_forbidden" confirmation failure.
 * That error also covers an occupied path with mismatched ownership/context,
 * so the create RPC's unique (bucket, path) fence and a second exact
 * confirmation are both mandatory. A concurrent adopter or a lost create
 * response is safe: the second confirmation is the authoritative result.
 */
export async function confirmUploadIntentWithLegacyAdoption(input: {
  confirm: () => PromiseLike<{ data: unknown; error: unknown | null }>;
  create: () => PromiseLike<{ data: unknown; error: unknown | null }>;
  nowMs?: number;
}): Promise<ConfirmedUploadIntentWithLegacyAdoption> {
  const initial = await resolveUploadIntentMutation(input.confirm);
  if (initial.ok) {
    const outcome = parseConfirmedUploadIntent(initial.data);
    return outcome
      ? { ok: true, outcome, adoptedLegacy: false }
      : {
          ok: false,
          error: invalidUploadIntentAcknowledgement("confirm"),
          phase: "initial_confirmation",
        };
  }
  if (uploadIntentErrorMessage(initial.error) !== "upload_intent_forbidden") {
    return {
      ok: false,
      error: initial.error,
      phase: "initial_confirmation",
    };
  }

  const creation = await resolveUploadIntentMutation(input.create);
  if (
    creation.ok &&
    !parseCreatedUploadIntent(creation.data, {
      expires: true,
      nowMs: input.nowMs,
    })
  ) {
    return {
      ok: false,
      error: invalidUploadIntentAcknowledgement("create"),
      phase: "legacy_intent_creation",
    };
  }

  // Confirm even when create errored: another request may have won the unique
  // path race, or the database may have committed before the response was lost.
  const adopted = await resolveUploadIntentMutation(input.confirm);
  if (!adopted.ok) {
    return {
      ok: false,
      error: adopted.error,
      phase: "adopted_confirmation",
    };
  }
  const outcome = parseConfirmedUploadIntent(adopted.data);
  return outcome
    ? { ok: true, outcome, adoptedLegacy: true }
    : {
        ok: false,
        error: invalidUploadIntentAcknowledgement("confirm"),
        phase: "adopted_confirmation",
      };
}

export function isOwnedAvatarUploadPath(
  path: unknown,
  userId: string,
): path is string {
  if (typeof path !== "string") return false;
  const slash = path.indexOf("/");
  if (slash < 0 || path.slice(0, slash) !== userId) return false;
  const filename = path.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return false;
  const id = filename.slice(0, dot);
  const ext = filename.slice(dot + 1);
  return isUuid(id) && (ext === "png" || ext === "jpg" || ext === "webp");
}

const SAFE_IMAGE_CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const;

type SafeImageExtension = keyof typeof SAFE_IMAGE_CONTENT_TYPES;

/**
 * Bind Storage's persisted Content-Type to the signed path extension. A signed
 * token limits the path, not the caller-provided metadata, so accepting generic
 * `image/*` would let an SVG/unknown active type ride a `.png` intent.
 */
export function imageContentTypeMatchesPath(
  path: unknown,
  contentType: unknown,
  allowedExtensions: readonly SafeImageExtension[],
): boolean {
  if (typeof path !== "string" || typeof contentType !== "string") {
    return false;
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const extension = path.slice(dot + 1).toLowerCase() as SafeImageExtension;
  if (!allowedExtensions.includes(extension)) return false;
  const normalizedContentType = contentType
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return SAFE_IMAGE_CONTENT_TYPES[extension] === normalizedContentType;
}

const SAFE_VIDEO_CONTENT_TYPES = {
  mp4: "video/mp4",
  webm: "video/webm",
} as const;

type SafeVideoExtension = keyof typeof SAFE_VIDEO_CONTENT_TYPES;

/** Bind a public highlight object's persisted Content-Type to its path. */
export function videoContentTypeMatchesPath(
  path: unknown,
  contentType: unknown,
  allowedExtensions: readonly SafeVideoExtension[],
): boolean {
  if (typeof path !== "string" || typeof contentType !== "string") {
    return false;
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const extension = path.slice(dot + 1).toLowerCase() as SafeVideoExtension;
  if (!allowedExtensions.includes(extension)) return false;
  const normalizedContentType = contentType
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return SAFE_VIDEO_CONTENT_TYPES[extension] === normalizedContentType;
}

/**
 * Signed-upload objects may only be attached during the token lifetime (+small
 * clock skew). Invalid/future timestamps fail closed instead of making an
 * indefinitely attachable orphan path.
 */
export function isFreshSignedUpload(
  createdAt: unknown,
  nowMs = Date.now(),
): boolean {
  if (typeof createdAt !== "string") return false;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = nowMs - createdMs;
  return (
    ageMs >= -SIGNED_UPLOAD_ATTACH_GRACE_MS &&
    ageMs <= SIGNED_UPLOAD_VALID_MS + SIGNED_UPLOAD_ATTACH_GRACE_MS
  );
}

export type UploadCleanupResult =
  | { ok: true }
  | { ok: false; error: unknown };

/**
 * Cleanup used by rejected/duplicate/failed upload-finalize paths. Supabase
 * normally resolves failures as `{ error }`, so awaiting alone is insufficient.
 */
export async function attemptUploadCleanup(
  operation: string,
  paths: readonly string[],
  remove: (paths: string[]) => PromiseLike<StorageRemoveResult>,
  exists: (path: string) => PromiseLike<StorageExistsResult>,
): Promise<UploadCleanupResult> {
  try {
    await removeStorageObjects(operation, paths, remove, exists);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
