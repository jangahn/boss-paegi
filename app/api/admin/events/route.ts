import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import {
  ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES,
  readAdminJsonRequest,
} from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import { eventSaveSchema } from "@/lib/events/types";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import { parseAdminEventMutationResult } from "@/lib/admin-mutation";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("action", [
  eventSaveSchema.extend({
    action: z.literal("save"),
    expectedVersion: z.number().int().min(0),
    requestId: z.string().uuid(),
    targetKey: z.string().min(1).max(200),
  }),
  z.object({
    action: z.literal("publish"),
    id: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("unpublish"),
    id: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
  }),
]);

// RPC 예외 → 한국어. (그 외는 update_failed 500)
const ERR_KO: Record<string, string> = {
  not_admin: "관리자 권한이 필요해요.",
  not_found: "대상 글을 찾을 수 없어요(삭제되었을 수 있어요).",
  invalid_type: "글 타입을 확인하세요(공지/이벤트).",
  invalid_title: "제목을 확인하세요(1~200자).",
  invalid_summary: "요약/배너 문구를 확인하세요(1~200자).",
  invalid_body: "본문을 확인하세요(1~50,000자).",
  invalid_window: "노출 시작은 종료보다 앞서야 해요.",
  invalid_dismiss_days: "팝업 '안보기' 일수를 확인하세요(1~365).",
  invalid_cover:
    "커버 이미지는 events 버킷 경로만 허용돼요(외부 URL·SVG 불가).",
  version_conflict: "다른 탭에서 글이 변경됐어요. 새로고침 후 다시 시도하세요.",
  idempotency_conflict: "같은 요청 번호의 내용이 달라 결과 확인이 필요해요.",
  request_aborted: "이전 미확정 요청은 적용되지 않았어요. 다시 시도하세요.",
  target_key_invalid: "저장 요청 식별자가 올바르지 않아요.",
};

/** KST datetime-local(YYYY-MM-DDTHH:mm) → timestamptz ISO(+09:00). 빈값 null. */
function kstLocalToIso(s: string | null): string | null {
  if (!s) return null;
  const t = s.length === 16 ? `${s}:00` : s; // 초 보강
  return `${t}+09:00`;
}

// 발행/수정/삭제 시 공개 지면 + 캐시 태그 무효화(개별 호출).
function revalidateEvents(id?: string) {
  revalidateTag("events", "max");
  revalidatePath("/");
  revalidatePath("/news");
  revalidatePath("/leaderboard");
  revalidatePath("/gallery");
  if (id) revalidatePath(`/news/${id}`);
}

function eventMutationPayload(data: unknown): {
  ok: true;
  id: string;
  version: number;
  state?: string;
} {
  const parsed = parseAdminEventMutationResult(data);
  if (!parsed) throw new Error("invalid_rpc_response");
  return parsed;
}

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
  const refresh = legacyAdminClientRefresh("events", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const b = parsed.data;
  const admin = createAdminClient();

  try {
    if (b.action === "save") {
      const { data, error } = await admin.rpc("admin_save_event_idempotent", {
        p_id: b.id ?? null,
        p_type: b.type,
        p_title: b.title,
        p_summary: b.summary,
        p_body: b.body,
        p_cover_image_path: b.coverImagePath ?? null,
        p_starts_at: kstLocalToIso(b.startsAt ?? null),
        p_ends_at: kstLocalToIso(b.endsAt ?? null),
        p_popup_active: b.popupActive,
        p_banner_home_active: b.bannerHomeActive,
        p_banner_gallery_active: b.bannerGalleryActive,
        p_banner_leaderboard_active: b.bannerLeaderboardActive,
        p_priority: b.priority,
        p_pinned: b.pinned,
        p_noindex: b.noindex,
        p_popup_dismiss_days: b.popupDismissDays,
        p_admin_id: gate.user.id,
        p_expected_version: b.expectedVersion,
        p_request_id: b.requestId,
        p_target_key: b.targetKey,
      });
      if (error) throw new Error(error.message);
      const payload = eventMutationPayload(data);
      revalidateEvents(payload.id);
      return NextResponse.json(payload);
    }

    const requestId = deterministicAdminRequestId(
      `event_${b.action}`,
      gate.user.id,
      b.id,
      b,
    );
    const { data, error } = await admin.rpc(
      "admin_transition_event_idempotent",
      {
        p_id: b.id,
        p_action: b.action,
        p_expected_version: b.expectedVersion,
        p_admin_id: gate.user.id,
        p_request_id: requestId,
      },
    );
    if (error) throw new Error(error.message);
    const payload = eventMutationPayload(data);
    revalidateEvents(b.id);
    return NextResponse.json(payload);
  } catch (e) {
    const message = (e as { message?: string })?.message ?? "update_failed";
    const code = Object.keys(ERR_KO).find((candidate) =>
      message.includes(candidate),
    );
    const known = code ? ERR_KO[code] : undefined;
    return NextResponse.json(
      known ? { error: known, code } : { error: "update_failed" },
      {
        status:
          code === "version_conflict" ||
          code === "idempotency_conflict" ||
          code === "request_aborted"
            ? 409
            : known
              ? 400
              : 500,
      },
    );
  }
}
