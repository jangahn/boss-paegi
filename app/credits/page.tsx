import { createClient } from "@/lib/supabase/server";
import { getGrowthLevers } from "@/lib/config/getters";
import { creditsConfig, creditsAllowedFor } from "@/lib/config/domains/growth";
import { CreditsClient } from "./CreditsClient";

/**
 * 생성권 충전 — 서버 페이지. 노출 여부는 발행 config(creditsEnabled) + PG 심사용 계정
 * allowlist(reviewerEmails)로 판정해 클라에 내려준다(판정 함수는 체크아웃과 공유 — 드리프트 방지).
 * (회원 게이트는 proxy.ts 가 처리 — 비회원은 /login 으로. 결제 검증은 항상 서버 재검사.)
 */
export default async function CreditsPage() {
  const [growth, supabase] = await Promise.all([getGrowthLevers(), createClient()]);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const cfg = creditsConfig(growth);
  const enabled = creditsAllowedFor(growth, user?.email);

  return <CreditsClient products={cfg.products} enabled={enabled} comingSoon={cfg.comingSoon} />;
}
