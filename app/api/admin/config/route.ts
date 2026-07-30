import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import {
  ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES,
  readAdminJsonRequest,
} from "@/lib/http/admin-json-request";
import { isDomainKey } from "@/lib/config/keys";
import { getEntry } from "@/lib/config/registry";
import { updateSetting } from "@/lib/config/write";
import { getConfigAuditEntry } from "@/lib/config/audit";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 설정 발행/복원 — requireAdmin → 도메인 schema 검증 → admin_update_app_setting(CAS+감사 원자) → revalidate.
 * 주 방어선 = requireAdmin + server-only service_role(client direct write 금지). 검증은 도메인 entry.schema.
 *   publish: {key, value, baseVersion, note?} — 에디터 발행.
 *   restore: {action:"restore", key, auditId, baseVersion} — 감사행(auditId)의 new_value 를 재발행.
 *     클라는 복원 value/version/note 를 보내지 않음(서버가 감사행에서 조회). 복원도 새 감사 버전으로 남음.
 */
export async function POST(req: NextRequest) {
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
  const body = requestBody.value as
    | {
        action?: "publish" | "restore";
        key?: string;
        value?: unknown;
        baseVersion?: number;
        note?: string;
        auditId?: string;
      }
    | null;
  if (
    !body ||
    typeof body.key !== "string" ||
    typeof body.baseVersion !== "number" ||
    !Number.isSafeInteger(body.baseVersion) ||
    body.baseVersion < 0
  ) {
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

  // 발행할 value·note 결정 — restore 는 감사행(서버 조회), publish 는 클라 value.
  let value: unknown;
  let note: string | null;
  if (body.action === "restore") {
    if (typeof body.auditId !== "string") {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    const target = await getConfigAuditEntry(body.key, body.auditId);
    if (!target) {
      // 없거나 타 도메인 auditId — 복원 대상 아님.
      return NextResponse.json({ error: "target_not_found" }, { status: 404 });
    }
    value = target.newValue;
    note = `restore v${target.newVersion}`;
  } else {
    value = body.value;
    note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  }

  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues.slice(0, 30) },
      { status: 400 }
    );
  }

  const requestId = deterministicAdminRequestId(
    "config_update",
    gate.user.id,
    body.key,
    {
      baseVersion: body.baseVersion,
      key: body.key,
      note,
      value: parsed.data,
    },
  );
  const res = await updateSetting(
    body.key,
    parsed.data,
    body.baseVersion,
    gate.user.id,
    note,
    requestId,
  );
  if (!res.ok) {
    log.warn("config.update_fail", { key: body.key, adminId: gate.user.id, error: res.error });
    return NextResponse.json(
      { error: res.error },
      {
        status:
          res.error === "version_conflict"
            ? 409
            : res.error === "update_failed"
              ? 500
              : 400,
      }
    );
  }
  // media_config·business_info 는 텍스트 config 와 달리 렌더(layout metadata·로고·푸터)에 박힘 →
  // 도메인 tag 외에 layout 소비 경로도 무효화(og:image·로고·사업자정보 푸터 즉시 반영 — businessInfo 가
  // site_content 에 있던 시절 발행이 ISR 페이지에 반영되지 않아 수동 재배포가 필요했던 갭의 해소).
  // 다른 도메인은 tag 로 충분.
  if (body.key === "media_config" || body.key === "business_info") {
    revalidatePath("/", "layout");
    revalidatePath("/");
    revalidatePath("/login");
  }
  log.info("config.update_ok", { key: body.key, adminId: gate.user.id, version: res.version });
  return NextResponse.json({ ok: true, version: res.version });
}
