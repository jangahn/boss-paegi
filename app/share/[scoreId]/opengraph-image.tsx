import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVICE_NAME } from "@/lib/policy";
import { bossReaction, gradeFor, reportNo, weaponLabel } from "@/lib/report";

export const runtime = "nodejs";
// 크롤러 버스트(바이럴 공유) 시 매번 Supabase+이미지fetch+Satori 렌더하지 않게 ISR 캐시.
export const revalidate = 3600;
export const alt = "스트레스 해소 결과 보고서";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * 인형 이미지를 data URI 로 — Satori 는 외부 URL <img> 를 자체 fetch 하다
 * 특정 PNG 에서 조용히 실패함 (영역이 빈 채 렌더). 서버에서 미리 받아 embed.
 * 커스텀 인형 없으면 기본 부장님 (public/sprites).
 */
async function dollDataUri(dollUrl: string | null): Promise<string | null> {
  try {
    if (dollUrl) {
      const r = await fetch(dollUrl, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        return `data:image/png;base64,${buf.toString("base64")}`;
      }
    }
  } catch {
    /* 기본 부장님으로 fallback */
  }
  try {
    const buf = await readFile(
      join(process.cwd(), "public/sprites/boss-default.png")
    );
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function OgImage({
  params,
}: {
  params: Promise<{ scoreId: string }>;
}) {
  const { scoreId } = await params;
  const admin = createAdminClient();
  const { data } = await admin
    .from("scores")
    .select("id, score, weapon, created_at, profiles(display_name), dolls(image_url)")
    .eq("id", scoreId)
    .single();

  const s = data as
    | {
        id: string;
        score: number;
        weapon: string;
        created_at: string;
        profiles: { display_name: string } | null;
        dolls: { image_url: string | null } | null;
      }
    | null;

  const name = s?.profiles?.display_name ?? "익명";
  const score = (s?.score ?? 0).toLocaleString();
  const dollSrc = await dollDataUri(s?.dolls?.image_url ?? null);
  const grade = gradeFor(s?.score ?? 0);
  const reaction = s ? bossReaction(s.score, s.id) : "";
  const docNo = s ? reportNo(s.id, s.created_at) : "";

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
        {/* 보고서 종이 */}
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
          {/* 헤더 */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              borderBottom: "5px solid #27272a",
              paddingBottom: 18,
            }}
          >
            <div style={{ display: "flex", fontSize: 20, color: "#71717a", letterSpacing: "0.4em" }}>
              {docNo}
            </div>
            <div style={{ display: "flex", fontSize: 52, fontWeight: 900, marginTop: 6 }}>
              스트레스 해소 결과 보고서
            </div>
          </div>

          {/* 본문: 인형 + 정보 */}
          <div style={{ display: "flex", flex: 1, gap: 44, marginTop: 28, alignItems: "center" }}>
            {dollSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={dollSrc}
                alt=""
                width={260}
                height={260}
                style={{
                  width: 260,
                  height: 260,
                  borderRadius: 20,
                  objectFit: "contain",
                  border: "3px solid #d4d4d8",
                  backgroundColor: "#f4f4f5",
                }}
              />
            ) : (
              <div
                style={{
                  width: 260,
                  height: 260,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 130,
                  background: "#f4f4f5",
                  borderRadius: 20,
                  border: "3px solid #d4d4d8",
                }}
              >
                😠
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 10 }}>
              <div style={{ display: "flex", fontSize: 28, color: "#71717a" }}>
                작성자: {name}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                <div
                  style={{
                    display: "flex",
                    fontSize: 120,
                    fontWeight: 900,
                    lineHeight: 1,
                    letterSpacing: "-0.04em",
                  }}
                >
                  {score}
                </div>
                <div style={{ display: "flex", fontSize: 36, color: "#71717a" }}>점</div>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div
                  style={{
                    display: "flex",
                    fontSize: 34,
                    fontWeight: 800,
                    color: "#18181b",
                  }}
                >
                  판정: {grade.label}
                </div>
                <div style={{ display: "flex", fontSize: 24, color: "#71717a" }}>
                  · {s ? weaponLabel(s.weapon) : ""}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 24,
                  color: "#52525b",
                  marginTop: 6,
                  fontStyle: "italic",
                }}
              >
                부장님: &ldquo;{reaction}&rdquo;
              </div>
            </div>

            {/* 결재 도장 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 150,
                height: 150,
                borderRadius: 9999,
                border: "7px solid #ef4444",
                color: "#ef4444",
                fontSize: 36,
                fontWeight: 900,
                transform: "rotate(-14deg)",
              }}
            >
              해소완료
            </div>
          </div>

          {/* 푸터 */}
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
