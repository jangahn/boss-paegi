import Link from "next/link";
import { notFound } from "next/navigation";
import { isDomainKey, type DomainKey } from "@/lib/config/keys";
import { getConfigAudit } from "@/lib/config/audit";
import { diffConfig } from "@/lib/config/diff";
import { fmtKst } from "@/lib/admin-format";
import { Pagination } from "@/components/Pagination";

export const dynamic = "force-dynamic";

const KEY_LABEL: Record<DomainKey, string> = {
  marketing_copy: "마케팅 카피",
  role_content: "롤 콘텐츠",
  score_config: "점수 등급",
  badge_catalog: "뱃지 카탈로그",
  session_limits: "세션 한도",
  growth_levers: "성장 레버",
  site_content: "소개·FAQ (SEO)",
};

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ContentHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { key } = await params;
  if (!isDomainKey(key)) notFound();
  const sp = await searchParams;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);
  const { rows, total, pageSize } = await getConfigAudit(key, { page });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link
          href={`/admin/content/${key}`}
          className="text-xs text-zinc-500 hover:text-foreground"
        >
          ← {KEY_LABEL[key]} 편집
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{KEY_LABEL[key]} 변경 내역</h1>
        <p className="mt-1 text-sm text-zinc-500">
          발행 시각·수정자·바뀐 항목. 보기 전용. 총 {total.toLocaleString()}건.
        </p>

        {rows.length === 0 ? (
          <p className="mt-10 text-center text-sm text-zinc-400">
            아직 발행 내역이 없어요.
          </p>
        ) : (
          <ul className="mt-5 flex flex-col gap-3">
            {rows.map((r) => {
              const diff = r.oldValue == null ? [] : diffConfig(r.oldValue, r.newValue);
              return (
                <li
                  key={r.id}
                  className="rounded-2xl border border-foreground/10 bg-paper-2 p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {r.adminName ?? `관리자 ${r.adminId.slice(0, 8)}`}
                    </span>
                    <span className="text-xs text-zinc-400">{fmtKst(r.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    v{r.oldVersion ?? 0} → v{r.newVersion}
                    {r.note ? ` · ${r.note}` : ""}
                  </div>
                  {r.oldValue == null ? (
                    <p className="mt-2 text-xs font-medium text-emerald-600">최초 발행</p>
                  ) : diff.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {diff.map((d, i) => (
                        <li key={i} className="text-xs leading-relaxed">
                          <span className="font-mono text-zinc-500">{d.path}</span>{" "}
                          {d.complex ? (
                            <span className="font-medium text-amber-600">변경됨</span>
                          ) : (
                            <span>
                              <span className="text-zinc-400 line-through">{d.before}</span>
                              {" → "}
                              <span className="font-medium text-foreground">{d.after}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-zinc-400">표시 가능한 변경 없음</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-5">
          <Pagination
            page={page}
            totalPages={totalPages}
            hrefFor={(p) => `/admin/content/history/${key}?page=${p}`}
          />
        </div>
      </div>
    </main>
  );
}
