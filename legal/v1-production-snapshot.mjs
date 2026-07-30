/**
 * Immutable, normalized snapshot of the production v1 legal baseline captured
 * read-only on 2026-07-30. The rollout helper recomputes these digests from the
 * exact production rows before any mutation; a different project, edited v1,
 * or normalization drift fails closed.
 *
 * Normalized shape:
 * {docType,version,effectiveDate,title,sections,publicNote}
 * serialized with scripts/qa/legal-v2-rollout.mjs#stableStringify.
 */
export const LEGAL_V1_PRODUCTION_SNAPSHOT = Object.freeze({
  capturedAt: "2026-07-30",
  effectiveDate: "2026-06-26",
  documents: Object.freeze({
    privacy: Object.freeze({
      version: 1,
      sectionCount: 15,
      normalizedSha256:
        "eecab8d2fe83b8fa6cc194e2528b30b86680a34a4d42b80773bcfb20a865791b",
      postgresJsonbSha256:
        "c69b79fa0fbe3173e399842c6fb46122dc0dea8a91da0cc6919250fb02734794",
    }),
    terms: Object.freeze({
      version: 1,
      sectionCount: 16,
      normalizedSha256:
        "981ae13bdf38e8f3889184584d1bdf8bd1d9a131ea78351279b54aded473b7ed",
      postgresJsonbSha256:
        "dba1a9a2b0af31a7eb885c8e901f30dbd7fb8c8397a951505e09564a1c97c61c",
    }),
  }),
  noticeRights: Object.freeze({
    ordinaryMinimumKstCalendarDays: 7,
    adverseOrMaterialMinimumKstCalendarDays: 30,
  }),
  paidCreditRights: Object.freeze({
    validity: "1_year_from_purchase_or_grant",
    unusedWithinValidity: "refundable_at_any_time",
    withinSevenDays: "100_percent_of_unused_unit_value",
    afterSevenDays: "90_percent_of_unused_unit_value",
    usedCredits: "not_refundable",
    freeCredits: "not_refundable",
    expiredPaidCredits:
      "90_percent_refundable_until_five_years_from_purchase",
    withdrawalFence: "request_before_account_withdrawal",
    paymentDeadline: "within_3_business_days_after_valid_request_verified",
    paymentMethod: "original_payment_method",
    substitutePointsWithoutConsent: false,
    minorStatutoryCancellationRightsPreserved: true,
  }),
});
