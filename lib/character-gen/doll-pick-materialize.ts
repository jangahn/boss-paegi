import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDollImage } from "../image-utils.ts";
import {
  DOLL_IMAGE_DOWNLOAD_MAX_BYTES,
} from "../media-download.ts";
import { SERVER_ENV } from "../env.server.ts";
import { fetchPrivateFalMediaBlob } from "./fal-private-media.ts";
import {
  parseCreatedUploadIntent,
  resolveUploadIntentMutation,
} from "../upload-write-safety.ts";
import {
  parseDollPickCommit,
  parseDollPickMaterializationClaim,
} from "./doll-pick-submit.ts";

const DOLLS_BUCKET = "dolls";
const DOLL_OBJECT_MAX_BYTES = 10 * 1024 * 1024;

export type DollPickMaterializationResult =
  | {
      kind: "committed";
      doll: Record<string, unknown> & { id: string };
    }
  | { kind: "processing" }
  | { kind: "blocked"; outcome: string };

async function readCommittedDoll(
  admin: SupabaseClient,
  userId: string,
  dollId: string,
): Promise<Record<string, unknown> & { id: string }> {
  const { data, error } = await admin
    .from("dolls")
    .select("*")
    .eq("id", dollId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (
    error ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.id !== "string" ||
    data.id !== dollId
  ) {
    throw error ?? new Error("pick_committed_doll_missing");
  }
  return data as Record<string, unknown> & { id: string };
}

/**
 * Materialize one durable provider result into the deterministic doll object.
 *
 * The DB lease fences concurrent provider downloads. Storage existence is
 * checked before upload so an upload-response loss converges without a second
 * write, and the DB commit accepts only the exact confirmed upload intent.
 */
export async function materializeGenerationPick(args: {
  admin: SupabaseClient;
  userId: string;
  generationId: string;
  workerId: string;
}): Promise<DollPickMaterializationResult> {
  const { data: claimData, error: claimError } = await args.admin.rpc(
    "claim_generation_pick_materialization",
    {
      p_user_id: args.userId,
      p_generation_id: args.generationId,
      p_worker_id: args.workerId,
    },
  );
  if (claimError) throw claimError;
  const claim = parseDollPickMaterializationClaim(claimData);
  if (claim.kind === "invalid") {
    throw new Error("pick_materialization_claim_invalid");
  }
  if (claim.kind === "processing") return claim;
  if (claim.kind === "blocked") return claim;
  if (claim.kind === "committed") {
    return {
      kind: "committed",
      doll: await readCommittedDoll(
        args.admin,
        args.userId,
        claim.dollId,
      ),
    };
  }
  if (claim.ownerId !== args.userId) {
    throw new Error("pick_materialization_owner_mismatch");
  }

  const downloaded = await fetchPrivateFalMediaBlob({
    url: claim.resultUrl,
    credentials: SERVER_ENV.FAL_KEY,
    kind: "image",
    maxBytes: DOLL_IMAGE_DOWNLOAD_MAX_BYTES,
    signal: AbortSignal.timeout(15_000),
  });
  const normalized = await normalizeDollImage(
    await downloaded.blob.arrayBuffer(),
  );
  if (normalized.byteLength < 1 || normalized.byteLength > DOLL_OBJECT_MAX_BYTES) {
    throw new Error("pick_materialization_output_size_invalid");
  }

  const path = `${args.userId}/${claim.attemptId}.png`;
  const intent = await resolveUploadIntentMutation(() =>
    args.admin.rpc("create_doll_upload_intent", {
      p_user_id: args.userId,
      p_doll_id: claim.attemptId,
      p_path: path,
    }),
  );
  if (
    !intent.ok ||
    !parseCreatedUploadIntent(intent.data, { expires: false })
  ) {
    throw intent.ok
      ? new Error("pick_upload_intent_invalid")
      : intent.error;
  }

  const existence = await args.admin.storage
    .from(DOLLS_BUCKET)
    .exists(path);
  if (existence.error) throw existence.error;
  if (existence.data) {
    const { data: info, error: infoError } = await args.admin.storage
      .from(DOLLS_BUCKET)
      .info(path);
    if (
      infoError ||
      !info ||
      !Number.isSafeInteger(info.size) ||
      (info.size ?? 0) < 1 ||
      (info.size ?? 0) > DOLL_OBJECT_MAX_BYTES ||
      info.contentType !== "image/png"
    ) {
      throw infoError ?? new Error("pick_existing_object_invalid");
    }
  } else {
    const { error: uploadError } = await args.admin.storage
      .from(DOLLS_BUCKET)
      .upload(path, normalized, {
        contentType: "image/png",
        upsert: false,
      });
    if (uploadError) throw uploadError;
  }

  const { data: commitData, error: commitError } = await args.admin.rpc(
    "commit_generation_pick",
    {
      p_user_id: args.userId,
      p_generation_id: args.generationId,
      p_candidate_index: claim.candidateIndex,
      p_attempt_id: claim.attemptId,
      p_worker_id: args.workerId,
      p_path: path,
    },
  );
  if (commitError) throw commitError;
  const commit = parseDollPickCommit(commitData);
  if (!commit.ok || commit.doll.id !== claim.attemptId) {
    throw new Error("pick_commit_invalid");
  }
  return { kind: "committed", doll: commit.doll };
}
