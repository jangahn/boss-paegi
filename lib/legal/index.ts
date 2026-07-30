import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readSupabaseRowsPaginated,
  requireSupabaseOptionalData,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import {
  isDocType,
  legalSectionsSchema,
  type DocType,
  type LegalDocRow,
} from "./types";
import { kstDateAt } from "./kst-boundary";

// 공개 노출은 항상 서버에서 service_role 로 읽어 **발행본만** 투영(테이블은 anon/auth revoke).
const COLS =
  "id, doc_type, status, version, effective_date, title, sections, public_note, admin_note, created_by, created_at, updated_at";

const LEGAL_ROW_SCHEMA = {
  id: "uuid",
  doc_type: "string",
  status: "string",
  version: "nonnegativeInteger",
  effective_date: "nullableDate",
  title: "string",
  sections: "array",
  public_note: "nullableText",
  admin_note: "nullableText",
  created_by: "nullableUuid",
  created_at: "timestamp",
  updated_at: "timestamp",
} as const;

function validateLegalRows(
  operation: string,
  value: unknown,
  expectedDocType?: DocType,
): LegalDocRow[] {
  const rows = validateAdminRows<LegalDocRow>(
    operation,
    value,
    LEGAL_ROW_SCHEMA,
  );
  for (const row of rows) {
    if (
      !isDocType(row.doc_type) ||
      (expectedDocType !== undefined && row.doc_type !== expectedDocType) ||
      (row.status !== "draft" && row.status !== "published") ||
      row.version < 1 ||
      row.title.length > 200 ||
      !legalSectionsSchema.safeParse(row.sections).success ||
      (row.status === "published" && row.effective_date === null)
    ) {
      throw new SupabaseOperationError(
        operation,
        new Error("invalid_legal_document_row"),
      );
    }
  }
  return rows;
}

// KST 기준 오늘(YYYY-MM-DD) — published effective_date 비교 기준(RPC 의 SQL KST 와 통일).
export function kstToday(): string {
  return kstDateAt();
}

/** 현재 시행본 — published & effective_date<=오늘(KST) 중 최신. */
export async function getCurrentLegal(docType: DocType): Promise<LegalDocRow | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    `legal.current.${docType}`,
    () =>
      admin
        .from("legal_documents")
        .select(COLS)
        .eq("doc_type", docType)
        .eq("status", "published")
        .lte("effective_date", kstToday())
        .order("effective_date", { ascending: false })
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
  );
  return data
    ? validateLegalRows(`legal.current.${docType}`, [data], docType)[0]!
    : null;
}

/** 시행 예정본 — published & effective_date>오늘(KST)(예약 발행, doc_type당 0~1개). */
export async function getUpcomingLegal(docType: DocType): Promise<LegalDocRow | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    `legal.upcoming.${docType}`,
    () =>
      admin
        .from("legal_documents")
        .select(COLS)
        .eq("doc_type", docType)
        .eq("status", "published")
        .gt("effective_date", kstToday())
        .order("effective_date", { ascending: true })
        .limit(1)
        .maybeSingle(),
  );
  return data
    ? validateLegalRows(`legal.upcoming.${docType}`, [data], docType)[0]!
    : null;
}

/** 개정 이력 — 이미 시행된(또는 오늘 시행) published 전체, 최신순. */
export async function getLegalHistory(docType: DocType): Promise<LegalDocRow[]> {
  const admin = createAdminClient();
  const rows = await readSupabaseRowsPaginated<LegalDocRow>(
    `legal.history.${docType}`,
    (offset, limit) =>
      admin
        .from("legal_documents")
        .select(COLS)
        .eq("doc_type", docType)
        .eq("status", "published")
        .lte("effective_date", kstToday())
        .order("effective_date", { ascending: false })
        .order("version", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1),
  );
  return validateLegalRows(`legal.history.${docType}`, rows, docType);
}

/** 공개 단건 — **published 만**(과거/예정본 ?v= 열람용, draft 절대 노출 금지). */
export async function getPublishedLegalById(id: string): Promise<LegalDocRow | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseOptionalData(
    "legal.published_by_id",
    () =>
      admin
        .from("legal_documents")
        .select(COLS)
        .eq("id", id)
        .eq("status", "published")
        .maybeSingle(),
  );
  return data
    ? validateLegalRows("legal.published_by_id", [data])[0]!
    : null;
}

/** 어드민 에디터용 — draft + 발행 이력(전체). */
export async function getLegalAdmin(
  docType: DocType
): Promise<{ draft: LegalDocRow | null; versions: LegalDocRow[] }> {
  const admin = createAdminClient();
  const rows = await readSupabaseRowsPaginated<LegalDocRow>(
    `legal.admin.${docType}`,
    (offset, limit) =>
      admin
        .from("legal_documents")
        .select(COLS)
        .eq("doc_type", docType)
        .order("version", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1),
  );
  const validated = validateLegalRows(`legal.admin.${docType}`, rows, docType);
  const drafts = validated.filter((row) => row.status === "draft");
  if (drafts.length > 1) {
    throw new SupabaseOperationError(
      `legal.admin.${docType}`,
      new Error("multiple_drafts"),
    );
  }
  return {
    draft: drafts[0] ?? null,
    versions: validated
      .filter((r) => r.status === "published")
      .sort((a, b) => b.version - a.version),
  };
}
