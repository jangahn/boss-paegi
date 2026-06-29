"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// 캐시 fast-path(placeholder 제거)를 **paint 전**에 적용 → 캐시/이미 로드된 이미지가 placeholder
// 1프레임 거치지 않고 즉시 보임. SSR 엔 useLayoutEffect 경고가 있어 브라우저에서만 사용(서버는
// effect 자체를 실행 안 하므로 useEffect 폴백해도 동작 동일·경고만 회피).
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 이미지 로드 전 placeholder(정적 회색/펄스/shimmer) → 로드되면 **즉시** 채움(페이드 없음).
 * 고정 크기 wrapper 라 레이아웃 밀림(CLS) 없음.
 *
 * **페이드 애니메이션은 제거됨**(모바일에서 깜빡임의 원인). 빠른 표시는 *캐싱*으로 해결한다 —
 * 캐시/이미 로드된 이미지는 마운트 시 `img.complete` 를 감지해 paint 전에 placeholder 를 걷어 즉시
 * 보이고(첫 로드만 placeholder→이미지로 교체), 정적 자산은 immutable 캐시·Supabase 는 cache-control
 * 로 재방문이 즉시가 된다.
 *
 * **fail-safe(절대 투명하게 멈추지 않음)**: img 에 opacity 애니/클래스가 없어 항상 base opacity 1 —
 * JS 미실행·onLoad 미수신에도 이미지는 보인다. placeholder 제거만 onLoad/complete best-effort.
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
  const [errored, setErrored] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  const effectiveSrc = errored && fallbackSrc ? fallbackSrc : src;

  // 캐시 hit / SSR 으로 하이드레이션 전 이미 로드 완료면 paint 전에 placeholder 제거 → 즉시 표시.
  // src 변경(fallback 포함) 시 재확인.
  useIsoLayoutEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth > 0) setLoaded(true);
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
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (fallbackSrc && !errored) {
            // fallback 으로 전환 — 새 src 가 로드 detection 을 다시 거치도록 리셋.
            setErrored(true);
            setLoaded(false);
          } else {
            setLoaded(true);
          }
        }}
        className={`relative h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
      />
    </span>
  );
}
