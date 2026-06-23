/**
 * 충전 상품 카탈로그 — 단일 소스(클라 표시 + 서버 결정 공용).
 *
 * 클라이언트는 `productId` 만 전송하고, price/credits/goodname 결정은 항상 서버(이 allowlist).
 * 가격·구성은 비밀이 아니라 클라 노출 OK — 그래서 server-only 가 아니며 /credits 페이지에서도 import.
 * 모든 상품은 PayApp 최소 결제금액 리스크 회피를 위해 1,000원 이상.
 */
export type CreditProduct = {
  productId: string;
  /** PayApp goodname(결제창·영수증 상품명) */
  goodname: string;
  /** 결제금액(원) */
  price: number;
  /** 지급 생성권 개수 */
  credits: number;
};

export const CREDIT_PRODUCTS = {
  credits_5: { productId: "credits_5", goodname: "캐릭터 생성권 5개", price: 1000, credits: 5 },
  credits_10: { productId: "credits_10", goodname: "캐릭터 생성권 10개", price: 1800, credits: 10 },
  credits_20: { productId: "credits_20", goodname: "캐릭터 생성권 20개", price: 3200, credits: 20 },
  credits_50: { productId: "credits_50", goodname: "캐릭터 생성권 50개", price: 7000, credits: 50 },
} as const satisfies Record<string, CreditProduct>;

export type CreditProductId = keyof typeof CREDIT_PRODUCTS;

/** 표시 순서(가격 오름차순). */
export const CREDIT_PRODUCT_LIST: CreditProduct[] = [
  CREDIT_PRODUCTS.credits_5,
  CREDIT_PRODUCTS.credits_10,
  CREDIT_PRODUCTS.credits_20,
  CREDIT_PRODUCTS.credits_50,
];

/** productId allowlist 검증 — 유효하면 상품, 아니면 null. */
export function getCreditProduct(id: string): CreditProduct | null {
  return (CREDIT_PRODUCTS as Record<string, CreditProduct>)[id] ?? null;
}

/** 개당 단가(원, 반올림). */
export function perUnitPrice(p: CreditProduct): number {
  return Math.round(p.price / p.credits);
}
