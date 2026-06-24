import { z } from "zod";

// 법무 문서 2종 고정. config 도메인이 아니라 전용 메커니즘(legal_documents 테이블).
export const DOC_TYPES = ["privacy", "terms"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export function isDocType(s: string): s is DocType {
  return (DOC_TYPES as readonly string[]).includes(s);
}
export const DOC_LABEL: Record<DocType, string> = {
  privacy: "개인정보처리방침",
  terms: "이용약관",
};
export const DOC_PATH: Record<DocType, string> = {
  privacy: "/privacy",
  terms: "/terms",
};

// 구조화 섹션(제목+본문). 사이즈 한도 = RPC(legal_sections_valid)와 동일.
export const legalSectionSchema = z.object({
  heading: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20000),
});
export type LegalSection = z.infer<typeof legalSectionSchema>;

export const legalSectionsSchema = z
  .array(legalSectionSchema)
  .min(1)
  .max(50)
  .refine(
    (s) => Buffer.byteLength(JSON.stringify(s), "utf8") <= 200_000,
    "sections_too_large"
  );

export type LegalStatus = "draft" | "published";
export type LegalDocRow = {
  id: string;
  doc_type: DocType;
  status: LegalStatus;
  version: number;
  effective_date: string | null;
  title: string;
  sections: LegalSection[];
  public_note: string | null;
  admin_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
