import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { parseGenerationTestStatusRequest } from "@/lib/character-gen/generation-testbench";
import { parseFluxPulidResult } from "@/lib/character-gen/flux-pulid-result-contract";
import { FIXED_FLUX } from "@/lib/character-gen/plan";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 30;

export type GenerationTestStatus = {
  requestId: string;
  status: "in_queue" | "in_progress" | "completed" | "failed";
  // fal 결과 URL 직반환(세션 표시용, 저장 안 함). NSFW 차단분은 imageUrl 없이 nsfw 만 true.
  imageUrl?: string;
  seed?: number;
  nsfw?: boolean;
};

/**
 * 테스트 벤치 상태 프록시 — {requestIds[]} → fal queue status/result. 세션 일회성(저장 없음),
 * 크레딧/ai_generations 무접촉. 결과 검증은 parseFluxPulidResult 재사용
 * (fal 결과 content_type 은 image/png 가 실계약 — png/jpeg 모두 허용).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const requestIds = parseGenerationTestStatusRequest(requestBody.value);
  if (!requestIds) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const results: GenerationTestStatus[] = await Promise.all(
    requestIds.map(async (requestId): Promise<GenerationTestStatus> => {
      try {
        const status = await fal.queue.status(FIXED_FLUX.model, { requestId });
        if (status.status === "IN_QUEUE") {
          return { requestId, status: "in_queue" };
        }
        if (status.status === "IN_PROGRESS") {
          return { requestId, status: "in_progress" };
        }
        if (status.status !== "COMPLETED") {
          return { requestId, status: "failed" };
        }
        const result = await fal.queue.result(FIXED_FLUX.model, { requestId });
        const parsed = parseFluxPulidResult(result.data);
        if (!parsed) {
          return { requestId, status: "failed" };
        }
        if (parsed.nsfw) {
          return { requestId, status: "completed", nsfw: true };
        }
        return {
          requestId,
          status: "completed",
          imageUrl: parsed.image.url,
          seed: parsed.seed,
        };
      } catch (error) {
        log.warn("admin.gen_test_status_fail", {
          adminId: gate.user.id,
          ...errInfo(error),
        });
        return { requestId, status: "failed" };
      }
    }),
  );

  return NextResponse.json(results);
}
