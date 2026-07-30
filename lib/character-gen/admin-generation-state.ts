import { INPUT_REJECT_REASONS } from "./face-analysis.ts";

export type AdminGenerationStatus =
  | "requested"
  | "rejected"
  | "failed"
  | "unpicked"
  | "expired"
  | "picked";

export const ADMIN_GENERATION_STATUS_FILTERS = [
  "all",
  "requested",
  "rejected",
  "unpicked",
  "expired",
  "picked",
  "failed",
] as const;

export type AdminGenerationStatusFilter =
  (typeof ADMIN_GENERATION_STATUS_FILTERS)[number];
export type AdminGenerationCreditNote = "consumed" | "refunded" | "none";
export type AdminGenerationThumbnailMode = "candidates" | "picked" | "none";

export function isInputRejection(failReason: string | null): boolean {
  return (
    failReason !== null &&
    (INPUT_REJECT_REASONS as readonly string[]).includes(failReason)
  );
}

export function deriveAdminGenerationStatus(
  status: string,
  failReason: string | null,
): AdminGenerationStatus {
  if (status === "picked") return "picked";
  if (status === "expired") return "expired";
  if (status === "done") return "unpicked";
  if (status === "failed") {
    return isInputRejection(failReason) ? "rejected" : "failed";
  }
  return "requested";
}

export function deriveGenerationCreditNote(
  creditLotId: string | null,
  refundedAt: string | null,
): AdminGenerationCreditNote {
  if (creditLotId === null) return "none";
  return refundedAt === null ? "consumed" : "refunded";
}

export function generationThumbnailMode(
  status: AdminGenerationStatus,
): AdminGenerationThumbnailMode {
  if (status === "unpicked") return "candidates";
  if (status === "picked") return "picked";
  // expired는 candidate_urls가 정리 재시도 manifest로 남아도 서명/노출하지 않는다.
  return "none";
}
