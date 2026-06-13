import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CANDIDATE_TTL_MS,
  QUEUED_STALE_MS,
  cleanupCandidateStorage,
  type PendingGeneration,
} from "@/lib/generation";

export const runtime = "nodejs";

/**
 * 미완결 캐릭터 생성 목록 + lazy 정리.
 *  - generating: queued, 5분 이내 (생성 중)
 *  - ready: done 미선택, 24시간 이내 (고르기 대기)
 *  - interrupted: queued 5분 초과 (생성 중 끊김 → failed 로 마킹하고 1회 노출)
 *  - 24h 초과 미선택 done: 후보 정리 + failed 마킹 (목록 제외)
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
  const { data: rows } = await admin
    .from("ai_generations")
    .select("id, status, candidate_urls, created_at")
    .eq("owner_id", user.id)
    .in("status", ["queued", "done"])
    .order("created_at", { ascending: false })
    .limit(20);

  const now = Date.now();
  const pending: PendingGeneration[] = [];

  for (const r of rows ?? []) {
    const age = now - new Date(r.created_at as string).getTime();
    const candidateUrls = Array.isArray(r.candidate_urls)
      ? (r.candidate_urls as string[])
      : [];

    if (r.status === "queued") {
      if (age <= QUEUED_STALE_MS) {
        pending.push({
          id: r.id as string,
          kind: "generating",
          candidateUrls: [],
          createdAt: r.created_at as string,
        });
      } else {
        // 생성 중 끊김 — failed 마킹 후 "다시 만들기" 로 1회 노출
        await admin
          .from("ai_generations")
          .update({ status: "failed" })
          .eq("id", r.id);
        pending.push({
          id: r.id as string,
          kind: "interrupted",
          candidateUrls: [],
          createdAt: r.created_at as string,
        });
      }
      continue;
    }

    // status === "done" (미선택 — picked 는 쿼리에서 제외됨)
    if (age <= CANDIDATE_TTL_MS && candidateUrls.length > 0) {
      pending.push({
        id: r.id as string,
        kind: "ready",
        candidateUrls,
        createdAt: r.created_at as string,
      });
    } else {
      // 만료 또는 후보 없음 — 정리
      await cleanupCandidateStorage(admin, user.id, r.id as string);
      await admin
        .from("ai_generations")
        .update({ status: "failed" })
        .eq("id", r.id);
    }
  }

  return NextResponse.json({ pending });
}
