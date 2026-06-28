import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { isDomainKey } from "@/lib/config/keys";
import { getEntry } from "@/lib/config/registry";
import { updateSetting } from "@/lib/config/write";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 마케터 설정 발행 — requireAdmin → 도메인 schema 검증 → admin_update_app_setting(CAS+감사 원자) → revalidate.
 * 주 방어선 = requireAdmin + server-only service_role(client direct write 금지). 검증은 도메인 entry.schema.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { key?: string; value?: unknown; baseVersion?: number; note?: string }
    | null;
  if (!body || typeof body.key !== "string" || typeof body.baseVersion !== "number") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!isDomainKey(body.key)) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }
  const entry = getEntry(body.key);
  if (!entry) {
    // 레지스트리 미등록 도메인(해당 PR 전) — 발행 불가.
    return NextResponse.json({ error: "domain_not_ready" }, { status: 400 });
  }

  const parsed = entry.schema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues.slice(0, 30) },
      { status: 400 }
    );
  }

  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  const res = await updateSetting(body.key, parsed.data, body.baseVersion, gate.user.id, note);
  if (!res.ok) {
    log.warn("config.update_fail", { key: body.key, adminId: gate.user.id, error: res.error });
    return NextResponse.json(
      { error: res.error },
      { status: res.error === "version_conflict" ? 409 : 400 }
    );
  }
  // media_config 는 텍스트 config 와 달리 렌더(layout metadata·로고)에 박힘 → 도메인 tag 외에
  // layout/metadata 소비 경로도 무효화(og:image·twitter·로고 즉시 반영). 다른 도메인은 tag 로 충분.
  if (body.key === "media_config") {
    revalidatePath("/", "layout");
    revalidatePath("/");
    revalidatePath("/login");
  }
  log.info("config.update_ok", { key: body.key, adminId: gate.user.id, version: res.version });
  return NextResponse.json({ ok: true, version: res.version });
}
