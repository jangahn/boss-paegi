import type { GrowthLevers, GrowthProduct } from "./growth-schema";
import {
  CREDIT_PRODUCT_LIST,
  type CreditProduct,
} from "@/lib/credit-products";
import type { PayMode } from "@/lib/pay-channels";

// 성장 레버 도메인 — 가입 생성권 개수 + 충전 상품(가격/개수). 머니 패스(체크아웃)에 직결.
// 검증 schema(zod · 가격 하한 · 상한 근거)는 `./growth-schema` — 이 모듈은 /credits 클라 번들에 들어가 zod 를 끌어오지 않는다(v1.64).

export type { GrowthLevers, GrowthProduct };

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

/** 테스트 결제 계정(reviewerEmails) 여부 — 결제 허용·채널 모드(테스트/실) 판정의 공용 입력. */
export function isReviewerEmail(g: GrowthLevers, email: string | null | undefined): boolean {
  if (!email) return false;
  return (g.reviewerEmails ?? []).includes(email.trim().toLowerCase());
}

// (구 creditsAllowedFor 는 reviewer 판정이 async 소스(reviewer_accounts, 0060)로 확장되며 제거 —
//  현행 판정: `growth.creditsEnabled || await isReviewerUser(...)`, lib/reviewer.ts 참조.)

/**
 * 결제 채널 모드 판정 — 심사·테스트 계정은 테스트 채널이 기본(실돈 미이동), `?live=1` 요청 시에만
 * 실채널(운영자 실결제 검증용). 일반 계정은 wantLive 와 무관하게 **항상 실채널**(테스트 채널로
 * 무료 크레딧을 얻는 구멍 차단 — 표시(/credits)와 체크아웃이 같은 함수로 판정).
 */
export function payModeFor(isReviewer: boolean, wantLive: boolean): PayMode {
  return isReviewer && !wantLive ? "test" : "live";
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
