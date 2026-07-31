import "server-only";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import {
  CANDIDATE_TTL_MS,
  QUEUED_STALE_MS,
  SUBMIT_ACK_STALE_MS,
  INCOMPLETE_RECLAIM_MS,
  cleanupCandidateStorage,
  type PendingGeneration,
} from "@/lib/generation";
import { recoverQueuedGeneration, failGeneration } from "@/lib/generation-recovery";
import {
  candidateRequests,
  hasIncompleteCandidates,
  hasUnresolvedSubmitAcknowledgement,
} from "@/lib/character-gen/generation-state";
import { deleteFaceTmp, tmpFacePath } from "@/lib/character-gen/upload-face";
import { terminateDeletedOwnerGeneration } from "@/lib/character-gen/deleted-owner-generation";
import { completeGenerationArtifactCleanup } from "@/lib/character-gen/generation-artifact-cleanup";
import { signedDollUrl } from "@/lib/storage";
import { log, errInfo } from "@/lib/log";
import { validateAdminRows } from "@/lib/admin-read-contract";

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
  // 회원 전용 + 동의 완료 게이트(lazy 모델). 익명/무세션/미동의 → 401/403.
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const admin = createAdminClient();
  const baseQuery = (cols: string) =>
    admin
      .from("ai_generations")
      .select(cols)
      .eq("owner_id", user.id)
      .eq("cost_preflight_pending", false)
      // failed/expired/picked는 terminal이라 복구가 되살리면 안 된다.
      .in("status", ["queued", "done"])
      .order("created_at", { ascending: false })
      .limit(20);

  // migration 0006(fal_request_ids) 미적용 환경이면 컬럼 없이 재조회 (복구만 비활성)
  let rawRows: unknown;
  const sel = await baseQuery(
    "id, status, candidate_urls, created_at, role, fal_request_ids, gen_params, refunded_at, version"
  );
  if (sel.error && sel.error.message.includes("fal_request_ids")) {
    const fb = await baseQuery(
      "id, status, candidate_urls, created_at, role, refunded_at, version"
    );
    if (fb.error) {
      log.error("gen.pending_list_fail", {
        userId: user.id,
        ...errInfo(fb.error),
      });
      return NextResponse.json(
        { error: "generations_unavailable" },
        { status: 503 },
      );
    }
    rawRows = fb.data;
  } else {
    if (sel.error) {
      log.error("gen.pending_list_fail", {
        userId: user.id,
        ...errInfo(sel.error),
      });
      return NextResponse.json(
        { error: "generations_unavailable" },
        { status: 503 },
      );
    }
    rawRows = sel.data;
  }
  let rows: Record<string, unknown>[];
  try {
    rows = validateAdminRows<Record<string, unknown>>(
      "generations.pending_list",
      rawRows,
      {
        id: "uuid",
        status: "string",
        candidate_urls: "array",
        created_at: "timestamp",
        role: "string",
        refunded_at: "nullableTimestamp",
        version: "nonnegativeInteger",
      },
    );
    for (const row of rows) {
      if (
        !["queued", "done"].includes(row.status as string) ||
        !(row.candidate_urls as unknown[]).every(
          (path) => typeof path === "string" && path.length > 0,
        )
      ) {
        throw new Error("invalid_pending_generation_row");
      }
    }
  } catch (error) {
    log.error("gen.pending_list_invalid", {
      userId: user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: "generations_unavailable" },
      { status: 503 },
    );
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
    const requestSlots = r.fal_request_ids;
    const requests = candidateRequests(requestSlots, r.gen_params);
    const awaitingSubmitAck = hasUnresolvedSubmitAcknowledgement(r.gen_params);
    const queuedDeadline = awaitingSubmitAck
      ? SUBMIT_ACK_STALE_MS
      : QUEUED_STALE_MS;
    // 저장 후보가 fal 요청 수보다 적음 = 일부/전부 누락 → 되찾을 여지
    const incomplete = hasIncompleteCandidates(
      candidateUrls,
      requestSlots,
      r.gen_params
    );

    if (r.status === "queued") {
      if (requests.length > 0) {
        // 30분 넘으면 마감 — 완료분만으로 확정(받은 만큼 살림). 그 전엔 계속 대기.
        const rec = await recoverQueuedGeneration(
          admin,
          ownerId,
          id,
          requestSlots,
          !awaitingSubmitAck && age > QUEUED_STALE_MS
        );
        if (rec.status === "ready") {
          await cleanupFace(id);
          log.info("gen.recovered_ready", { userId: ownerId, genId: id, ageMs: age });
          return { id, kind: "ready", candidateUrls: rec.candidateUrls, createdAt };
        }
        if (rec.status === "owner_deleted") {
          await terminateDeletedOwnerGeneration(admin, {
            genId: id,
            ownerId,
          });
          return null;
        }
        if (rec.status === "terminal") return null;
        // 결정적 실패(fal 전부 멈춤인데 결과 0 = facexlib no-face 등) → 30분 대기 없이 즉시 실패+환불+안내.
        if (rec.status === "failed" && rec.definitive) {
          const failed = await failGeneration(
            admin,
            id,
            ownerId,
            rec.reason,
            r.version as number,
          );
          if (!failed) return null;
          await cleanupFace(id);
          log.info("gen.definitive_failed", { userId: ownerId, genId: id, ageMs: age });
          return { id, kind: "interrupted", reason: "photo", candidateUrls: [], createdAt };
        }
        // pending, 또는 transient(copy 실패 등) → 마감(30분)까지 생성중 유지(조기 실패 방지)
        if (age <= queuedDeadline) {
          return { id, kind: "generating", candidateUrls: [], createdAt };
        }
        // acknowledgement는 fal webhook 재전송 창까지, 일반 복구는 30분까지 대기.
      } else if (age <= queuedDeadline) {
        // request_id 없음: claimed/uncertain이면 signed webhook 창, 레거시는 30분.
        return { id, kind: "generating", candidateUrls: [], createdAt };
      }

      // 끊김 확정 — failed 마킹 + "다시 만들기" 1회 노출, 임시 얼굴 정리
      log.warn("gen.stale_interrupted", {
        userId: ownerId,
        genId: id,
        ageMs: age,
        hadRequestIds: requests.length,
        awaitedSubmitAck: awaitingSubmitAck,
      });
      const failed = await failGeneration(
        admin,
        id,
        ownerId,
        "timeout",
        r.version as number,
      );
      if (!failed) return null;
      await cleanupFace(id);
      return { id, kind: "interrupted", candidateUrls: [], createdAt };
    }

    // status === "done" (미선택 — terminal 상태는 쿼리에서 제외)
    // 후보 일부 누락 + 최근이면 빠진 것 재확보.
    if (incomplete && age <= INCOMPLETE_RECLAIM_MS) {
      const rec = await recoverQueuedGeneration(
        admin,
        ownerId,
        id,
        requestSlots,
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
      if (rec.status === "owner_deleted") {
        await terminateDeletedOwnerGeneration(admin, {
          genId: id,
          ownerId,
        });
        return null;
      }
    }
    if (age <= CANDIDATE_TTL_MS && candidateUrls.length > 0) {
      return { id, kind: "ready", candidateUrls, createdAt };
    }
    // 만료 또는 후보 없음 — done→expired 전이를 DB row-lock RPC로 먼저 확정한다.
    // pick과 경합해 pick이 이기면 후보를 절대 지우지 않는다. 만료는 생성 성공 뒤
    // 사용자가 선택하지 않은 결과라 제품 정책상 크레딧을 환급하지 않는다.
    log.info("gen.candidate_expired", {
      userId: ownerId,
      genId: id,
      ageMs: age,
      candidateCount: candidateUrls.length,
    });
    const { data: expiryData, error: expiryError } = await admin.rpc(
      "expire_generation",
      {
        p_gen_id: id,
        p_expected_version:
          typeof r.version === "number" ? r.version : null,
      }
    );
    if (expiryError) {
      log.warn("gen.expire_transition_fail", {
        userId: ownerId,
        genId: id,
        ...errInfo(expiryError),
      });
      return null;
    }
    const expiryOutcome = (
      expiryData as { outcome?: string } | null
    )?.outcome;
    if (expiryOutcome !== "expired" && expiryOutcome !== "already_expired") {
      log.info("gen.expire_conflict", {
        userId: ownerId,
        genId: id,
        outcome: expiryOutcome ?? "unknown",
      });
      return null;
    }
    const cleanup = await completeGenerationArtifactCleanup({
      beginCleanup: () =>
        admin.rpc("begin_generation_artifact_cleanup", {
          p_gen_id: id,
          p_expected_status: "expired",
        }),
      cleanupCandidates: () =>
        cleanupCandidateStorage(admin, ownerId, id),
      cleanupFace: () => deleteFaceTmp(tmpFacePath(ownerId, id)),
      markComplete: () =>
        admin.rpc("complete_generation_artifact_cleanup", {
          p_gen_id: id,
          p_expected_status: "expired",
        }),
    });
    if (!cleanup.ok) {
      // expired + candidate_urls 유지가 cron의 durable retry manifest다.
      log.warn("gen.expire_cleanup_deferred", {
        userId: ownerId,
        genId: id,
        stage: cleanup.stage,
        outcome: cleanup.outcome,
        ...errInfo(cleanup.error),
      });
    }
    return null;
  };

  // 행별 복구를 병렬로 — 직렬이면 worst ~25s, 병렬이면 가장 느린 1건(~5s). 순서 보존.
  // handleRow 는 role 을 안 채우므로, 순서 보존되는 rows[i] 에서 role 을 덧붙인다(resume 복구용).
  const settled = await Promise.all(rows.map(handleRow));
  const pending = settled
    .map((p, i): (PendingGeneration & { role?: string }) | null =>
      p ? { ...p, role: (rows[i].role as string | undefined) ?? undefined } : null
    )
    .filter((p): p is PendingGeneration & { role?: string } => p !== null);

  if (pending.length > 0) {
    log.info("gen.recover_list", {
      userId: ownerId,
      pendingCount: pending.length,
      kinds: pending.map((p) => p.kind),
    });
  }

  // private 버킷 — 후보 URL을 signed URL로(우리버킷 path/URL만; fal 폴백 URL은 통과).
  //   ready 후 폴링이 멈춰 클라가 든 URL이 동결되므로, 픽 데드라인 여유 위해 TTL 길게(6h).
  //   후보는 takedown 대상(공개 표면) 아님 → 긴 TTL 무해. copied:false fal URL은 자체 만료까지 유효.
  const signedPending = await Promise.all(
    pending.map(async (p) => ({
      ...p,
      candidateUrls: await Promise.all(
        p.candidateUrls.map(async (u) =>
          u.includes("/dolls/") || !u.includes("://")
            ? await signedDollUrl(u, 21600)
            : u
        )
      ),
    }))
  );
  return NextResponse.json({ pending: signedPending });
}
