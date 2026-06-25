/**
 * 충전 상품 카탈로그 — **fallback default**(발행 소스는 DB config `growth_levers`).
 *
 * 런타임 표시·체크아웃은 항상 발행값(`getGrowthLevers()`→`activeCreditProducts`)을 쓴다. 이 정적 목록은
 * config 조회 실패 시 fallback(`GROWTH_LEVERS_DEFAULT`/`CreditProductsProvider` 초기값)으로만 살아있다
 * → 실제 발행 *상시* 상품(credits_3/10/20/40)과 일치시켜 fallback 시 존재하지 않는 productId 노출(결제 막힘)
 * 을 방지. **이벤트성 상품(event_*)은 임시라 여기 넣지 않음(종료 후 재-stale 방지) — DB-only.**
 * 클라는 `productId` 만 전송, price/credits/goodname 결정은 항상 서버. 모든 상품 1,000원 이상(PayApp floor).
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

// 발행 DB(growth_levers)의 상시 상품과 동기화(2026-06-25). 이벤트 상품(event_credits_10 등)은 DB-only.
export const CREDIT_PRODUCTS = {
  credits_3: { productId: "credits_3", goodname: "캐릭터 생성권 3개", price: 1000, credits: 3 },
  credits_10: { productId: "credits_10", goodname: "캐릭터 생성권 10개", price: 3000, credits: 10 },
  credits_20: { productId: "credits_20", goodname: "캐릭터 생성권 20개", price: 5500, credits: 20 },
  credits_40: { productId: "credits_40", goodname: "캐릭터 생성권 40개", price: 10000, credits: 40 },
} as const satisfies Record<string, CreditProduct>;

export type CreditProductId = keyof typeof CREDIT_PRODUCTS;

/** 표시 순서(가격 오름차순). */
export const CREDIT_PRODUCT_LIST: CreditProduct[] = [
  CREDIT_PRODUCTS.credits_3,
  CREDIT_PRODUCTS.credits_10,
  CREDIT_PRODUCTS.credits_20,
  CREDIT_PRODUCTS.credits_40,
];

/** productId allowlist 검증 — 유효하면 상품, 아니면 null. */
export function getCreditProduct(id: string): CreditProduct | null {
  return (CREDIT_PRODUCTS as Record<string, CreditProduct>)[id] ?? null;
}

/** 개당 단가(원, 반올림). */
export function perUnitPrice(p: CreditProduct): number {
  return Math.round(p.price / p.credits);
}
