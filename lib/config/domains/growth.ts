import { z } from "zod";
import type { DomainEntry } from "../registry";
import {
  CREDIT_PRODUCT_LIST,
  type CreditProduct,
} from "@/lib/credit-products";

// 성장 레버 도메인 — 가입 생성권 개수 + 충전 상품(가격/개수). 머니 패스(체크아웃)에 직결.
// 가격: 최소 1,000원(소액 카드결제 하한 가드) + 상한 100,000원 가드(과실 과금 방지). productId 불변.
// soft delete = active(false→/credits·checkout 숨김; 과거 주문은 amount/credits 스냅샷이라 무관).
const productSchema = z.object({
  productId: z.string().trim().min(1).max(40),
  goodname: z.string().trim().min(1).max(60),
  price: z.number().int().min(1000).max(100000),
  credits: z.number().int().min(1).max(1000),
  active: z.boolean(),
});

// 생성권 충전(결제) 노출 on/off + off 시 "결제기능 준비중" 안내 문구(제목+본문).
// **optional**: 기존 growth_levers 발행값(이 필드 없음)이 검증 실패로 코드기본값으로 떨어지지 않게.
//   미설정 = creditsEnabled 미정 → 소비처가 false(준비중)로 간주, comingSoon 미정 → DEFAULT_COMING_SOON.
const comingSoonSchema = z.object({
  title: z.string().trim().max(80),
  body: z.string().trim().max(1000),
});

export const growthLeversSchema = z
  .object({
    signupBonusCredits: z.number().int().min(0).max(50),
    products: z.array(productSchema).min(1).max(8),
    creditsEnabled: z.boolean().optional(),
    comingSoon: comingSoonSchema.optional(),
    // PG 심사용 계정 allowlist — creditsEnabled OFF(전역 준비중)여도 이 이메일 회원에겐
    // /credits 결제 UI·체크아웃을 허용(테스트 채널로 심사관이 결제창 호출을 확인).
    // **optional**: 기존 발행값(이 필드 없음)이 검증 실패로 코드기본값으로 떨어지지 않게.
    reviewerEmails: z.array(z.string().trim().toLowerCase().min(3).max(120)).max(10).optional(),
  })
  // productId 중복 금지 — 체크아웃 조회 모호성/충돌 방지.
  .refine(
    (g) => new Set(g.products.map((p) => p.productId)).size === g.products.length,
    { message: "duplicate_product_id", path: ["products"] }
  );

export type GrowthLevers = z.infer<typeof growthLeversSchema>;
export type GrowthProduct = z.infer<typeof productSchema>;

// off(준비중) 기본 안내 — 어드민이 성장레버에서 덮어쓴다.
export const DEFAULT_COMING_SOON: { title: string; body: string } = {
  title: "생성권 충전을 준비하고 있어요",
  body: "결제 기능을 곧 열어드릴게요. 조금만 기다려 주세요!\n그동안 가입할 때 받은 생성권으로 캐릭터를 만들어 볼 수 있어요.",
};

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
  creditsEnabled: false, // PG(포트원) 심사 전 — 기본 OFF(준비중). 어드민에서 켜면 노출.
  comingSoon: DEFAULT_COMING_SOON,
};

/**
 * 결제 노출/체크아웃 허용 판정 — 전역 스위치(creditsEnabled) 또는 심사용 계정(reviewerEmails).
 * 표시(/credits 서버 페이지)와 검증(/api/pay/checkout)이 같은 함수를 쓴다(드리프트 방지).
 */
export function creditsAllowedFor(g: GrowthLevers, email: string | null | undefined): boolean {
  if (g.creditsEnabled ?? false) return true;
  if (!email) return false;
  return (g.reviewerEmails ?? []).includes(email.trim().toLowerCase());
}

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

/** /credits 클라 표시용 묶음 — active 상품 + 결제 노출 여부 + 준비중 안내(미설정 시 안전 폴백). */
export type CreditsConfig = {
  products: CreditProduct[];
  enabled: boolean;
  comingSoon: { title: string; body: string };
};

export function creditsConfig(g: GrowthLevers): CreditsConfig {
  return {
    products: activeCreditProducts(g),
    enabled: g.creditsEnabled ?? false,
    comingSoon: g.comingSoon ?? DEFAULT_COMING_SOON,
  };
}

// 클라(/credits 표시)는 provider 로 active 상품 + 결제노출/준비중안내만. signupBonusCredits·비활성은 서버 전용(callback/checkout).
export const growthEntry: DomainEntry<GrowthLevers> = {
  schema: growthLeversSchema,
  codeDefault: GROWTH_LEVERS_DEFAULT,
};
