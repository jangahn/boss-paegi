import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveCurrentLegalDocumentRead,
  resolveLegalVersionsRead,
  type ConsentLegalDocumentShape,
  type LegalVersionRow,
} from "@/lib/auth-read-policy";
import type { LegalVersions } from "@/lib/consent";
import type { DocType, LegalDocRow } from "./types";
import { kstDateAt } from "./kst-boundary";

const CONSENT_DOC_COLS =
  "doc_type, status, version, effective_date, title, sections";

export type ConsentLegalDocument = Pick<
  LegalDocRow,
  "doc_type" | "status" | "version" | "effective_date" | "title" | "sections"
>;

/**
 * 인증·동의 보안경계용 현재 법무 버전.
 * 기존 공개 getter의 fail-open 계약과 분리해 `{ error }`/손상 데이터를 throw한다.
 *
 * 이 읽기는 의도적으로 캐시하지 않는다. 미래 시행본은 별도의 publish 요청 없이 KST
 * 자정에 현재본이 되므로 TTL 캐시는 이미 시행된 새 약관을 구 버전으로 판정할 수 있다.
 */
export async function getCurrentLegalVersionsStrict(
  signal?: AbortSignal,
): Promise<LegalVersions> {
  const admin = createAdminClient();
  const today = kstDateAt();
  // Query each document independently. A combined unbounded history read can
  // hit PostgREST's row cap (for example, many terms versions before the first
  // privacy row) and misclassify an existing current document as absent.
  const [terms, privacy] = await Promise.all(
    (["terms", "privacy"] as const).map((docType) => {
      let query = admin
        .from("legal_documents")
        .select("doc_type, version")
        .eq("doc_type", docType)
        .eq("status", "published")
        .lte("effective_date", today)
        .order("effective_date", { ascending: false })
        .order("version", { ascending: false })
        .order("id", { ascending: false })
        .limit(1);
      if (signal) query = query.abortSignal(signal);
      return query.maybeSingle();
    }),
  );
  const error = terms.error ?? privacy.error;
  const resolved = resolveLegalVersionsRead({
    data:
      error === null
        ? ([terms.data, privacy.data].filter(
            (row): row is LegalVersionRow => row !== null,
          ) as LegalVersionRow[])
        : null,
    error,
  });
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.data;
}

/**
 * 동의 화면용 현재 전문. 버전 조회 직후 publish 상태가 바뀌어 다른 문서를 표시하는 race까지
 * 차단하도록 호출자가 기대한 버전과 현재 시행본의 identity/표시 필드를 함께 검증한다.
 */
export async function getCurrentLegalDocumentStrict(
  docType: DocType,
  expectedVersion: number,
): Promise<ConsentLegalDocument> {
  const admin = createAdminClient();
  const result = await admin
    .from("legal_documents")
    .select(CONSENT_DOC_COLS)
    .eq("doc_type", docType)
    .eq("status", "published")
    .lte("effective_date", kstDateAt())
    .order("effective_date", { ascending: false })
    .order("version", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const resolved = resolveCurrentLegalDocumentRead(
    docType,
    expectedVersion,
    {
      data: result.data as (ConsentLegalDocument &
        ConsentLegalDocumentShape) | null,
      error: result.error,
    },
  );
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.data;
}
