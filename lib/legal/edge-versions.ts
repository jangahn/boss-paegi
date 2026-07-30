// Edge-safe 현재 발행본 버전 리더 — **proxy(미들웨어) 전용**.
// `lib/legal/index.ts`(server-only·unstable_cache)는 edge 번들에 못 들어가므로 분리.
// **선택 규칙은 `getCurrentLegal`과 동일해야 함**(검증 테스트로 보장): published &
// effective_date<=KST today 중 doc_type별 (effective_date desc, version desc) 최신.
// 캐시는 edge **isolate별** 모듈레벨 60s(전 region 동시 아님 — app server `requireMember`가 최종 백스톱).
import { createClient } from "@supabase/supabase-js";
import type { LegalVersions } from "@/lib/consent";
import {
  legalEdgeCacheIdentityAt,
  legalEdgeCacheUsable,
} from "./edge-cache-policy";

let cache: {
  v: LegalVersions;
  kstDate: string;
  expiresAt: number;
} | null = null;

// KST 기준 오늘(YYYY-MM-DD) — getCurrentLegal.kstToday 와 동일.
function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * 현재 발행본 `{terms,privacy}` 버전. **실패 시 throw**(호출부가 catch → fail-open).
 * 성공만 캐시(실패는 다음 요청에 재시도).
 */
export async function readCurrentLegalVersionsEdge(): Promise<LegalVersions> {
  const now = Date.now();
  const cached = cache;
  if (cached && legalEdgeCacheUsable(cached, now)) return cached.v;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("supabase env missing (edge versions)");

  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const today = kstToday();
  // Read each document independently with limit(1). A combined history query
  // can hit PostgREST's max-row cap before the other document type appears.
  const [termsResult, privacyResult] = await Promise.all(
    (["terms", "privacy"] as const).map((docType) =>
      admin
        .from("legal_documents")
        .select("doc_type, version")
        .eq("doc_type", docType)
        .eq("status", "published")
        .lte("effective_date", today)
        .order("effective_date", { ascending: false })
        .order("version", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
  );
  const error = termsResult.error ?? privacyResult.error;
  if (error) throw error;
  const version = (
    expectedType: "terms" | "privacy",
    row: unknown,
  ): number | null => {
    if (row === null) return null;
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      (row as { doc_type?: unknown }).doc_type !== expectedType ||
      !Number.isSafeInteger((row as { version?: unknown }).version) ||
      ((row as { version: number }).version as number) < 1
    ) {
      throw new Error(`invalid edge legal version (${expectedType})`);
    }
    return (row as { version: number }).version;
  };
  const terms = version("terms", termsResult.data);
  const privacy = version("privacy", privacyResult.data);
  const v: LegalVersions = { terms, privacy };
  cache = { v, ...legalEdgeCacheIdentityAt(Date.now()) };
  return v;
}
