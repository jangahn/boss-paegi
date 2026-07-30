import "server-only";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseRowsPaginated } from "@/lib/supabase-operation";

/**
 * takedown/restore/permanent 후 이 doll 이 박힌 모든 표면의 ISR 캐시를 무효화(즉시 반영).
 *   - doll 단독 페이지 + OG
 *   - 이 doll 을 쓰는 모든 score 의 share 페이지 + OG + history 상세
 * HTML은 force-dynamic이고 OG 이미지는 1시간 캐시이므로, 여기서 명시
 * 무효화해 양쪽 표면을 즉시 수렴시킨다.
 * 외부(카카오 등) OG 캐시는 우리 권한 밖 — 별도 잔존(README 운영절차 참고).
 */
export async function revalidateDollSurfaces(
  admin: SupabaseClient,
  dollId: string
): Promise<void> {
  revalidatePath(`/doll/${dollId}`);
  revalidatePath(`/doll/${dollId}/opengraph-image`);
  const scores = await readSupabaseRowsPaginated<{
    id: string;
    owner_id: string;
  }>(
    "moderation.revalidate_score_surfaces",
    (offset, limit) =>
      admin
        .from("scores")
        .select("id, owner_id")
        .eq("doll_id", dollId)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1),
    500,
  );
  for (const s of scores) {
    revalidatePath(`/share/${s.id}`);
    revalidatePath(`/share/${s.id}/opengraph-image`);
    revalidatePath(`/history/${s.owner_id}/${s.id}`);
  }
}
