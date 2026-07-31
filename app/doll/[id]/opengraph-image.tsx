import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedDollUrl } from "@/lib/storage";
import { SERVICE_NAME } from "@/lib/policy";
import { dollDepartment, dollRank, dollTrait, reportNo } from "@/lib/report";
import { asRole } from "@/lib/roles";
import { getRoleConfig, getMarketingCopy } from "@/lib/config/getters";
import { roleFrom } from "@/lib/config/domains/roles";
import { resolveCopy } from "@/lib/config/template";
import { PUBLIC_ENV } from "@/lib/env";
import { requireSupabaseOptionalData } from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  fetchMediaBlob,
  OG_DOLL_IMAGE_DOWNLOAD_MAX_BYTES,
} from "@/lib/media-download";

export const runtime = "nodejs";
// 제작자 탈퇴·콘텐츠 숨김이 기존 OG 캐시에 남지 않게 매 요청 재검증.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const alt = "인사기록카드";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Satori 는 외부 URL <img> 가 조용히 실패할 수 있어 data URI 로 embed */
async function dollDataUri(url: string): Promise<string> {
  const downloaded = await fetchMediaBlob(url, {
    kind: "image",
    maxBytes: OG_DOLL_IMAGE_DOWNLOAD_MAX_BYTES,
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  const buf = Buffer.from(await downloaded.blob.arrayBuffer());
  return `data:${downloaded.type};base64,${buf.toString("base64")}`;
}

export default async function OgImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    "og.doll.query",
    () =>
      admin
        .from("dolls")
        .select("id, image_url, created_at, role, deleted_at, profiles(display_name)")
        .eq("id", id)
        .maybeSingle(),
  );
  const d = data
    ? validateAdminRows<{
        id: string;
        image_url: string;
        created_at: string;
        role: string | null;
        deleted_at: string | null;
        profiles:
          | { display_name: string | null }
          | { display_name: string | null }[]
          | null;
      }>("og.doll.query", [data], {
        id: "uuid",
        image_url: "string",
        created_at: "timestamp",
        role: "nullableString",
        deleted_at: "nullableTimestamp",
        profiles: "embed",
      })[0]
    : null;
  const profile = Array.isArray(d?.profiles)
    ? d.profiles[0] ?? null
    : d?.profiles ?? null;
  if (profile) {
    validateAdminRows("og.doll.profile", [profile], {
      display_name: "nullableText",
    });
  }

  const name = profile?.display_name ?? "익명";
  const role = asRole(d?.role);
  const cfg = await getRoleConfig();
  const mk = await getMarketingCopy();
  const rlabel = roleFrom(role, cfg).label;
  const trait = d ? dollTrait(d.id, role, cfg) : "";
  const docNo = d ? reportNo(d.id, d.created_at) : "";
  // takedown(0034): 삭제면 기본 부장님 sprite(😠 대신) — invisible takedown.
  const dollImg = d
    ? d.deleted_at
      ? `${PUBLIC_ENV.SITE_URL}/sprites/boss-default.png`
      : await signedDollUrl(d.image_url, 60, { thumb: true }) // 384px 썸네일(OG는 server fetch라 png ~432KB, Satori 안전)
    : null;
  const dollSrc = dollImg ? await dollDataUri(dollImg) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#3f3f46",
          padding: "36px",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: "#fbfaf6",
            borderRadius: 16,
            padding: "44px 56px",
            color: "#18181b",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              borderBottom: "5px solid #27272a",
              paddingBottom: 18,
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 20,
                color: "#71717a",
                letterSpacing: "0.4em",
                whiteSpace: "nowrap",
              }}
            >
              {docNo}
            </div>
            <div style={{ display: "flex", fontSize: 52, fontWeight: 900, marginTop: 6 }}>
              인사기록카드
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flex: 1,
              gap: 44,
              marginTop: 28,
              alignItems: "center",
            }}
          >
            {dollSrc ? (
              <img
                src={dollSrc}
                alt=""
                width={230}
                height={300}
                style={{
                  width: 230,
                  height: 300,
                  borderRadius: 12,
                  objectFit: "contain",
                  border: "4px solid #a1a1aa",
                  backgroundColor: "#f4f4f5",
                }}
              />
            ) : (
              <div
                style={{
                  width: 230,
                  height: 300,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 110,
                  background: "#f4f4f5",
                  borderRadius: 12,
                  border: "4px solid #a1a1aa",
                }}
              >
                😠
              </div>
            )}

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minWidth: 0,
                gap: 12,
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", fontSize: 42, fontWeight: 900, whiteSpace: "nowrap" }}>
                성명: {rlabel}
              </div>
              {/* 직급/소속 분리 — 합치면 최장값(전설의 꼰대 부장 · 스트레스 유발 1팀)이 영역 초과 */}
              <div style={{ display: "flex", fontSize: 30, color: "#52525b", whiteSpace: "nowrap" }}>
                직급: {d ? dollRank(d.id, role, cfg) : ""}
              </div>
              <div style={{ display: "flex", fontSize: 30, color: "#52525b", whiteSpace: "nowrap" }}>
                소속: {d ? dollDepartment(d.id, role, cfg) : ""}
              </div>
              <div style={{ display: "flex", fontSize: 30, color: "#52525b", whiteSpace: "nowrap" }}>
                제작자: {name}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 22,
                  color: "#3f3f46",
                  marginTop: 6,
                  fontStyle: "italic",
                  whiteSpace: "nowrap",
                }}
              >
                특이사항: &ldquo;{trait}&rdquo;
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 160,
                height: 160,
                borderRadius: 9999,
                border: "7px solid #ef4444",
                color: "#ef4444",
                fontSize: 34,
                fontWeight: 900,
                transform: "rotate(-14deg)",
                whiteSpace: "nowrap",
              }}
            >
              관리대상
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              borderTop: "2px solid #d4d4d8",
              paddingTop: 14,
            }}
          >
            <div style={{ display: "flex", fontSize: 26, fontWeight: 800, color: "#b45309" }}>
              {SERVICE_NAME}
            </div>
            <div style={{ display: "flex", fontSize: 24, color: "#71717a" }}>
              {resolveCopy(mk.share.dollHook, rlabel)}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    }
  );
}
