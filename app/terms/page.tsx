import type { Metadata } from "next";
import { LegalPublicPage } from "@/components/legal/LegalPublicPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "이용약관" };

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  return <LegalPublicPage docType="terms" viewId={v} />;
}
