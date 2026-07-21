import { useEffect, useRef } from "react";

/**
 * bfcache(뒤로가기) 복원 시 멈춘 로딩 상태를 리셋한다.
 *
 * 외부 결제창·OAuth 페이지 등으로 **같은 탭 리다이렉트**(`window.location.assign`)
 * 하기 직전 스피너 state(busy/pending)를 켜는데, 거기서 뒤로가기를 누르면 브라우저가
 * 페이지를 **bfcache 에서 그 React 상태 그대로 복원** → 스피너가 멈춘 채 버튼이 방치된다.
 * `pageshow` 의 `persisted=true`(=bfcache 복원)만 잡아 reset 을 호출해 이를 해제한다.
 *
 * reset 은 매 렌더 새 클로저여도 됨(ref 로 최신값 사용 → 리스너는 1회만 구독).
 */
export function useBfcacheReset(reset: () => void) {
  const ref = useRef(reset);
  ref.current = reset;
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) ref.current();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
}
