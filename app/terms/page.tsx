import type { Metadata } from "next";
import { LegalPublicPage } from "@/components/legal/LegalPublicPage";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";
import { resolveOgImages } from "@/lib/site-assets";

export const dynamic = "force-dynamic";
// openGraph 는 layout 과 deep-merge 되지 않아 images 를 항상 명시(누락 시 기본 OG 이미지 소실).
export async function generateMetadata(): Promise<Metadata> {
  const ogImages = await resolveOgImages();
  return {
    title: "이용약관",
    alternates: { canonical: "/terms" },
    openGraph: {
      title: `이용약관 · ${SERVICE_NAME}`,
      url: `${SITE_URL}/terms`,
      type: "website",
      images: ogImages,
    },
  };
}

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  return <LegalPublicPage docType="terms" viewId={v} />;
}
