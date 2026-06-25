import { z } from "zod";
import type { DomainEntry } from "../registry";
import {
  CREDIT_PRODUCT_LIST,
  type CreditProduct,
} from "@/lib/credit-products";

// 성장 레버 도메인 — 가입 생성권 개수 + 충전 상품(가격/개수). 머니 패스(체크아웃)에 직결.
// 가격: PayApp 최소 1,000원 floor + 상한 100,000원 가드(과실 과금 방지). productId 불변.
// soft delete = active(false→/credits·checkout 숨김; 과거 주문은 amount/credits 스냅샷이라 무관).
const productSchema = z.object({
  productId: z.string().trim().min(1).max(40),
  goodname: z.string().trim().min(1).max(60),
  price: z.number().int().min(1000).max(100000),
  credits: z.number().int().min(1).max(1000),
  active: z.boolean(),
});

export const growthLeversSchema = z
  .object({
    signupBonusCredits: z.number().int().min(0).max(50),
    products: z.array(productSchema).min(1).max(8),
  })
  // productId 중복 금지 — 체크아웃 조회 모호성/충돌 방지.
  .refine(
    (g) => new Set(g.products.map((p) => p.productId)).size === g.products.length,
    { message: "duplicate_product_id", path: ["products"] }
  );

export type GrowthLevers = z.infer<typeof growthLeversSchema>;
export type GrowthProduct = z.infer<typeof productSchema>;

// 코드 기본값(fallback) = 발행값과 동기화 — 가입보너스 1 + CREDIT_PRODUCT_LIST 상시상품(전부 active).
export const GROWTH_LEVERS_DEFAULT: GrowthLevers = {
  signupBonusCredits: 1,
  products: CREDIT_PRODUCT_LIST.map((p) => ({
    productId: p.productId,
    goodname: p.goodname,
    price: p.price,
    credits: p.credits,
    active: true,
  })),
};

/** active 상품만 CreditProduct 형태로(표시·체크아웃 공용). 비활성/내부 active 플래그 제거. */
export function activeCreditProducts(g: GrowthLevers): CreditProduct[] {
  return g.products
    .filter((p) => p.active)
    .map(({ productId, goodname, price, credits }) => ({
      productId,
      goodname,
      price,
      credits,
    }));
}

// 클라(/credits 표시)는 provider 로 active 상품만. signupBonusCredits·비활성은 서버 전용(callback/checkout).
export const growthEntry: DomainEntry<GrowthLevers> = {
  schema: growthLeversSchema,
  codeDefault: GROWTH_LEVERS_DEFAULT,
};
