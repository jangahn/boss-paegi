"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * 루트 에러 바운더리 — 루트 레이아웃까지 깨지는 렌더 에러를 Sentry 로 포착.
 * (일반 라우트 에러는 각 segment 의 error.tsx / onRequestError 가 담당.)
 * global-error 는 root layout 을 대체하므로 자체 html/body 필요.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ko">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily: "system-ui, sans-serif",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 48 }}>😵</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
          앗, 문제가 발생했어요
        </h2>
        <p style={{ color: "#71717a", margin: 0 }}>
          잠시 후 다시 시도해 주세요.
        </p>
        <button
          onClick={() => reset()}
          style={{
            marginTop: 8,
            padding: "10px 20px",
            borderRadius: 9999,
            border: "none",
            background: "#b45309",
            color: "white",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          다시 시도
        </button>
      </body>
    </html>
  );
}
