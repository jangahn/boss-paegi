import Link from "next/link";
import { notFound } from "next/navigation";
import { getLegalAdmin } from "@/lib/legal";
import { isDocType, DOC_LABEL, DOC_PATH } from "@/lib/legal/types";
import { LegalDocEditor } from "@/components/admin/content/LegalDocEditor";
import { PaperPanel } from "@/components/dossier";

export const dynamic = "force-dynamic";

export default async function LegalEditPage({
  params,
}: {
  params: Promise<{ docType: string }>;
}) {
  const { docType } = await params;
  if (!isDocType(docType)) notFound();
  const { draft, versions } = await getLegalAdmin(docType);
  const label = DOC_LABEL[docType];

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Link href="/admin/content/legal" className="whitespace-nowrap text-xs text-steel hover:text-ink">
            ← 법무 문서
          </Link>
          <Link href={DOC_PATH[docType]} target="_blank" className="whitespace-nowrap text-xs text-steel hover:text-ink">
            공개 페이지 →
          </Link>
        </div>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink sm:text-3xl">{label}</h1>
        <PaperPanel className="mt-4 overflow-x-auto">
          <LegalDocEditor
            key={`${draft?.id ?? "no-draft"}:${versions.map((v) => v.id).join(",")}`}
            docType={docType}
            label={label}
            draft={draft}
            versions={versions}
          />
        </PaperPanel>
      </div>
    </main>
  );
}
