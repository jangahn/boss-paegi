const CALLBACK_SHELL = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>로그인 처리 중</title>
</head>
<body>
<main><h1>로그인 정보를 안전하게 확인하고 있어요</h1></main>
<script src="/auth/callback/bootstrap"></script>
</body>
</html>`;

/**
 * Next serializes an App Router request query into its Flight bootstrap even
 * when a page never reads searchParams. Serve a query-agnostic HTML shell so
 * the one-time OAuth code cannot appear in RSC/HTML, then let a static script
 * move the bounded query into a URL fragment before loading any Next page.
 */
export function GET(): Response {
  return new Response(CALLBACK_SHELL, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
