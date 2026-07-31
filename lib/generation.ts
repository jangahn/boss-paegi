/**
 * 캐릭터 생성 복구 공용 상수/헬퍼.
 * fal route, doll route, generations route 가 공유.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { log, errInfo } from "@/lib/log";
export {
  QUEUED_STALE_MS,
  SUBMIT_ACK_STALE_MS,
} from "@/lib/character-gen/generation-deadlines";

/** dolls 버킷 재사용 — 확정 캐릭터 + 생성 후보 모두 여기에 */
export const DOLLS_BUCKET = "dolls";

/**
 * done/failed 인데 저장 후보가 fal 요청 수보다 적은(abort 로 일부/전부 누락) row 를
 * 이 시간 안에선 request_id 로 fal 결과를 되찾아 채운다(자가치유). 그 이후엔 fal 결과가
 * 만료됐을 가능성이 커 재시도하지 않는다(불필요한 폴링 차단).
 */
export const INCOMPLETE_RECLAIM_MS = 30 * 60 * 1000;

/** 안 고르고 방치된 후보(done 미선택) 자동 정리 기간 */
export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
/** v2: 미확정 예약(claim~commit)을 "분석 중"으로 보여주는 최대 나이 — 이후는 release 대상. */
export const PREFLIGHT_VISIBLE_MS = 15 * 60 * 1000;
/** v2: 끊김 정리(즉시 환불)된 예약의 interrupted 안내 노출 창(created_at 기준). */
export const PREFLIGHT_INTERRUPTED_VISIBLE_MS = 45 * 60 * 1000;

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
  const paths: string[] = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data: files, error: listError } = await admin.storage
      .from(DOLLS_BUCKET)
      .list(prefix, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
    if (listError) {
      log.warn("gen.candidate_cleanup_fail", {
        genId,
        stage: "list",
        ...errInfo(listError),
      });
      throw listError;
    }
    if (!Array.isArray(files)) {
      throw new Error("gen_candidate_list_response_missing");
    }
    for (const file of files) {
      if (
        !file ||
        typeof file.name !== "string" ||
        file.name.length === 0 ||
        file.name.includes("/") ||
        file.name === "." ||
        file.name === ".."
      ) {
        throw new Error("gen_candidate_list_entry_invalid");
      }
      paths.push(`${prefix}/${file.name}`);
    }
    if (files.length < pageSize) break;
  }
  for (let offset = 0; offset < paths.length; offset += pageSize) {
    const batch = paths.slice(offset, offset + pageSize);
    const { error: removeError } = await admin.storage
      .from(DOLLS_BUCKET)
      .remove(batch);
    if (removeError) {
      log.warn("gen.candidate_cleanup_fail", {
        genId,
        stage: "remove",
        batchSize: batch.length,
        ...errInfo(removeError),
      });
      throw removeError;
    }
  }
}

export type GenerationStatus =
  | "queued"
  | "done"
  | "failed"
  | "picked"
  | "expired";

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
  /**
   * interrupted 사유 — "photo"(얼굴 미검출·안전기준 → 다른 사진 안내) /
   * "provider"(제공자·인프라 실패 — 사진 탓 아님). 없으면 일반(타임아웃·끊김).
   */
  reason?: "photo" | "provider";
  /** v2: generating 의 실제 서버 단계 — analyzing(예약~분석)·drawing(제출 후). */
  phase?: "analyzing" | "drawing";
  /** v2: drawing 중 웹훅으로 이미 적재된 후보 수(0~3) — 실진행 표시용. */
  candidatesReady?: number;
};
