// page-loading.ts — 로딩 중 푸터 숨김(v1.60): 페이지가 로딩 상태(스켈레톤, 스피너)인 동안 사업자 정보 푸터를 그리지 않는다.
//
// 배경: 사업자 정보 푸터는 375px 에서 약 246px 로 크다. 본문이 비었거나 짧은 로딩 상태에선 이 푸터가 화면 아래쪽에 보이다가
//   본문이 오면 밀려나 화면 밀림 대부분을 만들었다(2026-09-25 전수 실측, 느린 4G: /generate CLS 0.27, /leaderboard 0.21,
//   /account 0.10, /share · /history 상세 첫 방문 0.21~0.27). 로딩 상태에 PAGE_LOADING_PROPS 를 달면 그동안 푸터가 빠지고,
//   본문이 오면 본문 아래에 붙는다 — 이미 그려진 요소가 움직이지 않는다.
// 규칙은 회원 힌트(lib/member-hint.ts)와 같은 이유로 스타일시트가 아니라 루트 레이아웃 <head> 인라인 <style> 에 싣는다
//   (첫 페인트를 좌우하는 규칙은 CSS 빌드 · 캐시와 무관해야 한다 — 2026-09-21 프로드 사고).
// `:has()` 를 모르는 구형 브라우저(iOS 15.3 이하)는 종전처럼 푸터가 보인다.

export const PAGE_LOADING_ATTRIBUTE = "data-page-loading";
export const SITE_FOOTER_ATTRIBUTE = "data-site-footer";

/** 로딩 상태 컨테이너에 펼쳐 다는 속성 — 푸터 숨김 표지 + 스크린 리더용 로딩 중 표시. */
export const PAGE_LOADING_PROPS = { [PAGE_LOADING_ATTRIBUTE]: "", "aria-busy": true } as const;

export const PAGE_LOADING_STYLE = `body:has([${PAGE_LOADING_ATTRIBUTE}]) [${SITE_FOOTER_ATTRIBUTE}]{display:none!important}`;
