import type { Metadata } from "next";
import { JsonLd } from "@/components/JsonLd";
import { getSiteContent } from "@/lib/config/getters";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const sc = await getSiteContent();
  return {
    title: "소개·자주 묻는 질문",
    description: sc.metaDescription,
    alternates: { canonical: "/faq" },
    openGraph: {
      title: `${SERVICE_NAME} 소개·자주 묻는 질문`,
      description: sc.definition,
      url: `${SITE_URL}/faq`,
      type: "website",
    },
  };
}

export default async function FaqPage() {
  const sc = await getSiteContent();
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    inLanguage: "ko-KR",
    mainEntity: sc.faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <JsonLd data={faqLd} />
      <main className="flex flex-1 flex-col ui-surface px-5 py-10">
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight">{SERVICE_NAME} 소개</h1>
          <p className="mt-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{sc.intro}</p>

          <h2 className="mt-12 text-2xl font-bold">자주 묻는 질문</h2>
          <div className="mt-4 flex flex-col divide-y divide-foreground/10">
            {sc.faq.map((f, i) => (
              <section key={i} className="py-5">
                <h3 className="text-base font-semibold">{f.q}</h3>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {f.a}
                </p>
              </section>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
