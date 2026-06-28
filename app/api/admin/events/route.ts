import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { eventSaveSchema } from "@/lib/events/types";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("action", [
  eventSaveSchema.extend({ action: z.literal("save") }),
  z.object({ action: z.literal("publish"), id: z.string().uuid() }),
  z.object({ action: z.literal("unpublish"), id: z.string().uuid() }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
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
  invalid_cover: "커버 이미지는 events 버킷 경로만 허용돼요(외부 URL·SVG 불가).",
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

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const b = parsed.data;
  const admin = createAdminClient();

  try {
    if (b.action === "save") {
      const { data, error } = await admin.rpc("admin_save_event", {
        p_id: b.id ?? null,
        p_type: b.type,
        p_title: b.title,
        p_summary: b.summary,
        p_body: b.body,
        p_cover_image_path: b.coverImagePath ?? null,
        p_starts_at: kstLocalToIso(b.startsAt ?? null),
        p_ends_at: kstLocalToIso(b.endsAt ?? null),
        p_popup_active: b.popupActive,
        p_banner_active: b.bannerActive,
        p_priority: b.priority,
        p_pinned: b.pinned,
        p_noindex: b.noindex,
        p_popup_dismiss_days: b.popupDismissDays,
        p_admin_id: gate.user.id,
      });
      if (error) throw new Error(error.message);
      const id = data as string;
      revalidateEvents(id);
      return NextResponse.json({ ok: true, id });
    }

    const fn =
      b.action === "publish"
        ? "admin_publish_event"
        : b.action === "unpublish"
          ? "admin_unpublish_event"
          : "admin_delete_event";
    const { data, error } = await admin.rpc(fn, { p_id: b.id, p_admin_id: gate.user.id });
    if (error) throw new Error(error.message);
    revalidateEvents(b.id);
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
