import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOLLS_BUCKET, dollPath } from "@/lib/storage-path";
import { DOLL_THUMB_TRANSFORM } from "@/lib/storage";
import { signDollPaths } from "@/lib/doll-signed-url-batch";
import { log, errInfo } from "@/lib/log";
import { requireSupabaseRows } from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { publicWriteNetworkActorKey } from "@/lib/public-write-quota";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 50;

/**
 * 클라(갤러리·게임) 전용 doll signed URL 배치 발급. private 버킷 전환 후 클라가 직접 path 서명 못 하므로.
 * 하드닝: **id 로 DB 조회한 path 만 서명**(클라가 보낸 path 직접 서명 절대 X) · UUID 검증 · ids ≤50 ·
 *   deleted_at/조회 race id 는 missingIds(클라 행 제거) · **no-store**(만료 URL 캐싱 방지) ·
 *   비가역 network actor + 전역 DB 원자 quota. 인증 불요.
 * 성능: `createSignedUrls`(복수) 1회 호출로 N path 서명(갤러리 N개 doll 도 round-trip 1번).
 */
export async function POST(req: NextRequest) {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status, ...noStore },
    );
  }
  const body = requestBody.value as {
    ids?: unknown;
    ttl?: unknown;
    thumb?: unknown;
  };
  const thumb = body?.thumb === true; // 작은 표시용 384px 변환(갤러리·게임종료 등)
  if (
    !Array.isArray(body?.ids) ||
    body.ids.length > MAX_IDS ||
    body.ids.some(
      (value) => typeof value !== "string" || !UUID_RE.test(value),
    )
  ) {
    return NextResponse.json(
      { error: "invalid_ids" },
      { status: 400, ...noStore },
    );
  }
  const ids = [...new Set(body.ids as string[])];
  // ttl 옵션(cap 3600): 게임은 본인 캐릭터 장기세션 위해 길게(공개표면 아님), 갤러리 등은 기본 600.
  const ttl =
    typeof body?.ttl === "number" && body.ttl > 0
      ? Math.min(3600, Math.floor(body.ttl))
      : 600;

  const urls: Record<string, string> = {};
  if (ids.length === 0) {
    return NextResponse.json({ urls, missingIds: [] }, noStore);
  }

  const actorKey = publicWriteNetworkActorKey(req.headers);
  if (!actorKey) {
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503, ...noStore },
    );
  }
  const admin = createAdminClient();
  const { data: quotaData, error: quotaError } = await admin.rpc(
    "consume_doll_signed_url_quota",
    {
      p_actor_key: actorKey,
      p_units: ids.length,
    },
  );
  if (quotaError || quotaData !== "accepted") {
    const quotaExceeded =
      quotaData === "global_request_quota" ||
      quotaData === "actor_request_quota";
    log.warn("signurls.quota_blocked", {
      count: ids.length,
      outcome: typeof quotaData === "string" ? quotaData : "invalid",
      ...errInfo(quotaError),
    });
    return NextResponse.json(
      {
        error: quotaExceeded
          ? "rate_limited"
          : "service_unavailable",
      },
      {
        status: quotaExceeded ? 429 : 503,
        ...noStore,
      },
    );
  }

  let dolls: Array<{
    id: string;
    image_url: string;
    deleted_at: string | null;
  }>;
  try {
    const raw = await requireSupabaseRows(
      "doll.signed_urls.lookup",
      () =>
        admin
          .from("dolls")
          .select("id, image_url, deleted_at")
          .in("id", ids),
    );
    dolls = validateAdminRows("doll.signed_urls.lookup", raw, {
      id: "uuid",
      image_url: "string",
      deleted_at: "nullableTimestamp",
    });
  } catch (error) {
    log.error("signurls.query_fail", {
      count: ids.length,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "lookup_failed" },
      { status: 500, ...noStore },
    );
  }

  // 삭제(takedown) 아닌 doll 의 path 만 모아 일괄 서명. id→path 매핑 유지.
  const pathById = new Map<string, string>();
  for (const d of dolls) {
    if (d.deleted_at) continue; // 신규 서명 중단 → missingIds로 stale 클라 행 제거
    const p = dollPath(d.image_url);
    if (!p) {
      log.error("signurls.invalid_active_doll_path", { dollId: d.id });
      return NextResponse.json(
        { error: "invalid_doll_path" },
        { status: 500, ...noStore },
      );
    }
    pathById.set(d.id, p);
  }
  const paths = [...new Set(pathById.values())];
  if (paths.length) {
    const signed = await signDollPaths({
      paths,
      thumb,
      signOne: (path) =>
        admin.storage
          .from(DOLLS_BUCKET)
          .createSignedUrl(path, ttl, { transform: DOLL_THUMB_TRANSFORM }),
      signMany: (nextPaths) =>
        admin.storage.from(DOLLS_BUCKET).createSignedUrls(nextPaths, ttl),
    });
    if (!signed.ok) {
      log.error("signurls.storage_sign_fail", {
        count: paths.length,
        failedCount: signed.failedPaths.length,
        thumb,
        ...errInfo(signed.error),
      });
      return NextResponse.json(
        { error: "sign_failed" },
        { status: 502, ...noStore },
      );
    }
    for (const [id, p] of pathById) {
      const url = signed.byPath.get(p);
      if (!url) {
        log.error("signurls.batch_ack_incomplete", { dollId: id });
        return NextResponse.json(
          { error: "sign_failed" },
          { status: 502, ...noStore },
        );
      }
      urls[id] = url;
    }
  }
  // 미발견/삭제 id 는 명시적으로 분리한다. 클라는 해당 stale 행만 제거하고,
  // 서명 누락/손상 응답은 전체 페이지 장애로 처리한다.
  const missingIds = ids.filter((id) => !urls[id]);
  return NextResponse.json({ urls, missingIds }, noStore);
}
