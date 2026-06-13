import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CANDIDATE_TTL_MS,
  QUEUED_STALE_MS,
  QUEUED_RECOVER_AFTER_MS,
  cleanupCandidateStorage,
  type PendingGeneration,
} from "@/lib/generation";
import { recoverQueuedGeneration } from "@/lib/generation-recovery";
import { log } from "@/lib/log";

export const runtime = "nodejs";
// 복구가 fal queue.status/result + 후보 복사를 할 수 있어 여유 둠.
export const maxDuration = 30;

/**
 * 미완결 캐릭터 생성 목록 + lazy 정리/복구.
 *  - generating: queued, 아직 진행 중 (60s 이내 = 라이브 함수 / 또는 fal 처리 중)
 *  - ready: done 미선택(24h 이내) 또는 복구로 살아난 생성 → 고르기 대기
 *  - interrupted: queued 30분 초과 또는 복구 실패 → failed 마킹 후 1회 노출
 *  - 24h 초과 미선택 done: 후보 정리 + failed 마킹 (목록 제외)
 *
 * 핵심: queued 가 60s 넘게 살아있으면 동기 생성 함수가 죽은(또는 끝난) 것 →
 * row 에 저장된 fal_request_id 로 fal 에 결과를 다시 물어 복구한다.
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
      .in("status", ["queued", "done"])
      .order("created_at", { ascending: false })
      .limit(20);

  // migration 0006(fal_request_ids) 미적용 환경이면 컬럼 없이 재조회 (복구만 비활성)
  let rows: Record<string, unknown>[] | null;
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
  const pending: PendingGeneration[] = [];

  for (const r of rows) {
    const id = r.id as string;
    const createdAt = r.created_at as string;
    const age = now - new Date(createdAt).getTime();
    const candidateUrls = Array.isArray(r.candidate_urls)
      ? (r.candidate_urls as string[])
      : [];

    if (r.status === "queued") {
      const requestIds = Array.isArray(r.fal_request_ids)
        ? (r.fal_request_ids as string[])
        : [];

      // 60s 이내 — 라이브 생성 함수가 처리 중. 복구가 끼어들지 않게 그냥 생성중.
      if (age <= QUEUED_RECOVER_AFTER_MS) {
        pending.push({ id, kind: "generating", candidateUrls: [], createdAt });
        continue;
      }

      // 60s 초과 = 함수가 죽었거나 끝났을 시점 — 저장된 request_id 로 복구 시도.
      if (requestIds.length > 0) {
        // 30분 넘으면 마감 — 진행 중이라도 완료분만으로 확정(받은 만큼은 살림).
        const forceFinalize = age > QUEUED_STALE_MS;
        const rec = await recoverQueuedGeneration(
          admin,
          user.id,
          id,
          requestIds,
          forceFinalize
        );
        if (rec.status === "ready") {
          log.info("gen.recovered_ready", { userId: user.id, genId: id, ageMs: age });
          pending.push({
            id,
            kind: "ready",
            candidateUrls: rec.candidateUrls,
            createdAt,
          });
          continue;
        }
        if (rec.status === "pending") {
          // fal 이 아직 처리 중(마감 전) — 더 기다린다. 갤러리 폴링이 재시도.
          pending.push({ id, kind: "generating", candidateUrls: [], createdAt });
          continue;
        }
        // rec.failed → 아래에서 interrupted 처리
      } else if (age <= QUEUED_STALE_MS) {
        // request_id 없음(구버전 row) — 시간 기반으로 30분까진 생성중
        pending.push({ id, kind: "generating", candidateUrls: [], createdAt });
        continue;
      }

      // 끊김 확정 — failed 마킹 후 "다시 만들기" 로 1회 노출
      log.warn("gen.stale_interrupted", {
        userId: user.id,
        genId: id,
        ageMs: age,
        hadRequestIds: requestIds.length,
      });
      await admin
        .from("ai_generations")
        .update({ status: "failed" })
        .eq("id", id);
      pending.push({ id, kind: "interrupted", candidateUrls: [], createdAt });
      continue;
    }

    // status === "done" (미선택 — picked 는 쿼리에서 제외됨)
    if (age <= CANDIDATE_TTL_MS && candidateUrls.length > 0) {
      pending.push({ id, kind: "ready", candidateUrls, createdAt });
    } else {
      // 만료 또는 후보 없음 — 정리
      log.info("gen.candidate_expired", {
        userId: user.id,
        genId: id,
        ageMs: age,
        candidateCount: candidateUrls.length,
      });
      await cleanupCandidateStorage(admin, user.id, id);
      await admin
        .from("ai_generations")
        .update({ status: "failed" })
        .eq("id", id);
    }
  }

  if (pending.length > 0) {
    log.info("gen.recover_list", {
      userId: user.id,
      pendingCount: pending.length,
      kinds: pending.map((p) => p.kind),
    });
  }
  return NextResponse.json({ pending });
}
