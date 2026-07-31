const CALLBACK_BOOTSTRAP_SCRIPT = String.raw`"use strict";
(() => {
  const MAX_QUERY_CHARS = 16384;
  let rawQuery = "";
  let valid = false;
  try {
    rawQuery = window.location.search;
    History.prototype.replaceState.call(
      window.history,
      null,
      "",
      "/auth/callback"
    );
    valid =
      rawQuery.length > 0 &&
      rawQuery.length <= MAX_QUERY_CHARS &&
      rawQuery.startsWith("?") &&
      !/[\u0000-\u001f\u007f]/u.test(rawQuery) &&
      !/%(?![0-9a-f]{2})/iu.test(rawQuery);
  } catch {
    valid = false;
  }
  const fragment = valid
    ? "#oauth-callback=" + encodeURIComponent(rawQuery)
    : "#oauth-callback-invalid";
  window.location.replace("/auth/callback/continue" + fragment);
})();`;

export function GET(): Response {
  return new Response(CALLBACK_BOOTSTRAP_SCRIPT, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "text/javascript; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
