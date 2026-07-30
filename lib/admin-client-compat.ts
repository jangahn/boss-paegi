import { z } from "zod";
import { eventSaveSchema } from "./events/types.ts";
import { legalSectionsSchema } from "./legal/types.ts";
import { isDeletedMarker } from "./oauth-metadata.ts";

const uuid = z.string().uuid();
const reason = z.string().trim().min(5).max(500);

const legacyEventSchema = z.discriminatedUnion("action", [
  eventSaveSchema.extend({ action: z.literal("save") }).strict(),
  z.object({ action: z.literal("publish"), id: uuid }).strict(),
  z.object({ action: z.literal("unpublish"), id: uuid }).strict(),
  z.object({ action: z.literal("delete"), id: uuid }).strict(),
]);

const legacyLegalSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save_draft"),
      docType: z.enum(["privacy", "terms"]),
      title: z.string().trim().min(1).max(200),
      sections: legalSectionsSchema,
      publicNote: z.string().trim().max(1000).nullish(),
      adminNote: z.string().trim().max(2000).nullish(),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      docType: z.enum(["privacy", "terms"]),
      effectiveDate: z.iso.date(),
    })
    .strict(),
  z
    .object({
      action: z.literal("unpublish"),
      docType: z.enum(["privacy", "terms"]),
    })
    .strict(),
]);

const legacyReviewerPatchSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set_active"),
      userId: uuid,
      active: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reset_password"),
      userId: uuid,
    })
    .strict(),
]);

const LEGACY_ADMIN_CLIENT_SCHEMAS = {
  adjust: z
    .object({
      targetUserId: uuid,
      delta: z
        .number()
        .int()
        .min(-100)
        .max(100)
        .refine((value) => value !== 0),
      reason,
    })
    .strict(),
  events: legacyEventSchema,
  legal: legacyLegalSchema,
  integrityBan: z.object({ memberId: uuid, reason }).strict(),
  integrityUnban: z.object({ memberId: uuid, reason }).strict(),
  integrityClear: z.object({ scoreId: uuid, reason }).strict(),
  integrityVoid: z.object({ scoreId: uuid, reason }).strict(),
  moderationTakedown: z.object({ dollId: uuid, reason }).strict(),
  moderationDismiss: z.object({ dollId: uuid, reason }).strict(),
  moderationRestore: z.object({ dollId: uuid, reason }).strict(),
  moderationPermanentDelete: z.object({ dollId: uuid, reason }).strict(),
  reactivate: z
    .object({
      userId: uuid,
      reason,
      emailOverride: z
        .string()
        .trim()
        .min(3)
        .max(320)
        .refine((value) => !isDeletedMarker(value))
        .optional(),
    })
    .strict(),
  reviewersPost: z
    .object({
      email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  reviewersPatch: legacyReviewerPatchSchema,
  reviewersDelete: z.object({ userId: uuid }).strict(),
} as const;

export type LegacyAdminClientSurface = keyof typeof LEGACY_ADMIN_CLIENT_SCHEMAS;

export const CLIENT_REFRESH_REQUIRED = Object.freeze({
  error: "client_refresh_required" as const,
  reload: true as const,
});

export type ClientRefreshRequired = {
  status: 409;
  body: typeof CLIENT_REFRESH_REQUIRED;
};

const CLIENT_REFRESH_DECISION: ClientRefreshRequired = Object.freeze({
  status: 409,
  body: CLIENT_REFRESH_REQUIRED,
});

/**
 * Recognizes only request bodies that were valid for the confirmed origin/main
 * admin clients. A partially upgraded or malformed current request must miss
 * these strict schemas and continue to the route's normal 400 validation.
 */
export function legacyAdminClientRefresh(
  surface: LegacyAdminClientSurface,
  value: unknown,
): ClientRefreshRequired | null {
  return LEGACY_ADMIN_CLIENT_SCHEMAS[surface].safeParse(value).success
    ? CLIENT_REFRESH_DECISION
    : null;
}
