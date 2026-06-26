import Link from "next/link";
import { getLegalAdmin, kstToday } from "@/lib/legal";
import { DOC_TYPES, DOC_LABEL } from "@/lib/legal/types";
import { PaperPanel } from "@/components/dossier";

export const dynamic = "force-dynamic";

export default async function LegalIndexPage() {
  const today = kstToday();
  const docs = await Promise.all(
    DOC_TYPES.map(async (dt) => {
      const { draft, versions } = await getLegalAdmin(dt);
      const current = versions.find((v) => (v.effective_date ?? "") <= today) ?? null;
      const upcoming = versions.find((v) => (v.effective_date ?? "") > today) ?? null;
      return { dt, draft, current, upcoming };
    })
  );

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
          ← 콘텐츠
        </Link>
        <h1 className="mt-2 font-bold text-2xl sm:text-3xl">법무 문서</h1>
        <p className="mt-1 text-sm text-zinc-500">
          이용약관·개인정보처리방침을 버전·시행일로 관리합니다. 초안 저장 후 발행하면 공개 페이지(/terms·/privacy)에 반영되고, 미래 시행일은 예약 발행됩니다.
        </p>

        <PaperPanel className="mt-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {docs.map((d) => (
            <Link
              key={d.dt}
              href={`/admin/content/legal/${d.dt}`}
              className="min-w-0 rounded-lg border border-line p-4 transition hover:border-foreground/30 hover:bg-foreground/5"
            >
              <span className="font-semibold">{DOC_LABEL[d.dt]}</span>
              <p className="mt-1 text-xs text-zinc-500">
                {d.current
                  ? `현재 버전 ${d.current.version} · 시행일 ${d.current.effective_date}`
                  : "미발행"}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-400">
                {d.draft ? "편집 중 초안 있음" : "초안 없음"}
                {d.upcoming ? ` · 예약본 ${d.upcoming.effective_date} 시행 예정` : ""}
              </p>
            </Link>
          ))}
          </div>
        </PaperPanel>
      </div>
    </main>
  );
}
