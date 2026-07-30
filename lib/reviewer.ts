import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isReviewerEmail, type GrowthLevers } from "@/lib/config/domains/growth";
import {
  resolveReviewerAccountRead,
  type ReviewerStatus,
} from "@/lib/reviewer-status";

/**
 * 심사·테스트 계정 판정(서버 전용) — 두 소스의 합집합:
 *  1) growth_levers.reviewerEmails(콘솔 편집) — 구글/카카오 OAuth 로 직접 가입한 심사관 이메일 allowlist.
 *  2) reviewer_accounts(0060, 어드민 /admin/reviewers CUD) — ID/PW 테스트 계정(active 만).
 * /credits 표시와 /api/pay/checkout 이 같은 함수를 사용(드리프트 방지). true 면 creditsEnabled OFF
 * 여도 결제 UI·체크아웃이 열리고, 채널은 테스트가 기본(payModeFor — ?live=1 시에만 실채널).
 * 조회 실패를 false로 축소하면 실제 심사 계정이 LIVE 채널로 떨어진다. 호출자는
 * `{ok:false}`에서 결제/채널 결정을 중단해야 한다.
 */
export async function getReviewerStatus(
  growth: GrowthLevers,
  user: { id: string; email?: string | null }
): Promise<ReviewerStatus> {
  if (isReviewerEmail(growth, user.email)) {
    return { ok: true, isReviewer: true };
  }
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("reviewer_accounts")
      .select("active, auth_sync_pending")
      .eq("user_id", user.id)
      .maybeSingle();
    return resolveReviewerAccountRead({ data, error });
  } catch (error) {
    return { ok: false, error };
  }
}
