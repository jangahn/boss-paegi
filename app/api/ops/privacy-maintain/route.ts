import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { SERVER_ENV } from "@/lib/env.server";
import { cronSecretMatches } from "@/lib/ops-auth";
import {
  createOpsMaintenanceDeadline,
  opsMaintenanceResponseInit,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import {
  PRIVACY_RETENTION_LIMIT,
  COMMERCE_DISPLAY_RETENTION_LIMIT,
  parseCommerceDisplayRetentionResult,
  parseOAuthAnonPrivacyStatus,
  oauthAnonPrivacyHasFailure,
  oauthAnonPrivacyNeedsRetry,
  parsePrivacyRetentionResult,
  privacyRetentionNeedsRetry,
} from "@/lib/privacy-retention";
import { createAdminClient } from "@/lib/supabase/admin";
import { errInfo, log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 25;

function unavailable(error: string) {
  return NextResponse.json(
    { ok: false, error },
    opsMaintenanceResponseInit(503),
  );
}

/**
 * Daily privacy retention worker.
 *
 * The DB owns the five/three-year cutoffs, terminal-state proof, fencing,
 * aggregates, and child-first deletion/scrub transaction. This route only
 * authenticates the scheduler and validates the exact bounded result.
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) return unavailable("maintain_disabled");
  if (!cronSecretMatches(req.headers.get("x-cron-secret"), secret)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      opsMaintenanceResponseInit(401),
    );
  }

  const deadline = createOpsMaintenanceDeadline();
  return runOpsMaintenanceWithDeadline(
    deadline,
    async () => {
      try {
        const admin = createAdminClient();
        const { data, error } = await admin
          .rpc("maintain_privacy_retention", {
            p_limit: PRIVACY_RETENTION_LIMIT,
          })
          .abortSignal(deadline.signal);
        if (error) throw error;
        const result = parsePrivacyRetentionResult(
          data,
          PRIVACY_RETENTION_LIMIT,
        );
        if (!result) throw new Error("privacy_retention_invalid_result");
        const {
          data: commerceData,
          error: commerceError,
        } = await admin
          .rpc("prune_commerce_display_evidence", {
            p_limit: COMMERCE_DISPLAY_RETENTION_LIMIT,
          })
          .abortSignal(deadline.signal);
        if (commerceError) throw commerceError;
        const commerceDisplayEvidence =
          parseCommerceDisplayRetentionResult(
            commerceData,
            COMMERCE_DISPLAY_RETENTION_LIMIT,
          );
        if (!commerceDisplayEvidence) {
          throw new Error("commerce_display_retention_invalid_result");
        }

        const {
          data: oauthAnonPrivacyData,
          error: oauthAnonPrivacyError,
        } = await admin
          .rpc("oauth_anon_privacy_status")
          .abortSignal(deadline.signal);
        if (oauthAnonPrivacyError) {
          throw oauthAnonPrivacyError;
        }
        const oauthAnonPrivacy =
          parseOAuthAnonPrivacyStatus(
            oauthAnonPrivacyData,
          );
        if (!oauthAnonPrivacy) {
          throw new Error(
            "oauth_anon_privacy_status_invalid_result",
          );
        }

        const retryPending =
          privacyRetentionNeedsRetry(
            result,
            PRIVACY_RETENTION_LIMIT,
          ) ||
          commerceDisplayEvidence.hasMore ||
          oauthAnonPrivacyNeedsRetry(oauthAnonPrivacy);
        const status =
          !result.ok ||
          oauthAnonPrivacyHasFailure(oauthAnonPrivacy)
            ? 503
            : retryPending
              ? 429
              : 200;
        return NextResponse.json(
          {
            ...result,
            ok: status === 200,
            policyReady: result.legalBlockers.length === 0,
            retryPending,
            commerceDisplayEvidence,
            oauthAnonPrivacy,
          },
          opsMaintenanceResponseInit(status),
        );
      } catch (error) {
        log.error("privacy_maintain.fail", errInfo(error));
        return unavailable("privacy_maintain_failed");
      }
    },
    () =>
      NextResponse.json(
        { ok: false, error: "maintenance_time_budget", retryPending: true },
        opsMaintenanceResponseInit(429),
      ),
  );
}
