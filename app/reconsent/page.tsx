import { redirect } from "next/navigation";
import { safeNext } from "@/lib/oauth-metadata";

/**
 * Deprecated — 재동의는 통합 화면 `/consent` 로 일원화됨(버전 기반 재동의로 일반화). redirect stub.
 */
export default async function ReconsentRedirect({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  redirect(`/consent?next=${encodeURIComponent(safeNext(next))}`);
}
