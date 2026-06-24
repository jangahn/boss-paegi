import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DocType, LegalDocRow } from "./types";

// 공개 노출은 항상 서버에서 service_role 로 읽어 **발행본만** 투영(테이블은 anon/auth revoke).
const COLS =
  "id, doc_type, status, version, effective_date, title, sections, public_note, admin_note, created_by, created_at, updated_at";

// KST 기준 오늘(YYYY-MM-DD) — published effective_date 비교 기준(RPC 의 SQL KST 와 통일).
export function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 현재 시행본 — published & effective_date<=오늘(KST) 중 최신. */
export async function getCurrentLegal(docType: DocType): Promise<LegalDocRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("legal_documents")
    .select(COLS)
    .eq("doc_type", docType)
    .eq("status", "published")
    .lte("effective_date", kstToday())
    .order("effective_date", { ascending: false })
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as LegalDocRow | null) ?? null;
}

/** 시행 예정본 — published & effective_date>오늘(KST)(예약 발행, doc_type당 0~1개). */
export async function getUpcomingLegal(docType: DocType): Promise<LegalDocRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("legal_documents")
    .select(COLS)
    .eq("doc_type", docType)
    .eq("status", "published")
    .gt("effective_date", kstToday())
    .order("effective_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as LegalDocRow | null) ?? null;
}

/** 개정 이력 — 이미 시행된(또는 오늘 시행) published 전체, 최신순. */
export async function getLegalHistory(docType: DocType): Promise<LegalDocRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("legal_documents")
    .select(COLS)
    .eq("doc_type", docType)
    .eq("status", "published")
    .lte("effective_date", kstToday())
    .order("effective_date", { ascending: false })
    .order("version", { ascending: false });
  return (data as LegalDocRow[] | null) ?? [];
}

/** 공개 단건 — **published 만**(과거/예정본 ?v= 열람용, draft 절대 노출 금지). */
export async function getPublishedLegalById(id: string): Promise<LegalDocRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("legal_documents")
    .select(COLS)
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  return (data as LegalDocRow | null) ?? null;
}

/** 어드민 에디터용 — draft + 발행 이력(전체). */
export async function getLegalAdmin(
  docType: DocType
): Promise<{ draft: LegalDocRow | null; versions: LegalDocRow[] }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("legal_documents")
    .select(COLS)
    .eq("doc_type", docType)
    .order("version", { ascending: false });
  const rows = (data as LegalDocRow[] | null) ?? [];
  return {
    draft: rows.find((r) => r.status === "draft") ?? null,
    versions: rows
      .filter((r) => r.status === "published")
      .sort((a, b) => b.version - a.version),
  };
}
