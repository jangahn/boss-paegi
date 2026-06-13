/**
 * 캐릭터 생성 복구 공용 상수/헬퍼.
 * fal route, doll route, generations route 가 공유.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** dolls 버킷 재사용 — 확정 인형 + 생성 후보 모두 여기에 */
export const DOLLS_BUCKET = "dolls";

/** 생성 중(queued)인데 이만큼 지나면 끊긴 것으로 간주 (생성 함수 ~60s) */
export const QUEUED_STALE_MS = 5 * 60 * 1000;

/** 안 고르고 방치된 후보(done 미선택) 자동 정리 기간 */
export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

/** 후보 이미지 storage 경로 prefix — {owner}/candidates/{genId}/ */
export function candidatePrefix(ownerId: string, genId: string): string {
  return `${ownerId}/candidates/${genId}`;
}

/** 후보 storage 폴더 전체 삭제 ({owner}/candidates/{genId}/*) — 서버 전용 */
export async function cleanupCandidateStorage(
  admin: SupabaseClient,
  ownerId: string,
  genId: string
): Promise<void> {
  const prefix = candidatePrefix(ownerId, genId);
  try {
    const { data: files } = await admin.storage.from(DOLLS_BUCKET).list(prefix);
    if (files && files.length > 0) {
      await admin.storage
        .from(DOLLS_BUCKET)
        .remove(files.map((f) => `${prefix}/${f.name}`));
    }
  } catch (e) {
    console.warn("[generation] candidate cleanup failed:", e);
  }
}

export type GenerationStatus = "queued" | "done" | "failed" | "picked";

/**
 * 갤러리에 노출할 미완결 생성.
 *  - generating: 생성 중 (queued, 5분 이내)
 *  - ready: 3장 완성·미선택 (고르기 대기)
 *  - interrupted: 생성 중 끊김 (다시 만들기 안내)
 */
export type PendingGeneration = {
  id: string;
  kind: "generating" | "ready" | "interrupted";
  candidateUrls: string[];
  createdAt: string;
};
