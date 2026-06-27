import { redirect } from "next/navigation";
import { safeNext } from "@/lib/oauth-metadata";

/**
 * Deprecated — 가입 동의는 통합 화면 `/consent` 로 일원화됨. 기존 링크·브라우저 history·stale OAuth next
 * 대비 redirect stub(즉시 404 금지). safeNext 로 정화한 next 를 그대로 전달.
 */
export default async function SignupRedirect({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  redirect(`/consent?next=${encodeURIComponent(safeNext(next))}`);
}
