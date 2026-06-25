import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOLLS_BUCKET, dollPath } from "@/lib/storage-path";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 50;

/**
 * 클라(갤러리·게임) 전용 doll signed URL 배치 발급. private 버킷 전환 후 클라가 직접 path 서명 못 하므로.
 * 하드닝: **id 로 DB 조회한 path 만 서명**(클라가 보낸 path 직접 서명 절대 X) · UUID 검증 · ids ≤50 ·
 *   deleted_at 있는 doll 은 null(노출 차단) · **no-store**(만료 URL 캐싱 방지) · IP rate-limit. 인증 불요.
 * 성능: `createSignedUrls`(복수) 1회 호출로 N path 서명(갤러리 N개 doll 도 round-trip 1번).
 */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`signurls:ip:${ip}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    ids?: unknown;
    ttl?: unknown;
  } | null;
  const rawIds = Array.isArray(body?.ids) ? (body!.ids as unknown[]) : [];
  const ids = [
    ...new Set(
      rawIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))
    ),
  ].slice(0, MAX_IDS);
  // ttl 옵션(cap 3600): 게임은 본인 캐릭터 장기세션 위해 길게(공개표면 아님), 갤러리 등은 기본 600.
  const ttl =
    typeof body?.ttl === "number" && body.ttl > 0
      ? Math.min(3600, Math.floor(body.ttl))
      : 600;

  const urls: Record<string, string | null> = {};
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (ids.length === 0) return NextResponse.json({ urls }, noStore);

  const admin = createAdminClient();
  const { data: dolls } = await admin
    .from("dolls")
    .select("id, image_url, deleted_at")
    .in("id", ids);

  // 삭제(takedown) 아닌 doll 의 path 만 모아 일괄 서명. id→path 매핑 유지.
  const pathById = new Map<string, string>();
  for (const d of (dolls ?? []) as {
    id: string;
    image_url: string | null;
    deleted_at: string | null;
  }[]) {
    if (d.deleted_at) continue; // 신규 서명 중단(=null) → 클라 기본 보스 fallback
    const p = dollPath(d.image_url);
    if (p) pathById.set(d.id, p);
  }
  const paths = [...new Set(pathById.values())];
  if (paths.length) {
    const { data: signed } = await admin.storage
      .from(DOLLS_BUCKET)
      .createSignedUrls(paths, ttl);
    const byPath = new Map<string, string>();
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) byPath.set(s.path, s.signedUrl);
    }
    for (const [id, p] of pathById) urls[id] = byPath.get(p) ?? null;
  }
  // 미발견/삭제 id 는 키 없음 → 클라가 기본 보스 fallback.
  return NextResponse.json({ urls }, noStore);
}
