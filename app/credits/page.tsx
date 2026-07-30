import { createClient } from "@/lib/supabase/server";
import { getGrowthLeversStrict } from "@/lib/config/getters";
import {
  creditsConfig,
  GROWTH_LEVERS_DEFAULT,
  payModeFor,
} from "@/lib/config/domains/growth";
import { getReviewerStatus } from "@/lib/reviewer";
import { paymentCheckoutEnabled } from "@/lib/pay/checkout-rollout";
import { paymentChannels } from "@/lib/pay-channels";
import { recordCreditsOfferDisplayEvidence } from "@/lib/pay/display-evidence";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import { CreditsClient } from "./CreditsClient";

/**
 * 생성권 충전 — 서버 페이지. 노출 여부는 발행 config(creditsEnabled) + PG 심사용 계정
 * allowlist(reviewerEmails)로 판정해 클라에 내려준다(판정 함수는 체크아웃과 공유 — 드리프트 방지).
 * 채널 모드도 서버 판정: 심사 계정=테스트 채널(기본), `?live=1` 시 실채널. 일반 유저=항상 실채널.
 * (회원 게이트는 proxy.ts 가 처리 — 비회원은 /login 으로. 결제 검증은 항상 서버 재검사.)
 */
export default async function CreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [growthRead, supabase, params] = await Promise.all([
    getGrowthLeversStrict()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error })),
    createClient(),
    searchParams,
  ]);
  if (!growthRead.ok) {
    log.error("credits.growth_config_read_fail", errInfo(growthRead.error));
    const fallback = creditsConfig(GROWTH_LEVERS_DEFAULT);
    return (
      <CreditsClient
        products={fallback.products}
        enabled={false}
        comingSoon={fallback.comingSoon}
        payMode="live"
        classificationUnavailable
      />
    );
  }
  const growth = growthRead.value;
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  const cfg = creditsConfig(growth);
  // reviewer = config allowlist(OAuth 심사관) OR reviewer_accounts(ID/PW 테스트 계정) — lib/reviewer.ts.
  const reviewer =
    !userError && user
      ? await getReviewerStatus(growth, user)
      : {
          ok: false as const,
          error: userError ?? new Error("credits_user_missing"),
        };
  if (!reviewer.ok) {
    log.error("credits.reviewer_lookup_fail", {
      userId: user?.id,
      ...errInfo(reviewer.error),
    });
    return (
      <CreditsClient
        products={cfg.products}
        enabled={false}
        comingSoon={cfg.comingSoon}
        payMode="live"
        classificationUnavailable
      />
    );
  }
  const isReviewer = reviewer.isReviewer;
  // Reviewer status never bypasses the immutable withdrawal-limit evidence
  // contract. The exact rollout env still keeps UI and API identically frozen
  // until the DB expand/contract and smoke gates have completed.
  let enabled =
    paymentCheckoutEnabled() &&
    ((growth.creditsEnabled ?? false) || isReviewer);
  const payMode = payModeFor(isReviewer, params.live === "1");
  const channels = paymentChannels(payMode);
  let offerEvidence: Readonly<{
    evidenceId: string;
    snapshotSha256: string;
  }> | null = null;
  if (enabled && channels.length > 0) {
    try {
      offerEvidence = await recordCreditsOfferDisplayEvidence(
        createAdminClient(),
        {
          products: cfg.products,
          payMode,
          channels: channels.map(({ method, label }) => ({ method, label })),
        },
      );
    } catch (error) {
      log.error("credits.offer_evidence_write_fail", {
        userId: user?.id,
        ...errInfo(error),
      });
      // No product, price, or withdrawal-limit copy may render unless the
      // exact visible snapshot has a durable six-month evidence receipt.
      enabled = false;
      return (
        <CreditsClient
          products={cfg.products}
          enabled={false}
          comingSoon={cfg.comingSoon}
          payMode={payMode}
          classificationUnavailable
        />
      );
    }
  }

  return (
    <CreditsClient
      products={cfg.products}
      enabled={enabled}
      comingSoon={cfg.comingSoon}
      payMode={payMode}
      offerEvidenceId={offerEvidence?.evidenceId ?? null}
      offerSnapshotSha256={offerEvidence?.snapshotSha256 ?? null}
    />
  );
}
