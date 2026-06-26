import Link from "next/link";
import { notFound } from "next/navigation";
import { getLegalAdmin } from "@/lib/legal";
import { isDocType, DOC_LABEL, DOC_PATH } from "@/lib/legal/types";
import { LegalDocEditor } from "@/components/admin/content/LegalDocEditor";

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
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content/legal" className="text-xs text-zinc-500 hover:text-foreground">
            ← 법무 문서
          </Link>
          <Link href={DOC_PATH[docType]} target="_blank" className="text-xs text-zinc-500 hover:text-foreground">
            공개 페이지 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">{label}</h1>
        <LegalDocEditor
          key={`${draft?.id ?? "no-draft"}:${versions.map((v) => v.id).join(",")}`}
          docType={docType}
          label={label}
          draft={draft}
          versions={versions}
        />
      </div>
    </main>
  );
}
