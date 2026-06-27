import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDocType, legalSectionsSchema, DOC_PATH, type DocType } from "@/lib/legal/types";

const bodySchema = z.object({
  action: z.enum(["save_draft", "publish", "unpublish"]),
  docType: z.string(),
  title: z.string().trim().min(1).max(200).optional(),
  sections: legalSectionsSchema.optional(),
  publicNote: z.string().trim().max(1000).nullish(),
  adminNote: z.string().trim().max(2000).nullish(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// RPC 예외 → 한국어. (그 외는 update_failed 500)
const ERR_KO: Record<string, string> = {
  not_admin: "관리자 권한이 필요해요.",
  no_draft: "먼저 초안을 저장한 뒤 발행하세요.",
  reservation_exists: "이미 시행 예정본이 있어요. 먼저 발행취소한 뒤 수정·재발행하세요.",
  no_reservation: "취소할 시행 예정본이 없어요(시행된 버전은 취소할 수 없어요).",
  no_change: "직전 발행본과 내용·시행일이 같아 발행할 변경이 없어요.",
  effective_date_required: "시행일을 입력하세요.",
  effective_date_past: "시행일은 오늘(KST) 이후여야 해요.",
  invalid_sections: "섹션 형식/길이를 확인하세요(섹션 1~50개, 제목 120자·본문 20,000자 이내).",
  invalid_title: "제목을 확인하세요(1~200자).",
  invalid_doc_type: "잘못된 문서 종류예요.",
};

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const b = parsed.data;
  if (!isDocType(b.docType)) {
    return NextResponse.json({ error: "invalid_doc_type" }, { status: 400 });
  }
  const docType = b.docType as DocType;
  const admin = createAdminClient();

  try {
    if (b.action === "save_draft") {
      if (!b.title || !b.sections) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }
      const { data, error } = await admin.rpc("admin_save_legal_draft", {
        p_doc_type: docType,
        p_title: b.title,
        p_sections: b.sections,
        p_public_note: b.publicNote ?? null,
        p_admin_note: b.adminNote ?? null,
        p_admin_id: gate.user.id,
      });
      if (error) throw new Error(error.message);
      return NextResponse.json(data ?? { ok: true });
    }

    if (b.action === "unpublish") {
      // 시행 전 예약본 취소 → 예약 해제 + (draft 없으면) 내용을 draft 로 복원.
      const { data, error } = await admin.rpc("admin_unpublish_legal", {
        p_doc_type: docType,
        p_admin_id: gate.user.id,
      });
      if (error) throw new Error(error.message);
      revalidatePath(DOC_PATH[docType]);
      revalidatePath("/");
      revalidateTag("legal-versions", "max"); // 현재 발행본 버전 캐시 즉시 무효화(동의 게이트 즉시 반영)
      return NextResponse.json(data ?? { ok: true });
    }

    // publish — 저장된 draft 를 새 발행 버전으로(에디터가 발행 직전 save_draft 선행).
    if (!b.effectiveDate) {
      return NextResponse.json({ error: "effective_date_required" }, { status: 400 });
    }
    const { data, error } = await admin.rpc("admin_publish_legal", {
      p_doc_type: docType,
      p_effective_date: b.effectiveDate,
      p_admin_id: gate.user.id,
    });
    if (error) throw new Error(error.message);
    revalidatePath(DOC_PATH[docType]);
    revalidatePath("/");
    revalidateTag("legal-versions", "max"); // 현재 발행본 버전 캐시 즉시 무효화(동의 게이트 즉시 반영)
    return NextResponse.json(data ?? { ok: true });
  } catch (e) {
    const code = (e as { message?: string })?.message ?? "update_failed";
    const known = ERR_KO[code];
    return NextResponse.json(
      { error: known ?? "update_failed", code },
      { status: known ? 400 : 500 }
    );
  }
}
