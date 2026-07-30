import { NextResponse } from "next/server";

import { requireMember, memberGateResponse } from "@/lib/auth-server";
import {
  GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
  isGenerationProviderAcceptanceRequest,
  parseGenerationProviderAcceptanceAck,
} from "@/lib/generation-provider-acceptance";
import {
  generationCostPathEnabled,
  GENERATION_COST_FROZEN_BODY,
} from "@/lib/generation-cost-rollout";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { log, errInfo } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 25;

const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
} as const;

export async function POST(req: Request) {
  if (!generationCostPathEnabled()) {
    return NextResponse.json(GENERATION_COST_FROZEN_BODY, {
      status: 503,
      headers: NO_STORE,
    });
  }

  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status, headers: NO_STORE },
    );
  }
  if (!isGenerationProviderAcceptanceRequest(requestBody.value)) {
    return NextResponse.json(
      { error: "generation_provider_acceptance_required" },
      { status: 400, headers: NO_STORE },
    );
  }

  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .rpc(
        "record_generation_provider_acceptance",
        {
          p_user_id: gate.user.id,
          p_request_id: requestBody.value.requestId,
          p_bundle_version: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
          p_adult_self_attested: true,
          p_fal_terms_accepted: true,
          p_fal_aup_accepted: true,
        },
      )
      .abortSignal(AbortSignal.timeout(15_000));
    if (error) throw error;
    const ack = parseGenerationProviderAcceptanceAck(data);
    return NextResponse.json(
      {
        ok: true,
        eligible: true,
        requestId: requestBody.value.requestId,
        bundleVersion: ack.bundleVersion,
        acceptedAt: ack.acceptedAt,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    log.error("generation.provider_acceptance_write_fail", {
      userId: gate.user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
