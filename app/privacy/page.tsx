import type { Metadata } from "next";
import { LegalPublicPage } from "@/components/legal/LegalPublicPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "개인정보처리방침" };

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  return <LegalPublicPage docType="privacy" viewId={v} />;
}
