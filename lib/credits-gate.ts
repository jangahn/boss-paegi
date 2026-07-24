import "server-only";
import { NextResponse } from "next/server";
import { SERVER_ENV } from "@/lib/env.server";

/**
 * Phase-A 크레딧 유지보수 게이트(v0.76 환불 saga 컷오버 — runbook 스텝 1·2·15·19).
 *
 * `CREDITS_MAINTENANCE_MODE`:
 * - `open`(기본): 게이트 무동작.
 * - `closed`: **신규 money 진입만** 차단(503 `service_maintenance`) — checkout·생성 소비·가입 보너스·
 *   어드민 조정·환불 begin/process·신규 cancel intent·credit-mutating 탈퇴. 저장된 종결 경로
 *   (mark_paid_and_grant finalizer·웹훅·reconcile·order-status·credit-expire·이미 시작된 생성 종결)는
 *   **호출하지 않는다** — drain 을 막으면 컷오버가 불가능하다.
 * - `canary`: 사용자 진입은 `CREDITS_CANARY_USER_IDS` allowlist 계정만 허용, 어드민 조작은 허용
 *   (canary 검증은 오퍼레이터가 수행).
 *
 * 이 게이트는 0062 객체를 참조하지 않는다(Phase-A 는 0062 배포 전 상태의 코드로 동작).
 */
export type CreditsGateMode = "open" | "closed" | "canary";

export function creditsGateMode(): CreditsGateMode {
  const raw = SERVER_ENV.CREDITS_MAINTENANCE_MODE.trim().toLowerCase();
  if (raw === "closed" || raw === "canary") return raw;
  return "open"; // 미설정·미지값은 open(동작 무변화) — 게이트 오설정이 서비스를 잠그지 않게.
}

function canaryUserIds(): Set<string> {
  return new Set(
    SERVER_ENV.CREDITS_CANARY_USER_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * write-entry 라우트 선두에서 호출 — 차단이면 503 응답을, 통과면 null 을 돌려준다.
 * `actor: "user"` 는 userId 가 canary allowlist 에 있어야 canary 통과.
 * `actor: "admin"` 은 canary 에서 항상 통과(closed 에서만 차단).
 */
export function assertWriteAllowed(
  ctx: { actor: "user"; userId: string } | { actor: "admin" }
): NextResponse | null {
  const mode = creditsGateMode();
  if (mode === "open") return null;
  if (mode === "canary") {
    if (ctx.actor === "admin") return null;
    if (canaryUserIds().has(ctx.userId)) return null;
  }
  return NextResponse.json({ error: "service_maintenance" }, { status: 503 });
}
