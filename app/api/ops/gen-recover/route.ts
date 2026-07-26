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
        await failGeneration(admin, r.id, r.owner_id, r.owner_id === opsId, rec.reason);
        failed++;
      } else {
        pending++;
      }
    } catch (e) {
      log.warn("gen.sweep_row_fail", { genId: r.id, ...errInfo(e) });
    }
  }

  // ── 좀비 백스톱: 30분 넘게 queued 로 고착된 행을 failed+환불로 강제 종결. 회수 불가 케이스 —
  //    (A) fal 이 IN_QUEUE 로 무한 정체(완료 0)라 recovery 가 pending 만 반환 / (B) submit~request_id
  //    영속 사이 하드크래시로 request_id 없어 recovery 대상서 제외. 클라의 age>30분 fall-through 를
  //    cron 에도 둬 **브라우저 종료 사용자도 크레딧을 잃지 않게** 한다. 정상 행은 수분 내 done/failed 로
  //    빠지므로 30분+ queued = 종결불가로 판단(2h RECOVER_WINDOW 밖도 포함해 상한 없이 스캔).
  //    failGeneration(RPC-first, 멱등)이 queued→failed+환불(비-ops)·no_consume(ops)을 원자 처리.
  let stuckFailed = 0;
  const staleCutoff = new Date(Date.now() - QUEUED_STALE_MS).toISOString();
  const { data: stuck, error: stErr } = await admin
    .from("ai_generations")
    .select("id, owner_id")
    .eq("status", "queued")
    .lt("created_at", staleCutoff)
    .order("created_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (stErr) {
    log.warn("gen.stuck_sweep_query_fail", errInfo(stErr));
  } else {
    for (const g of (stuck as { id: string; owner_id: string }[] | null) ?? []) {
      try {
        await failGeneration(admin, g.id, g.owner_id, g.owner_id === opsId, "timeout");
        stuckFailed++;
      } catch (e) {
        log.warn("gen.stuck_sweep_item_fail", { genId: g.id, ...errInfo(e) });
      }
    }
  }

  // ── 안전망: 미환급 실패 생성 재환급(§19) — status='failed'·refunded_at=NULL·credit_lot_id set 로
  //    고착된 소비 크레딧(failGeneration 의 done-fallback flip↔환급 RPC 사이 크래시 윈도우 잔여)을
  //    멱등 RPC 로 회수. idx_ai_generations_refund_pending 사용. ops(credit_lot_id NULL)는 predicate 로 제외.
  let reRefunded = 0;
  const { data: pendingRefunds, error: prErr } = await admin
    .from("ai_generations")
    .select("id, fail_reason")
    .eq("status", "failed")
    .is("refunded_at", null)
    .not("credit_lot_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (prErr) {
    log.warn("gen.refund_sweep_query_fail", errInfo(prErr));
  } else {
    for (const g of (pendingRefunds as { id: string; fail_reason: string | null }[] | null) ?? []) {
      try {
        const { error: rErr } = await admin.rpc("mark_generation_failed_and_refund", {
          p_gen_id: g.id,
          p_fail_reason: g.fail_reason ?? "recover_sweep",
        });
        if (rErr) log.warn("gen.refund_sweep_item_fail", { genId: g.id, ...errInfo(rErr) });
        else reRefunded++;
      } catch (e) {
        log.warn("gen.refund_sweep_item_fail", { genId: g.id, ...errInfo(e) });
      }
    }
  }

  log.info("gen.sweep_done", {
    scanned: (data as Row[] | null)?.length ?? 0,
    targeted: targets.length,
    recovered,
    failed,
    pending,
    stuckFailed,
    reRefunded,
  });
  return NextResponse.json({
    ok: true,
    scanned: (data as Row[] | null)?.length ?? 0,
    targeted: targets.length,
    recovered,
    failed,
    pending,
    stuckFailed,
    reRefunded,
  });
}
