import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import {
  ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES,
  readAdminJsonRequest,
} from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import { legalSectionsSchema, DOC_PATH, type DocType } from "@/lib/legal/types";
import {
  parseLegalPublishResult,
  parseLegalSaveResult,
  parseLegalUnpublishResult,
} from "@/lib/legal/mutation-result";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { ownRecordValue } from "@/lib/own-record";

const operationId = z.string().uuid();
const docType = z.enum(["privacy", "terms"]);
const bodySchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save_draft"),
      docType,
      operationId,
      baseUpdatedAt: z.string().datetime({ offset: true }).nullable(),
      title: z.string().trim().min(1).max(200),
      sections: legalSectionsSchema,
      publicNote: z.string().trim().max(1000).nullish(),
      adminNote: z.string().trim().max(2000).nullish(),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      docType,
      operationId,
      effectiveDate: z.iso.date(),
      draftId: z.string().uuid(),
      draftUpdatedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      action: z.literal("unpublish"),
      docType,
      operationId,
      reservationId: z.string().uuid(),
      reservationVersion: z.number().int().positive().max(2_147_483_647),
    })
    .strict(),
]);

// RPC 예외 → 안전한 공개 메시지. 알 수 없는 DB 메시지는 절대 반사하지 않는다.
const KNOWN_ERRORS: Record<string, { message: string; status: number }> = {
  not_admin: { message: "관리자 권한이 필요해요.", status: 403 },
  no_draft: {
    message: "먼저 초안을 저장한 뒤 발행하세요.",
    status: 409,
  },
  reservation_exists: {
    message: "이미 시행 예정본이 있어요. 먼저 발행취소한 뒤 수정·재발행하세요.",
    status: 409,
  },
  no_reservation: {
    message: "취소할 시행 예정본이 없어요(시행된 버전은 취소할 수 없어요).",
    status: 409,
  },
  no_change: {
    message: "직전 발행본과 내용·시행일이 같아 발행할 변경이 없어요.",
    status: 409,
  },
  version_conflict: {
    message: "다른 변경이 먼저 반영됐어요. 새로고침한 뒤 다시 시도하세요.",
    status: 409,
  },
  request_conflict: {
    message:
      "같은 작업 ID가 다른 요청에 사용됐어요. 새로고침한 뒤 다시 시도하세요.",
    status: 409,
  },
  operation_id_required: {
    message: "작업 ID가 필요해요.",
    status: 400,
  },
  effective_date_required: {
    message: "시행일을 입력하세요.",
    status: 400,
  },
  effective_date_past: {
    message: "시행일은 오늘(KST) 이후여야 해요.",
    status: 400,
  },
  invalid_sections: {
    message:
      "섹션 형식/길이를 확인하세요(섹션 1~50개, 제목 120자·본문 20,000자 이내).",
    status: 400,
  },
  invalid_title: {
    message: "제목을 확인하세요(1~200자).",
    status: 400,
  },
  invalid_public_note: {
    message: "공개 개정 사유는 1,000자 이하여야 해요.",
    status: 400,
  },
  invalid_admin_note: {
    message: "내부 메모는 2,000자 이하여야 해요.",
    status: 400,
  },
  invalid_doc_type: { message: "잘못된 문서 종류예요.", status: 400 },
};

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(
    req,
    ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES,
  );
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value;
  const refresh = legacyAdminClientRefresh("legal", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const b = parsed.data;
  const docType = b.docType as DocType;
  const admin = createAdminClient();

  try {
    if (b.action === "save_draft") {
      const { data, error } = await admin.rpc("admin_save_legal_draft", {
        p_doc_type: docType,
        p_title: b.title,
        p_sections: b.sections,
        p_public_note: b.publicNote ?? null,
        p_admin_note: b.adminNote ?? null,
        p_admin_id: gate.user.id,
        p_operation_id: b.operationId,
        p_base_updated_at: b.baseUpdatedAt,
      });
      if (error) throw new Error(error.message);
      return NextResponse.json(parseLegalSaveResult(data));
    }

    if (b.action === "unpublish") {
      // 시행 전 예약본 취소 → 예약 해제 + (draft 없으면) 내용을 draft 로 복원.
      const { data, error } = await admin.rpc("admin_unpublish_legal", {
        p_doc_type: docType,
        p_admin_id: gate.user.id,
        p_operation_id: b.operationId,
        p_expected_reservation_id: b.reservationId,
        p_expected_reservation_version: b.reservationVersion,
      });
      if (error) throw new Error(error.message);
      revalidatePath(DOC_PATH[docType]);
      revalidatePath("/");
      revalidateTag("legal-versions", "max"); // 현재 발행본 버전 캐시 즉시 무효화(동의 게이트 즉시 반영)
      return NextResponse.json(parseLegalUnpublishResult(data));
    }

    // publish — 저장된 draft 를 새 발행 버전으로(에디터가 발행 직전 save_draft 선행).
    const { data, error } = await admin.rpc("admin_publish_legal", {
      p_doc_type: docType,
      p_effective_date: b.effectiveDate,
      p_admin_id: gate.user.id,
      p_operation_id: b.operationId,
      p_expected_draft_id: b.draftId,
      p_expected_draft_updated_at: b.draftUpdatedAt,
    });
    if (error) throw new Error(error.message);
    revalidatePath(DOC_PATH[docType]);
    revalidatePath("/");
    revalidateTag("legal-versions", "max"); // 현재 발행본 버전 캐시 즉시 무효화(동의 게이트 즉시 반영)
    return NextResponse.json(parseLegalPublishResult(data));
  } catch (e) {
    const code = (e as { message?: string })?.message ?? "update_failed";
    const known = ownRecordValue(KNOWN_ERRORS, code);
    return NextResponse.json(
      known ? { error: known.message, code } : { error: "update_failed" },
      { status: known?.status ?? 500 },
    );
  }
}
