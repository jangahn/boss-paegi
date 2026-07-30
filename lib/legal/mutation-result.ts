import { z } from "zod";

const uuid = z.string().uuid();
const positiveVersion = z.number().int().positive();
const date = z.iso.date();
const timestamp = z.string().datetime({ offset: true });

const saveResultSchema = z
  .object({
    ok: z.literal(true),
    draft_id: uuid,
    draft_updated_at: timestamp,
  })
  .strict();

const publishResultSchema = z
  .object({
    ok: z.literal(true),
    published_id: uuid,
    version: positiveVersion,
    effective_date: date,
  })
  .strict();

const unpublishResultSchema = z
  .object({
    ok: z.literal(true),
    restored_draft: z.boolean(),
    version: positiveVersion,
  })
  .strict();

export type LegalSaveResult = z.infer<typeof saveResultSchema>;
export type LegalPublishResult = z.infer<typeof publishResultSchema>;
export type LegalUnpublishResult = z.infer<typeof unpublishResultSchema>;

function parseResult<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("invalid_rpc_response");
  }
  return parsed.data;
}

export const parseLegalSaveResult = (value: unknown) =>
  parseResult(saveResultSchema, value);

export const parseLegalPublishResult = (value: unknown) =>
  parseResult(publishResultSchema, value);

export const parseLegalUnpublishResult = (value: unknown) =>
  parseResult(unpublishResultSchema, value);
