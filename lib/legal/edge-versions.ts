// Edge-safe 현재 발행본 버전 리더 — **proxy(미들웨어) 전용**.
// `lib/legal/index.ts`(server-only·unstable_cache)는 edge 번들에 못 들어가므로 분리.
// **선택 규칙은 `getCurrentLegal`과 동일해야 함**(검증 테스트로 보장): published &
// effective_date<=KST today 중 doc_type별 (effective_date desc, version desc) 최신.
// 캐시는 edge **isolate별** 모듈레벨 60s(전 region 동시 아님 — app server `requireMember`가 최종 백스톱).
import { createClient } from "@supabase/supabase-js";
import type { LegalVersions } from "@/lib/consent";

const TTL_MS = 60_000;
let cache: { v: LegalVersions; at: number } | null = null;

// KST 기준 오늘(YYYY-MM-DD) — getCurrentLegal.kstToday 와 동일.
function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * 현재 발행본 `{terms,privacy}` 버전. **실패 시 throw**(호출부가 catch → fail-open).
 * 성공만 캐시(실패는 다음 요청에 재시도).
 */
export async function readCurrentLegalVersionsEdge(): Promise<LegalVersions> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("supabase env missing (edge versions)");

  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin
    .from("legal_documents")
    .select("doc_type, version")
    .eq("status", "published")
    .lte("effective_date", kstToday())
    .order("effective_date", { ascending: false })
    .order("version", { ascending: false });
  if (error) throw error;

  let terms: number | null = null;
  let privacy: number | null = null;
  for (const r of (data as { doc_type: string; version: number }[] | null) ?? []) {
    if (r.doc_type === "terms" && terms === null) terms = r.version;
    if (r.doc_type === "privacy" && privacy === null) privacy = r.version;
  }
  const v: LegalVersions = { terms, privacy };
  cache = { v, at: Date.now() };
  return v;
}
