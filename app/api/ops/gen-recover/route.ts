import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { recoverQueuedGeneration, failGeneration } from "@/lib/generation-recovery";
import { QUEUED_STALE_MS } from "@/lib/generation";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
// 여러 행 회수(각 fal status/result + 후보 복사) — 여유 둠. SWEEP_LIMIT 로 행 수 상한.
export const maxDuration = 60;

// 한 실행당 회수 시도 상한(fal 호출량·시간 보호). 더 있으면 다음 주기에.
const SWEEP_LIMIT = 20;
// fal result 만료(보통 단시간) 전에 회수해야 의미. 너무 오래된 건 어차피 만료라 스캔 제외.
const RECOVER_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * 캐릭터 생성 **서버측 회수 스윕** — cron-job.org 가 x-cron-secret 헤더로 수분 주기 호출(머신).
 *
 * 비동기 생성은 클라 폴링(`/api/generations`)이 fal 결과를 회수하는데, **탭 닫힘·앱 백그라운드로
 * 폴링이 멈추면** fal 은 완료돼도 우리가 못 채워 좀비가 된다(+ result 만료 시 영구 손실). 이 cron 이
 * 클라와 무관하게 미완(candidate < 요청수) 행을 fal 에 다시 물어 회수: 완료분 candidate 복사 + done,
 * 결정적 실패(no-face 등)면 `failGeneration`(환불). 모두 멱등(폴링과 동일 로직 재사용).
 *
 * force = age > 30분: 30분 넘은 건 스트래글러 포기하고 받은 만큼 확정. 그 전엔 비-force(아직 도는
 * 요청은 pending 유지 — 조기 확정/환불 방지, 클라 폴링이 곧 따라잡거나 다음 스윕이 처리).
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "disabled" }, { status: 503 });
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const opsId = SERVER_ENV.OPS_USER_ID;
  const cutoff = new Date(Date.now() - RECOVER_WINDOW_MS).toISOString();

  const { data, error } = await admin
    .from("ai_generations")
    .select("id, owner_id, status, candidate_urls, fal_request_ids, created_at")
    .in("status", ["queued", "done"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    log.error("gen.sweep_query_fail", errInfo(error));
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  type Row = {
    id: string;
    owner_id: string;
    status: string;
    candidate_urls: unknown;
    fal_request_ids: unknown;
    created_at: string;
  };
  // 미완 = fal 요청 수 > 저장된 candidate 수. (fal_request_ids 없는 구버전 행은 회수 불가 → 제외.)
  const targets = ((data as Row[] | null) ?? [])
    .filter((r) => {
      const reqs = Array.isArray(r.fal_request_ids) ? r.fal_request_ids.length : 0;
      const cands = Array.isArray(r.candidate_urls) ? r.candidate_urls.length : 0;
      return reqs > 0 && cands < reqs;
    })
    .slice(0, SWEEP_LIMIT);

  let recovered = 0;
  let failed = 0;
  let pending = 0;
  for (const r of targets) {
    try {
      const age = Date.now() - new Date(r.created_at).getTime();
      const rec = await recoverQueuedGeneration(
        admin,
        r.owner_id,
        r.id,
        r.fal_request_ids as string[],
        age > QUEUED_STALE_MS
      );
      if (rec.status === "ready") {
        recovered++;
      } else if (rec.status === "failed" && rec.definitive) {
        await failGeneration(admin, r.id, r.owner_id, r.owner_id === opsId);
        failed++;
      } else {
        pending++;
      }
    } catch (e) {
      log.warn("gen.sweep_row_fail", { genId: r.id, ...errInfo(e) });
    }
  }

  log.info("gen.sweep_done", {
    scanned: (data as Row[] | null)?.length ?? 0,
    targeted: targets.length,
    recovered,
    failed,
    pending,
  });
  return NextResponse.json({
    ok: true,
    scanned: (data as Row[] | null)?.length ?? 0,
    targeted: targets.length,
    recovered,
    failed,
    pending,
  });
}
