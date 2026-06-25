"use client";

import { createContext, useContext } from "react";
import {
  GROWTH_LEVERS_DEFAULT,
  activeCreditProducts,
} from "@/lib/config/domains/growth";
import type { CreditProduct } from "@/lib/credit-products";

// 서버(루트 레이아웃)에서 getGrowthLevers() 의 active 상품(DB 발행값)만 /credits 표시용으로 주입.
// 결제 검증은 클라 값 신뢰 안 함 — /api/payapp/checkout 가 서버에서 active 상품 재조회.
// 아래 createContext 기본값은 **fallback**(provider 미주입 시)일 뿐 — 발행값이 항상 덮어씀.
const Ctx = createContext<CreditProduct[]>(activeCreditProducts(GROWTH_LEVERS_DEFAULT));

export function CreditProductsProvider({
  value,
  children,
}: {
  value: CreditProduct[];
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCreditProducts(): CreditProduct[] {
  return useContext(Ctx);
}
