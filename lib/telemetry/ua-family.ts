/**
 * User-Agent 를 저카디널리티 계열로 접는다 — 로그 진단용(태그 아님). 값·버전은
 * 남기지 않고 계열만 남겨 식별성이 없다.
 */
export type UaFamily =
  | "none"
  | "headless"
  | "webview"
  | "kakao"
  | "whale"
  | "samsung"
  | "opera"
  | "safari"
  | "chrome"
  | "other";

export function uaFamily(userAgent: string | null | undefined): UaFamily {
  if (!userAgent) return "none";
  const ua = userAgent;
  if (/HeadlessChrome/i.test(ua)) return "headless";
  if (/KAKAOTALK/i.test(ua)) return "kakao";
  if (/; wv\)/.test(ua) || /Version\/[\d.]+.*Chrome\/.*Mobile/.test(ua)) {
    return "webview";
  }
  if (/Whale\//i.test(ua)) return "whale";
  if (/SamsungBrowser\//i.test(ua)) return "samsung";
  if (/OPR\/|Opera/i.test(ua)) return "opera";
  if (/Chrome\//i.test(ua) || /CriOS\//i.test(ua)) return "chrome";
  if (/Safari\//i.test(ua)) return "safari";
  return "other";
}
