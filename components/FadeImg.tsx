"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 이미지 로드 전 placeholder(정적 회색/펄스/shimmer) → 로드 시 부드럽게 채움. 페이지(텍스트·
 * 고정 레이아웃)는 즉시 뜨는데 <img> 만 늦게 fetch 되어 갑자기 채워지던 "pop-in" 을 완화한다.
 * 고정 크기 wrapper 라 레이아웃 밀림(CLS)은 없음.
 *
 * **페이드는 실제 로드(onLoad)에 묶는다.** 과거엔 `fade-in-img` 를 무조건 붙여 마운트 시점에
 * 0.35s 페이드를 돌렸는데, 이는 이미지 로드와 무관해서 **빠른 이미지(정적 기본 캐릭터)만 페이드되고
 * 느린 이미지(서명 URL·cross-origin·lazy 인 커스텀 캐릭터)는 페이드가 placeholder 아래서 끝난 뒤
 * 바이트가 도착해 뚝 튀어나오는** 문제가 있었다. 이제 `fade-in-img` 는 `fade` state(onLoad 시 true)
 * 일 때만 부여 → 어떤 속도의 이미지든 "도착하는 순간" 부드럽게 페이드된다.
 * (+ onLoad[바이트 완료] 후 `img.decode()`[래스터 완료]까지 기다렸다 표시 → 모바일에서 디코드 전
 *  빈/부분 프레임이 노출되던 깜빡임 제거. 애니는 globals.css 에서 `fill-mode:both` 라 시작 직전
 *  base opacity 1 가 번쩍이지 않음. decode 미지원/실패는 catch→reveal 로 graceful, fail-safe 유지.)
 *
 * **fail-safe(절대 투명하게 멈추지 않음) 유지**: img base opacity 는 1(애니메이션 클래스 없으면 그대로
 * 보임). JS 미실행/하이드레이션 미스로 onLoad 가 안 와도 페이드만 생략될 뿐 이미지는 보인다.
 * 또한 SSR/캐시로 **하이드레이션 전 이미 로드 완료**돼 onLoad 가 안 오는 경우는 마운트 effect 가
 * `img.complete` 를 감지해 placeholder 만 걷어낸다(이미 보이므로 페이드는 생략 → 깜빡임 없음).
 *
 * - `className`: wrapper 의 크기·모양·border·bg.
 * - `placeholder`: "gray"(정적 회색) / "pulse"(펄스) / "shimmer"(쓸어가는 스켈레톤, 캐릭터 이미지용).
 * - `fallbackSrc`: src 가 깨졌을 때 대체.
 */
export function FadeImg({
  src,
  alt = "",
  className = "",
  fit = "cover",
  placeholder = "gray",
  loading = "lazy",
  fallbackSrc,
}: {
  src: string;
  alt?: string;
  className?: string;
  fit?: "cover" | "contain";
  placeholder?: "gray" | "pulse" | "shimmer";
  loading?: "lazy" | "eager";
  fallbackSrc?: string;
}) {
  const [loaded, setLoaded] = useState(false); // placeholder 제거 제어
  const [fade, setFade] = useState(false); // 페이드 애니메이션(마운트 후 비동기 로드 시에만)
  const [errored, setErrored] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  const settledRef = useRef(false); // reveal 1회 가드 — 캐시 fast-path ↔ onLoad 경쟁 시 중복/불필요 페이드 방지.
  const effectiveSrc = errored && fallbackSrc ? fallbackSrc : src;

  // 캐시 hit / SSR 으로 하이드레이션 전에 이미 로드 완료된 경우: onLoad 가 안 와도 placeholder 를
  // 걷어낸다(이미 보이므로 fade 는 켜지 않음 → 깜빡임 없음). src 변경(fallback 포함) 시 재확인.
  useEffect(() => {
    settledRef.current = false;
    const img = ref.current;
    if (img && img.complete && img.naturalWidth > 0) {
      settledRef.current = true;
      setLoaded(true);
    }
  }, [effectiveSrc]);

  return (
    <span className={`relative block overflow-hidden ${className}`}>
      {!loaded && (
        <span
          aria-hidden
          className={`absolute inset-0 ${
            placeholder === "shimmer"
              ? "ui-shimmer"
              : `bg-foreground/10 ${placeholder === "pulse" ? "animate-pulse" : ""}`
          }`}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src={effectiveSrc}
        alt={alt}
        loading={loading}
        onLoad={() => {
          // 캐시 fast-path 가 이미 표시(loaded)했으면 fade 재트리거 안 함.
          if (settledRef.current) return;
          settledRef.current = true;
          const img = ref.current;
          // onLoad=바이트 완료. decode()로 래스터(디코드)까지 끝낸 뒤 표시 → 모바일에서 미디코드
          // 빈 프레임 노출 제거. lazy 이미지도 onLoad 이후 호출이라 decode reject 없이 안전.
          const reveal = () => {
            setLoaded(true);
            setFade(true);
          };
          if (img && typeof img.decode === "function") img.decode().then(reveal).catch(reveal);
          else reveal();
        }}
        onError={() => {
          if (fallbackSrc && !errored) {
            // fallback 으로 전환 — 새 src 가 로드 detection 을 다시 거치도록 리셋.
            setErrored(true);
            setLoaded(false);
            setFade(false);
            settledRef.current = false;
          } else {
            setLoaded(true);
          }
        }}
        className={`relative h-full w-full ${
          fit === "cover" ? "object-cover" : "object-contain"
        } ${fade ? "fade-in-img" : ""}`}
      />
    </span>
  );
}
