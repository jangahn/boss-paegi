"use client";

import { createContext, useContext } from "react";
import {
  GROWTH_LEVERS_DEFAULT,
  activeCreditProducts,
} from "@/lib/config/domains/growth";
import type { CreditProduct } from "@/lib/credit-products";

// 서버(루트 레이아웃)에서 getGrowthLevers() 의 active 상품만 /credits 표시용으로 주입.
// 결제 검증은 클라 값 신뢰 안 함 — /api/payapp/checkout 가 서버에서 active 상품 재조회.
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
