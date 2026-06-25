import "server-only";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * takedown/restore/permanent 후 이 doll 이 박힌 모든 표면의 ISR 캐시를 무효화(즉시 반영).
 *   - doll 단독 페이지 + OG
 *   - 이 doll 을 쓰는 모든 score 의 share 페이지 + OG + history 상세
 * 페이지들은 revalidate=60 backstop 도 있으나(≤60s), 여기서 명시 무효화로 즉시 반영.
 * 외부(카카오 등) OG 캐시는 우리 권한 밖 — 별도 잔존(README 운영절차 참고).
 */
export async function revalidateDollSurfaces(
  admin: SupabaseClient,
  dollId: string
): Promise<void> {
  revalidatePath(`/doll/${dollId}`);
  revalidatePath(`/doll/${dollId}/opengraph-image`);
  const { data } = await admin
    .from("scores")
    .select("id, owner_id")
    .eq("doll_id", dollId)
    .limit(200);
  for (const s of (data ?? []) as { id: string; owner_id: string }[]) {
    revalidatePath(`/share/${s.id}`);
    revalidatePath(`/share/${s.id}/opengraph-image`);
    revalidatePath(`/history/${s.owner_id}/${s.id}`);
  }
}
