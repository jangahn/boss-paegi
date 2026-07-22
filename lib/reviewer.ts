import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isReviewerEmail, type GrowthLevers } from "@/lib/config/domains/growth";
import { log, errInfo } from "@/lib/log";

/**
 * 심사·테스트 계정 판정(서버 전용) — 두 소스의 합집합:
 *  1) growth_levers.reviewerEmails(콘솔 편집) — 구글/카카오 OAuth 로 직접 가입한 심사관 이메일 allowlist.
 *  2) reviewer_accounts(0060, 어드민 /admin/reviewers CUD) — ID/PW 테스트 계정(active 만).
 * /credits 표시와 /api/pay/checkout 이 같은 함수를 사용(드리프트 방지). true 면 creditsEnabled OFF
 * 여도 결제 UI·체크아웃이 열리고, 채널은 테스트가 기본(payModeFor — ?live=1 시에만 실채널).
 * 조회 실패는 false(fail-closed) — 일반 유저 경로(실채널)로 떨어진다.
 */
export async function isReviewerUser(
  growth: GrowthLevers,
  user: { id: string; email?: string | null }
): Promise<boolean> {
  if (isReviewerEmail(growth, user.email)) return true;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("reviewer_accounts")
    .select("active")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    log.warn("reviewer.lookup_fail", { userId: user.id, ...errInfo(error) });
    return false;
  }
  return data?.active === true;
}
