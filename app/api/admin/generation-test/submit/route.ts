import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { prepareInputImage } from "@/lib/image-utils";
import { uploadFaceTmp } from "@/lib/character-gen/upload-face";
import {
  GENERATION_IMAGE_MAX_BYTES,
  generationContentLengthAllowed,
  readGenerationFormData,
} from "@/lib/character-gen/request-boundary";
import {
  GENERATION_TEST_SETTINGS_MAX_BYTES,
  buildGenerationTestSubmissions,
  parseGenerationTestSettings,
} from "@/lib/character-gen/generation-testbench";
import { FIXED_FLUX } from "@/lib/character-gen/plan";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
// 업로드 + 정규화 + queue 제출(≤6건)만 — 즉시 반환(결과는 status 라우트 폴링).
export const maxDuration = 30;

// 이미지 + settings JSON(자체 상한 별도 강제) + multipart 오버헤드.
const TEST_FORM_MAX_BODY_BYTES =
  GENERATION_IMAGE_MAX_BYTES + GENERATION_TEST_SETTINGS_MAX_BYTES + 64 * 1024;

// SDK 타입맵은 max_sequence_length 를 문자열 enum 으로 선언하지만 실계약(운영 raw 제출 경로)은
// number — 벤치는 운영과 동일한 payload 형태를 검증해야 하므로 endpoint 를 넓혀 우회한다.
const FLUX_PULID_ENDPOINT: string = FIXED_FLUX.model;

// flux 계열 seed 는 32bit 정수 관례 — 두 seed 를 서버가 한 번 뽑아 전 설정에 재사용(공정 비교).
function pickSeedPair(): [number, number] {
  const first = randomInt(0, 2147483647);
  let second = randomInt(0, 2147483647);
  while (second === first) {
    second = randomInt(0, 2147483647);
  }
  return [first, second];
}

/**
 * 어드민 생성 config A/B 테스트 제출 — 세션 내 일회성(어디에도 저장 없음).
 * 크레딧/ai_generations/유저 생성 파이프라인 절대 무접촉. 원본 사진은 기존 tmp/face 규약으로
 * 업로드해 12분 고아 sweep(ops/content-maintain)이 자동 정리한다(원본 영구 저장 금지 정책 #1).
 * 설정 ≤3·설정당 2장(동일 seed 쌍)·총 이미지 ≤6 서버 강제. fal 제출당 실비 과금.
 */
export async function POST(req: NextRequest) {
  if (
    !generationContentLengthAllowed(
      req.headers.get("content-length"),
      TEST_FORM_MAX_BODY_BYTES,
    )
  ) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }

  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const formRead = await readGenerationFormData(req, TEST_FORM_MAX_BODY_BYTES);
  if (!formRead.ok) {
    return NextResponse.json(
      { error: formRead.error },
      { status: formRead.error === "body_too_large" ? 413 : 400 },
    );
  }
  const form = formRead.form;

  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "image_required" }, { status: 400 });
  }
  if (file.size > GENERATION_IMAGE_MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", maxMB: 10 },
      { status: 400 },
    );
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "not_an_image" }, { status: 400 });
  }

  const settings = parseGenerationTestSettings(form.get("settings"));
  if (!settings) {
    return NextResponse.json({ error: "invalid_settings" }, { status: 400 });
  }

  let prepared: Buffer;
  try {
    prepared = await prepareInputImage(await file.arrayBuffer());
  } catch (e) {
    log.error("admin.gen_test_input_prep_fail", {
      adminId: gate.user.id,
      fileSize: file.size,
      fileType: file.type,
      ...errInfo(e),
    });
    return NextResponse.json({ error: "input_prep_failed" }, { status: 400 });
  }

  // 결정적 정리 없음(세션 일회성) — tmp/face 경로 자체가 12분 sweep 대상이라 신규 정리 인프라 금지.
  let uploaded;
  try {
    uploaded = await uploadFaceTmp(gate.user.id, randomUUID(), prepared);
  } catch (error) {
    log.warn("admin.gen_test_face_upload_fail", {
      adminId: gate.user.id,
      ...errInfo(error),
    });
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const seeds = pickSeedPair();
  const submissions = buildGenerationTestSubmissions(
    settings,
    uploaded.url,
    seeds,
  );

  const requests = await Promise.all(
    submissions.map(async (submission) => {
      try {
        const enqueued = await fal.queue.submit(FLUX_PULID_ENDPOINT, {
          input: submission.input,
        });
        return {
          settingIndex: submission.settingIndex,
          imageIndex: submission.imageIndex,
          requestId: enqueued.request_id,
        };
      } catch (error) {
        // 벤치는 원장 없음 — 실패 칸은 null 로 표기만 하고 재시도하지 않는다(실비 중복 방지).
        log.warn("admin.gen_test_submit_fail", {
          adminId: gate.user.id,
          settingIndex: submission.settingIndex,
          imageIndex: submission.imageIndex,
          ...errInfo(error),
        });
        return {
          settingIndex: submission.settingIndex,
          imageIndex: submission.imageIndex,
          requestId: null as string | null,
        };
      }
    }),
  );

  log.info("admin.gen_test_submitted", {
    adminId: gate.user.id,
    settingCount: settings.length,
    imageCount: submissions.length,
    acknowledgedCount: requests.filter((r) => r.requestId !== null).length,
  });

  return NextResponse.json({ faceUrl: uploaded.url, seeds, requests });
}
