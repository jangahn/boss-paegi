const CALLBACK_SHELL = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>로그인 처리 중</title>
<style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f7ebdb;color:#11233a;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}main{text-align:center}.spin{margin:0 auto 14px;width:36px;height:36px;border-radius:50%;border:3px solid rgba(17,35,58,.15);border-top-color:#11233a;animation:s .8s linear infinite}h1{font-size:16px;font-weight:600;margin:0}p{font-size:12px;color:rgba(17,35,58,.55);margin:6px 0 0}@keyframes s{to{transform:rotate(360deg)}}</style>
</head>
<body>
<main>
<div class="spin" aria-hidden="true"></div>
<h1>로그인 정보를 안전하게 확인하고 있어요</h1>
<p>잠시만 기다려주세요. 이 화면을 닫지 마세요.</p>
</main>
<script src="/auth/callback/bootstrap"></script>
</body>
</html>`;

/**
 * Next serializes an App Router request query into its Flight bootstrap even
 * when a page never reads searchParams. Serve a query-agnostic HTML shell so
 * the one-time OAuth code cannot appear in RSC/HTML, then let a static script
 * move the bounded query into a URL fragment before loading any Next page.
 * The inline style is a static constant allowed by an exact CSP hash, so the
 * shell stays byte-identical for every request while painting the branded
 * loading screen that covers the whole hand-off until the app takes over.
 */
export function GET(): Response {
  return new Response(CALLBACK_SHELL, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; " +
        "style-src 'sha256-wF2X0KKT7pv4Vv4fgf6KXFlLhklmB12aQQzwE9t8OTY='; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
