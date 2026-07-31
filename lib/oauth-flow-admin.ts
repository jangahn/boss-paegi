import "server-only";

import { createAdminClient } from "./supabase/admin.ts";
import {
  requireSupabaseData,
} from "./supabase-operation.ts";
import type { OAuthFlowProof } from "./oauth-flow-proof.ts";
import {
  parseOAuthFlowStatusReadReceipt,
  type OAuthFlowStatus,
} from "./oauth-flow-status.ts";

export class OAuthFlowStatusNotFoundError extends Error {
  constructor() {
    super("oauth_flow_status_not_found");
    this.name = "OAuthFlowStatusNotFoundError";
  }
}

export async function readOAuthFlowStatusStrict(
  proof: OAuthFlowProof,
  signal: AbortSignal,
): Promise<OAuthFlowStatus> {
  const value = await requireSupabaseData<unknown>(
    "auth.oauth_flow_status",
    () =>
      createAdminClient()
        .rpc("read_oauth_flow_intent_status", {
          p_flow_id: proof.flowId,
          p_source_user_id: proof.sourceUserId,
          p_source_session_id: proof.sourceSessionId,
          p_provider: proof.provider,
        })
        .abortSignal(signal),
  );
  const parsed = parseOAuthFlowStatusReadReceipt(
    value,
    proof.flowId,
  );
  if (!parsed) throw new Error("invalid_oauth_flow_status_receipt");
  if (parsed.kind === "absent") {
    throw new OAuthFlowStatusNotFoundError();
  }
  return parsed.status;
}
