import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CANDIDATE_TTL_MS,
  QUEUED_STALE_MS,
  INCOMPLETE_RECLAIM_MS,
  cleanupCandidateStorage,
  type PendingGeneration,
} from "@/lib/generation";
import { recoverQueuedGeneration } from "@/lib/generation-recovery";
import { deleteFaceTmp, tmpFacePath } from "@/lib/character-gen/upload-face";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
// 복구가 fal queue.status/result + 후보 복사를 할 수 있어 여유 둠. 행별 복구는 병렬.
export const maxDuration = 30;

/**
 * 미완결 캐릭터 생성 목록 + lazy 정리/복구. (비동기 생성의 완료 수집 허브)
 *  - generating: queued, 아직 fal 처리 중 (또는 30분 전 일시 오류 — 계속 폴링)
 *  - ready: 복구로 후보 확보(또는 done 미선택 24h 이내) → 고르기 대기
 *  - interrupted: queued 30분 초과 + 복구 실패 → failed 마킹 후 1회 노출
 *
 * 비동기 전환: /api/fal 는 fal 에 제출만 하고 반환 → 라이브 함수가 없으므로
 * queued 를 처음부터 fal status 로 폴링한다. 단 30분 전엔 일시 실패도 generating
 * 으로 유지(조기 실패 방지). 행별 복구는 Promise.all 로 병렬(슬롯 점유 시간↓).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const baseQuery = (cols: string) =>
    admin
      .from("ai_generations")
      .select(cols)
      .eq("owner_id", user.id)
      // failed 도 포함 — 타임아웃으로 실패 마킹됐지만 fal 은 완성한 건을 되찾기 위해.
      .in("status", ["queued", "done", "failed"])
      .order("created_at", { ascending: false })
      .limit(20);

  // migration 0006(fal_request_ids) 미적용 환경이면 컬럼 없이 재조회 (복구만 비활성)
  let rows: Record<string, unknown>[];
  const sel = await baseQuery(
    "id, status, candidate_urls, created_at, fal_request_ids"
  );
  if (sel.error && sel.error.message.includes("fal_request_ids")) {
    const fb = await baseQuery("id, status, candidate_urls, created_at");
    rows = (fb.data as Record<string, unknown>[] | null) ?? [];
  } else {
    rows = (sel.data as Record<string, unknown>[] | null) ?? [];
  }

  const now = Date.now();
  const ownerId = user.id;

  // 임시 얼굴 삭제(fal 이 fetch 끝난 뒤 — 정책 #1: 원본 폐기). 호출부에서 await 해야
  // 서버리스 freeze 전에 완료가 보장된다(fire-and-forget 은 응답 후 드랍될 수 있음).
  // 삭제 실패는 원본이 남아있을 수 있다는 정책 리스크이므로 반드시 가시화(Sentry).
  // (pick 시 doll route 가 awaited 로 한 번 더 확정 정리 — 폴링이 놓쳐도 안전.)
  const cleanupFace = (genId: string): Promise<void> =>
    deleteFaceTmp(tmpFacePath(ownerId, genId)).catch((e) =>
      log.warn("gen.face_cleanup_fail", { userId: ownerId, genId, ...errInfo(e) })
    );

  const handleRow = async (
    r: Record<string, unknown>
  ): Promise<PendingGeneration | null> => {
    const id = r.id as string;
    const createdAt = r.created_at as string;
    const age = now - new Date(createdAt).getTime();
    const candidateUrls = Array.isArray(r.candidate_urls)
      ? (r.candidate_urls as string[])
      : [];
    const requestIds = Array.isArray(r.fal_request_ids)
      ? (r.fal_request_ids as string[])
      : [];
    // 저장 후보가 fal 요청 수보다 적음 = 일부/전부 누락 → 되찾을 여지
    const incomplete =
      requestIds.length > 0 && candidateUrls.length < requestIds.length;

    if (r.status === "queued") {
      if (requestIds.length > 0) {
        // 30분 넘으면 마감 — 완료분만으로 확정(받은 만큼 살림). 그 전엔 계속 대기.
        const rec = await recoverQueuedGeneration(
          admin,
          ownerId,
          id,
          requestIds,
          age > QUEUED_STALE_MS
        );
        if (rec.status === "ready") {
          await cleanupFace(id);
          log.info("gen.recovered_ready", { userId: ownerId, genId: id, ageMs: age });
          return { id, kind: "ready", candidateUrls: rec.candidateUrls, createdAt };
        }
        // pending, 또는 30분 전 일시 실패 → 아직 생성중으로 유지(조기 실패 방지)
        if (age <= QUEUED_STALE_MS) {
          return { id, kind: "generating", candidateUrls: [], createdAt };
        }
        // age > 30분 & not ready → 끊김 확정 (아래)
      } else if (age <= QUEUED_STALE_MS) {
        // request_id 없음(구버전 row) — 시간 기반으로 30분까진 생성중
        return { id, kind: "generating", candidateUrls: [], createdAt };
      }

      // 끊김 확정 — failed 마킹 + "다시 만들기" 1회 노출, 임시 얼굴 정리
      log.warn("gen.stale_interrupted", {
        userId: ownerId,
        genId: id,
        ageMs: age,
        hadRequestIds: requestIds.length,
      });
      await admin.from("ai_generations").update({ status: "failed" }).eq("id", id);
      await cleanupFace(id);
      return { id, kind: "interrupted", candidateUrls: [], createdAt };
    }

    if (r.status === "failed") {
      // 타임아웃 등으로 failed 마킹됐지만 fal 은 완성했을 수 있음 → 최근이면 되찾기.
      if (incomplete && age <= INCOMPLETE_RECLAIM_MS) {
        const rec = await recoverQueuedGeneration(
          admin,
          ownerId,
          id,
          requestIds,
          true
        );
        if (rec.status === "ready") {
          await cleanupFace(id);
          log.info("gen.reclaimed_failed", {
            userId: ownerId,
            genId: id,
            ageMs: age,
            recovered: rec.candidateUrls.length,
          });
          return { id, kind: "ready", candidateUrls: rec.candidateUrls, createdAt };
        }
      }
      return null; // 되찾기 실패/대상 아님 → 노출 안 함
    }

    // status === "done" (미선택 — picked 는 쿼리에서 제외)
    // 후보 일부 누락 + 최근이면 빠진 것 재확보.
    if (incomplete && age <= INCOMPLETE_RECLAIM_MS) {
      const rec = await recoverQueuedGeneration(
        admin,
        ownerId,
        id,
        requestIds,
        true
      );
      if (rec.status === "ready" && rec.candidateUrls.length > candidateUrls.length) {
        await cleanupFace(id);
        log.info("gen.reclaimed_partial", {
          userId: ownerId,
          genId: id,
          ageMs: age,
          before: candidateUrls.length,
          after: rec.candidateUrls.length,
        });
        return { id, kind: "ready", candidateUrls: rec.candidateUrls, createdAt };
      }
    }
    if (age <= CANDIDATE_TTL_MS && candidateUrls.length > 0) {
      return { id, kind: "ready", candidateUrls, createdAt };
    }
    // 만료 또는 후보 없음 — 정리
    log.info("gen.candidate_expired", {
      userId: ownerId,
      genId: id,
      ageMs: age,
      candidateCount: candidateUrls.length,
    });
    await cleanupCandidateStorage(admin, ownerId, id);
    await admin.from("ai_generations").update({ status: "failed" }).eq("id", id);
    await cleanupFace(id);
    return null;
  };

  // 행별 복구를 병렬로 — 직렬이면 worst ~25s, 병렬이면 가장 느린 1건(~5s). 순서 보존.
  const settled = await Promise.all(rows.map(handleRow));
  const pending = settled.filter((p): p is PendingGeneration => p !== null);

  if (pending.length > 0) {
    log.info("gen.recover_list", {
      userId: ownerId,
      pendingCount: pending.length,
      kinds: pending.map((p) => p.kind),
    });
  }
  return NextResponse.json({ pending });
}
