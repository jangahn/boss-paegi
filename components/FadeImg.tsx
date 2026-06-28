"use client";

import { useState } from "react";

/**
 * 이미지 로드 전 placeholder(정적 회색/펄스) → 로드 시 부드럽게 채움. 페이지(텍스트·고정
 * 레이아웃)는 즉시 뜨는데 <img> 만 늦게 fetch 되어 갑자기 채워지던 "pop-in" 을 완화한다.
 * 고정 크기 wrapper 라 레이아웃 밀림(CLS)은 없음.
 *
 * 페이드는 **CSS 애니메이션**(`fade-in-img`, globals.css)으로 한다 — JS 로드감지(onLoad/
 * decode/complete)는 SSR 하이드레이션·캐시 hit·cross-origin no-cache revalidate 레이스에서
 * 미스되어 이미지가 opacity-0 로 투명하게 멈출 수 있다(특히 서버 컴포넌트가 렌더한 클라
 * 아일랜드가 하이드레이트 안 되는 경우). CSS 애니메이션은 하이드레이션과 무관하게 실행되고
 * 항상 opacity 1 로 끝나므로 **이미지가 절대 투명하게 멈추지 않는다**.
 *
 * placeholder 제거만 onLoad(best-effort). 미하이드레이션 시 placeholder 가 잔존할 수 있으나,
 * img 가 위에 불투명하게 그려지므로 cover 는 완전히 덮이고, contain 은 letterbox 에만 남는다.
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
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const effectiveSrc = errored && fallbackSrc ? fallbackSrc : src;

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
        src={effectiveSrc}
        alt={alt}
        loading={loading}
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (fallbackSrc && !errored) setErrored(true);
          else setLoaded(true);
        }}
        className={`relative h-full w-full ${
          fit === "cover" ? "object-cover" : "object-contain"
        } fade-in-img`}
      />
    </span>
  );
}
