import { ImageResponse } from "next/og";

export const size = { width: 192, height: 192 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #ef4444 0%, #991b1b 100%)",
          color: "white",
          fontSize: 130,
          fontWeight: 900,
          letterSpacing: "-0.08em",
        }}
      >
        패
      </div>
    ),
    { ...size }
  );
}
