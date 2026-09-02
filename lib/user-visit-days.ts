import "server-only";

// 운영 대시보드 '유저 퍼널·구성'(v1.17)의 방문일 기록 — /api/track 방문 적재가 서버 세션 uid 로
// user_visit_days(uid, KST 오늘) 1행/일을 남긴다(0117). analytics_*(무식별 집계) 도메인 밖의 별도 테이블이며
// day_kst 는 DB default(KST 오늘)라 앱/DB 시계 차이가 없다. best-effort: 실패는 log 만(수집이 이용을 막지 않는다).

import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

export async function recordUserVisitDay(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("user_visit_days")
      .upsert({ user_id: userId }, { onConflict: "user_id,day_kst", ignoreDuplicates: true });
    if (error) log.warn("user_visit_days.insert_error", { message: error.message });
  } catch (e) {
    log.warn("user_visit_days.insert_error", errInfo(e));
  }
}
