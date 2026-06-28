/**
 * 캐릭터 생성 복구 공용 상수/헬퍼.
 * fal route, doll route, generations route 가 공유.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { log, errInfo } from "@/lib/log";

/** dolls 버킷 재사용 — 확정 캐릭터 + 생성 후보 모두 여기에 */
export const DOLLS_BUCKET = "dolls";

/**
 * queued 인데 이만큼 지나도 안 끝나면 "중단됨"으로 노출.
 * 30분 — 그 안에는 저장된 fal request_id 로 결과를 복구 시도하므로,
 * fal 이 늦게라도 끝나면 ready 로 살아난다. (복구: lib/generation-recovery.ts)
 */
export const QUEUED_STALE_MS = 30 * 60 * 1000;

/**
 * done/failed 인데 저장 후보가 fal 요청 수보다 적은(abort 로 일부/전부 누락) row 를
 * 이 시간 안에선 request_id 로 fal 결과를 되찾아 채운다(자가치유). 그 이후엔 fal 결과가
 * 만료됐을 가능성이 커 재시도하지 않는다(불필요한 폴링 차단).
 */
export const INCOMPLETE_RECLAIM_MS = 30 * 60 * 1000;

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
    // 미선택 후보 정리 실패 — storage 누적/비용 모니터링용 (Sentry 가시화).
    log.warn("gen.candidate_cleanup_fail", { genId, ...errInfo(e) });
  }
}

export type GenerationStatus = "queued" | "done" | "failed" | "picked";

/**
 * 갤러리에 노출할 미완결 생성.
 *  - generating: 생성 중 (queued, fal 처리 중 — 30분 이내)
 *  - ready: 3장 완성·미선택 (고르기 대기)
 *  - interrupted: 생성 중 끊김 (다시 만들기 안내)
 */
export type PendingGeneration = {
  id: string;
  kind: "generating" | "ready" | "interrupted";
  candidateUrls: string[];
  createdAt: string;
  /** 생성 시 선택한 롤 — resume/이어서 시 doll.role 복구용 (없으면 boss) */
  role?: string;
};
