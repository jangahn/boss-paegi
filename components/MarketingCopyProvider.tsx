"use client";

import { createContext, useContext } from "react";
import {
  MARKETING_COPY_DEFAULT,
  type MarketingCopy,
} from "@/lib/config/domains/marketing";

// 서버(루트 레이아웃)에서 getMarketingCopy() 로 읽은 카피를 클라 컴포넌트에 1회 주입.
// 기본값 = 코드 default → 프로바이더 밖/하이드레이션 전에도 안전(빈 화면 방지).
const Ctx = createContext<MarketingCopy>(MARKETING_COPY_DEFAULT);

export function MarketingCopyProvider({
  value,
  children,
}: {
  value: MarketingCopy;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMarketingCopy(): MarketingCopy {
  return useContext(Ctx);
}
