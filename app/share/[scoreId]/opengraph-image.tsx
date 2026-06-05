import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVICE_NAME } from "@/lib/policy";

export const runtime = "nodejs";
export const alt = "부장님 패기 결과";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({
  params,
}: {
  params: Promise<{ scoreId: string }>;
}) {
  const { scoreId } = await params;
  const admin = createAdminClient();
  const { data } = await admin
    .from("scores")
    .select("score, profiles(display_name), dolls(image_url)")
    .eq("id", scoreId)
    .single();

  const s = data as
    | {
        score: number;
        profiles: { display_name: string } | null;
        dolls: { image_url: string | null } | null;
      }
    | null;

  const name = s?.profiles?.display_name ?? "익명";
  const score = (s?.score ?? 0).toLocaleString();
  const dollUrl = s?.dolls?.image_url ?? null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
          color: "white",
          padding: "60px",
          alignItems: "center",
          gap: "60px",
        }}
      >
        {dollUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dollUrl}
            alt=""
            width="400"
            height="400"
            style={{ borderRadius: "32px", objectFit: "cover" }}
          />
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            flex: 1,
          }}
        >
          <div style={{ display: "flex", fontSize: 36, color: "#a0a0c0" }}>
            {name} 님이
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 160,
              fontWeight: 900,
              lineHeight: 1,
              letterSpacing: "-0.04em",
            }}
          >
            {score}
          </div>
          <div style={{ display: "flex", fontSize: 36, color: "#a0a0c0" }}>
            점 패고 옴 🥊
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 24,
              fontSize: 28,
              color: "#ffd166",
              fontWeight: 700,
            }}
          >
            {SERVICE_NAME}
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
