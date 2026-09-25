import { z } from "zod";
import type { DomainEntry } from "../registry";
import { GROWTH_LEVERS_DEFAULT } from "./growth";

// 성장 레버 검증 schema(v1.64 분리) — zod 는 서버(getter · 레지스트리 · 어드민 저장)에서만 쓴다. 값 · 헬퍼는 `./growth`.
// 가격: 최소 100원(카카오페이 카드·머니 최소 결제금액 — 공식 FAQ·포트원 도움말 기준, 2026-09-03 사용자 결정으로
//       구 1,000원 카드 PG 하한 가드에서 하향) + 상한 100,000원 가드(과실 과금 방지). productId 불변.
// soft delete = active(false→/credits·checkout 숨김; 과거 주문은 amount/credits 스냅샷이라 무관).
const productSchema = z.object({
  productId: z.string().trim().min(1).max(40),
  goodname: z.string().trim().min(1).max(60),
  price: z.number().int().min(100).max(100000),
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
    // 테스트 결제 계정 allowlist(OAuth 가입 심사관·운영자용, ID/PW 계정은 reviewer_accounts/0060 — OR 판정)
    // 효과 2중: ①등록 계정 결제는 항상 테스트 채널 기본(payModeFor — creditsEnabled 와 무관, ?live=1 시만 실채널)
    // ②creditsEnabled OFF(전역 준비중)여도 /credits 결제 UI·체크아웃 허용(PG 심사 대응).
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

// 클라(/credits 표시)는 provider 로 active 상품 + 결제노출/준비중안내만. signupBonusCredits·비활성은 서버 전용(callback/checkout).
export const growthEntry: DomainEntry<GrowthLevers> = {
  schema: growthLeversSchema,
  codeDefault: GROWTH_LEVERS_DEFAULT,
};
