"use client";

import { createContext, useContext } from "react";

// 클라가 소비하는 미디어 자산(로고만 — OG 는 서버 metadata 전용). path 가 아닌 변환 render URL.
export type MediaAssets = { logoUrl: string | null };

// 로고는 정적 폴백(/logo.png)이 있는 비필수 자산 → provider 밖이어도 throw 대신 안전 기본값(null→폴백).
const Ctx = createContext<MediaAssets>({ logoUrl: null });

export function MediaAssetsProvider({
  value,
  children,
}: {
  value: MediaAssets;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMediaAssets(): MediaAssets {
  return useContext(Ctx);
}
