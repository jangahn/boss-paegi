import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVICE_NAME } from "@/lib/policy";
import { dollDepartment, dollRank, dollTrait, reportNo } from "@/lib/report";

export const runtime = "nodejs";
export const alt = "부장님 인사기록카드";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Satori 는 외부 URL <img> 가 조용히 실패할 수 있어 data URI 로 embed */
async function dollDataUri(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function OgImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = createAdminClient();
  const { data } = await admin
    .from("dolls")
    .select("id, image_url, created_at, profiles(display_name)")
    .eq("id", id)
    .single();

  const d = data as
    | {
        id: string;
        image_url: string;
        created_at: string;
        profiles: { display_name: string } | null;
      }
    | null;

  const name = d?.profiles?.display_name ?? "익명";
  const trait = d ? dollTrait(d.id) : "";
  const docNo = d ? reportNo(d.id, d.created_at) : "";
  const dollSrc = d ? await dollDataUri(d.image_url) : null;

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
              // eslint-disable-next-line @next/next/no-img-element
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

            <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 14 }}>
              <div style={{ display: "flex", fontSize: 42, fontWeight: 900 }}>
                성명: 부장님
              </div>
              <div style={{ display: "flex", fontSize: 30, color: "#52525b" }}>
                직급: {d ? dollRank(d.id) : ""} · 소속:{" "}
                {d ? dollDepartment(d.id) : ""}
              </div>
              <div style={{ display: "flex", fontSize: 30, color: "#52525b" }}>
                제작자: {name}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 26,
                  color: "#3f3f46",
                  marginTop: 8,
                  fontStyle: "italic",
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
              당신의 부장님은 무사하십니까?
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
