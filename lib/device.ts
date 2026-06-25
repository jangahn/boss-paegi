/**
 * 공유 미디어 첨부 게이트 — **UA 기반 모바일 OS 판정(보수)**.
 *
 * `pointer: coarse` 로 판정하지 않는다: 터치 노트북/태블릿형 PC 가 모바일로 오판되면
 * 데스크톱 공유시트에 미디어가 이상하게 노출(파일 다중표현 → 붙여넣기 중복 등)된다.
 * 미디어 첨부는 사진/영상 저장 UX 가 고유한 iOS/iPadOS/Android 에서만 허용하고,
 * 그 외(데스크톱)는 `navigator.canShare({files})` 가 true 여도 첨부하지 않는다.
 */
export function isMobileOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ 는 데스크톱 Safari UA("Macintosh")로 위장 — 멀티터치로 포착
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}
