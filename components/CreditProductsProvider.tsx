"use client";

import { createContext, useContext } from "react";
import {
  GROWTH_LEVERS_DEFAULT,
  creditsConfig,
  type CreditsConfig,
} from "@/lib/config/domains/growth";

// 서버(루트 레이아웃)에서 getGrowthLevers() → creditsConfig(active 상품 + 결제노출 여부 + 준비중 안내)를
// /credits 표시용으로 주입. 결제 검증은 클라 값 신뢰 안 함 — /api/pay/checkout 가 서버에서 재검사.
// 아래 createContext 기본값은 **fallback**(provider 미주입 시)일 뿐 — 발행값이 항상 덮어씀.
const Ctx = createContext<CreditsConfig>(creditsConfig(GROWTH_LEVERS_DEFAULT));

export function CreditProductsProvider({
  value,
  children,
}: {
  value: CreditsConfig;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCreditsConfig(): CreditsConfig {
  return useContext(Ctx);
}
